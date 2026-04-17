/**
 * OpenRouterAgent: OpenRouter-based observation extraction
 *
 * Alternative to SDKAgent that uses OpenRouter's unified API
 * for accessing 100+ models from different providers.
 *
 * Responsibility:
 * - Call OpenRouter REST API for observation extraction
 * - Parse XML responses (same format as Claude/Gemini)
 * - Sync to database and Chroma
 * - Support dynamic model selection across providers
 */

import { buildContinuationPrompt, buildInitPrompt, buildObservationPrompt, buildSummaryPrompt } from '../../sdk/prompts.js';
import { getCredential } from '../../shared/EnvManager.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';
import { logger } from '../../utils/logger.js';
import { ModeManager } from '../domain/ModeManager.js';
import type { ActiveSession, ConversationMessage } from '../worker-types.js';
import { DatabaseManager } from './DatabaseManager.js';
import { SessionManager } from './SessionManager.js';
import {
  isAbortError,
  processAgentResponse,
  shouldFallbackToClaude,
  type FallbackAgent,
  type WorkerRef
} from './agents/index.js';

// Default OpenRouter API endpoint
const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';

// Context window management constants (defaults, overridable via settings)
const DEFAULT_MAX_CONTEXT_MESSAGES = 20;  // Maximum messages to keep in conversation history
const DEFAULT_MAX_ESTIMATED_TOKENS = 100000;  // ~100k tokens max context (safety limit)
const CHARS_PER_TOKEN_ESTIMATE = 4;  // Conservative estimate: 1 token = 4 chars

// OpenAI-compatible message format
interface OpenAIMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

interface OpenRouterResponse {
  output_text?: string | Array<{ text?: string; content?: string }>;
  choices?: Array<{
    message?: {
      role?: string;
      content?: string | Array<{ text?: string; content?: string }>;
    };
    delta?: {
      content?: string | Array<{ text?: string; content?: string }>;
    };
    text?: string;
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  error?: {
    message?: string;
    code?: string;
  };
}

export class OpenRouterAgent {
  private dbManager: DatabaseManager;
  private sessionManager: SessionManager;
  private fallbackAgent: FallbackAgent | null = null;

  constructor(dbManager: DatabaseManager, sessionManager: SessionManager) {
    this.dbManager = dbManager;
    this.sessionManager = sessionManager;
  }

  /**
   * Set the fallback agent (Claude SDK) for when OpenRouter API fails
   * Must be set after construction to avoid circular dependency
   */
  setFallbackAgent(agent: FallbackAgent): void {
    this.fallbackAgent = agent;
  }

  /**
   * Start OpenRouter agent for a session
   * Uses multi-turn conversation to maintain context across messages
   */
  async startSession(session: ActiveSession, worker?: WorkerRef): Promise<void> {
    try {
      // Get OpenRouter configuration
      const { apiKey, model, siteUrl, appName } = this.getOpenRouterConfig();

      if (!apiKey) {
        throw new Error('OpenRouter API key not configured. Set CLAUDE_MEM_OPENROUTER_API_KEY in settings or OPENROUTER_API_KEY environment variable.');
      }

      // Generate synthetic memorySessionId (OpenRouter is stateless, doesn't return session IDs)
      if (!session.memorySessionId) {
        const syntheticMemorySessionId = `openrouter-${session.contentSessionId}-${Date.now()}`;
        session.memorySessionId = syntheticMemorySessionId;
        this.dbManager.getSessionStore().updateMemorySessionId(session.sessionDbId, syntheticMemorySessionId);
        logger.info('SESSION', `MEMORY_ID_GENERATED | sessionDbId=${session.sessionDbId} | provider=OpenRouter`);
      }

      // Load active mode
      const mode = ModeManager.getInstance().getActiveMode();

      // Build initial prompt
      const initPrompt = session.lastPromptNumber === 1
        ? buildInitPrompt(session.project, session.contentSessionId, session.userPrompt, mode)
        : buildContinuationPrompt(session.userPrompt, session.lastPromptNumber, session.contentSessionId, mode);

      // Add to conversation history and query OpenRouter with full context
      session.conversationHistory.push({ role: 'user', content: initPrompt });
      const initResponse = await this.queryOpenRouterMultiTurn(session.conversationHistory, apiKey, model, siteUrl, appName);

      if (initResponse.content) {
        // Add response to conversation history
        // session.conversationHistory.push({ role: 'assistant', content: initResponse.content });

        // Track token usage
        const tokensUsed = initResponse.tokensUsed || 0;
        session.cumulativeInputTokens += Math.floor(tokensUsed * 0.7);  // Rough estimate
        session.cumulativeOutputTokens += Math.floor(tokensUsed * 0.3);

        // Process response using shared ResponseProcessor (no original timestamp for init - not from queue)
        await processAgentResponse(
          initResponse.content,
          session,
          this.dbManager,
          this.sessionManager,
          worker,
          tokensUsed,
          null,
          'OpenRouter',
          undefined,  // No lastCwd yet - before message processing
          model
        );
      } else {
        logger.error('SDK', 'Empty OpenRouter init response - session may lack context', {
          sessionId: session.sessionDbId,
          model
        });
      }

      // Track lastCwd from messages for CLAUDE.md generation
      let lastCwd: string | undefined;

      // Process pending messages
      for await (const message of this.sessionManager.getMessageIterator(session.sessionDbId)) {
        // CLAIM-CONFIRM: Track message ID for confirmProcessed() after successful storage
        // The message is now in 'processing' status in DB until ResponseProcessor calls confirmProcessed()
        session.processingMessageIds.push(message._persistentId);

        // Capture cwd from messages for proper worktree support
        if (message.cwd) {
          lastCwd = message.cwd;
        }
        // Capture earliest timestamp BEFORE processing (will be cleared after)
        const originalTimestamp = session.earliestPendingTimestamp;

        if (message.type === 'observation') {
          // Update last prompt number
          if (message.prompt_number !== undefined) {
            session.lastPromptNumber = message.prompt_number;
          }

          // CRITICAL: Check memorySessionId BEFORE making expensive LLM call
          // This prevents wasting tokens when we won't be able to store the result anyway
          if (!session.memorySessionId) {
            throw new Error('Cannot process observations: memorySessionId not yet captured. This session may need to be reinitialized.');
          }

          // Build observation prompt
          const obsPrompt = buildObservationPrompt({
            id: 0,
            tool_name: message.tool_name!,
            tool_input: JSON.stringify(message.tool_input),
            tool_output: JSON.stringify(message.tool_response),
            created_at_epoch: originalTimestamp ?? Date.now(),
            cwd: message.cwd
          });

          // Add to conversation history and query OpenRouter with full context
          session.conversationHistory.push({ role: 'user', content: obsPrompt });
          const obsResponse = await this.queryOpenRouterMultiTurn(session.conversationHistory, apiKey, model, siteUrl, appName);

          let tokensUsed = 0;
          if (obsResponse.content) {
            // Add response to conversation history
            // session.conversationHistory.push({ role: 'assistant', content: obsResponse.content });

            tokensUsed = obsResponse.tokensUsed || 0;
            session.cumulativeInputTokens += Math.floor(tokensUsed * 0.7);
            session.cumulativeOutputTokens += Math.floor(tokensUsed * 0.3);
          }

          // Process response using shared ResponseProcessor
          await processAgentResponse(
            obsResponse.content || '',
            session,
            this.dbManager,
            this.sessionManager,
            worker,
            tokensUsed,
            originalTimestamp,
            'OpenRouter',
            lastCwd,
            model
          );

        } else if (message.type === 'summarize') {
          // CRITICAL: Check memorySessionId BEFORE making expensive LLM call
          if (!session.memorySessionId) {
            throw new Error('Cannot process summary: memorySessionId not yet captured. This session may need to be reinitialized.');
          }

          // Build summary prompt
          const summaryPrompt = buildSummaryPrompt({
            id: session.sessionDbId,
            memory_session_id: session.memorySessionId,
            project: session.project,
            user_prompt: session.userPrompt,
            last_assistant_message: message.last_assistant_message || ''
          }, mode);

          // Add to conversation history and query OpenRouter with full context
          session.conversationHistory.push({ role: 'user', content: summaryPrompt });
          const summaryResponse = await this.queryOpenRouterMultiTurn(session.conversationHistory, apiKey, model, siteUrl, appName);

          let tokensUsed = 0;
          if (summaryResponse.content) {
            // Add response to conversation history
            // session.conversationHistory.push({ role: 'assistant', content: summaryResponse.content });

            tokensUsed = summaryResponse.tokensUsed || 0;
            session.cumulativeInputTokens += Math.floor(tokensUsed * 0.7);
            session.cumulativeOutputTokens += Math.floor(tokensUsed * 0.3);
          }

          // Process response using shared ResponseProcessor
          await processAgentResponse(
            summaryResponse.content || '',
            session,
            this.dbManager,
            this.sessionManager,
            worker,
            tokensUsed,
            originalTimestamp,
            'OpenRouter',
            lastCwd,
            model
          );
        }
      }

      // Mark session complete
      const sessionDuration = Date.now() - session.startTime;
      logger.success('SDK', 'OpenRouter agent completed', {
        sessionId: session.sessionDbId,
        duration: `${(sessionDuration / 1000).toFixed(1)}s`,
        historyLength: session.conversationHistory.length,
        model
      });

    } catch (error: unknown) {
      if (isAbortError(error)) {
        logger.warn('SDK', 'OpenRouter agent aborted', { sessionId: session.sessionDbId });
        throw error;
      }

      // Check if we should fall back to Claude
      if (shouldFallbackToClaude(error) && this.fallbackAgent) {
        logger.warn('SDK', 'OpenRouter API failed, falling back to Claude SDK', {
          sessionDbId: session.sessionDbId,
          error: error instanceof Error ? error.message : String(error),
          historyLength: session.conversationHistory.length
        });

        // Fall back to Claude - it will use the same session with shared conversationHistory
        // Note: With claim-and-delete queue pattern, messages are already deleted on claim
        return this.fallbackAgent.startSession(session, worker);
      }

      logger.failure('SDK', 'OpenRouter agent error', { sessionDbId: session.sessionDbId }, error as Error);
      throw error;
    }
  }

  /**
   * Estimate token count from text (conservative estimate)
   */
  private estimateTokens(text: string): number {
    return Math.ceil(text.length / CHARS_PER_TOKEN_ESTIMATE);
  }

  /**
   * Truncate conversation history to prevent runaway context costs
   * Keeps most recent messages within token budget
   */
  private truncateHistory(history: ConversationMessage[]): ConversationMessage[] {
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);

    const MAX_CONTEXT_MESSAGES = parseInt(settings.CLAUDE_MEM_OPENROUTER_MAX_CONTEXT_MESSAGES) || DEFAULT_MAX_CONTEXT_MESSAGES;
    const MAX_ESTIMATED_TOKENS = parseInt(settings.CLAUDE_MEM_OPENROUTER_MAX_TOKENS) || DEFAULT_MAX_ESTIMATED_TOKENS;

    if (history.length <= MAX_CONTEXT_MESSAGES) {
      // Check token count even if message count is ok
      const totalTokens = history.reduce((sum, m) => sum + this.estimateTokens(m.content), 0);
      if (totalTokens <= MAX_ESTIMATED_TOKENS) {
        return history;
      }
    }

    // Sliding window: keep most recent messages within limits
    const truncated: ConversationMessage[] = [];
    let tokenCount = 0;

    // Process messages in reverse (most recent first)
    for (let i = history.length - 1; i >= 0; i--) {
      const msg = history[i];
      const msgTokens = this.estimateTokens(msg.content);

      if (truncated.length >= MAX_CONTEXT_MESSAGES || tokenCount + msgTokens > MAX_ESTIMATED_TOKENS) {
        logger.warn('SDK', 'Context window truncated to prevent runaway costs', {
          originalMessages: history.length,
          keptMessages: truncated.length,
          droppedMessages: i + 1,
          estimatedTokens: tokenCount,
          tokenLimit: MAX_ESTIMATED_TOKENS
        });
        break;
      }

      truncated.unshift(msg);  // Add to beginning
      tokenCount += msgTokens;
    }

    return truncated;
  }

  /**
   * Convert shared ConversationMessage array to OpenAI-compatible message format
   */
  private conversationToOpenAIMessages(history: ConversationMessage[]): OpenAIMessage[] {
    return history.map(msg => ({
      role: msg.role === 'assistant' ? 'assistant' : 'user',
      content: msg.content
    }));
  }

  /**
   * Query OpenRouter via REST API with full conversation history (multi-turn)
   * Sends the entire conversation context for coherent responses
   */
  private async queryOpenRouterMultiTurn(
    history: ConversationMessage[],
    apiKey: string,
    model: string,
    siteUrl?: string,
    appName?: string
  ): Promise<{ content: string; tokensUsed?: number }> {
    // Truncate history to prevent runaway costs
    const truncatedHistory = this.truncateHistory(history);
    const messages = this.conversationToOpenAIMessages(truncatedHistory);
    const totalChars = truncatedHistory.reduce((sum, m) => sum + m.content.length, 0);
    const estimatedTokens = this.estimateTokens(truncatedHistory.map(m => m.content).join(''));

    logger.debug('SDK', `Querying OpenRouter multi-turn (${model})`, {
      turns: truncatedHistory.length,
      totalChars,
      estimatedTokens,
      apiUrl: this.resolveOpenRouterApiUrl(siteUrl)
    });

    const apiUrl = this.resolveOpenRouterApiUrl(siteUrl);
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer': this.resolveOpenRouterReferer(siteUrl),
        'X-Title': appName || 'claude-mem',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.3,  // Lower temperature for structured extraction
        max_tokens: 4096,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenRouter API error: ${response.status} - ${errorText}`);
    }

    const contentType = response.headers.get('content-type') || '';
    const rawBody = await response.text();

    let content = '';
    let tokensUsed: number | undefined;

    if (this.isSseResponse(contentType, rawBody)) {
      const parsed = this.parseOpenRouterSseResponse(rawBody);
      content = parsed.content;
      tokensUsed = parsed.tokensUsed;
    } else {
      const data = this.parseOpenRouterJsonResponse(rawBody);

      // Check for API error in response body
      if (data.error) {
        throw new Error(`OpenRouter API error: ${data.error.code} - ${data.error.message}`);
      }

      content = this.extractOpenRouterContent(data);
      tokensUsed = data.usage?.total_tokens;

      if (!content) {
        logger.error('SDK', 'OpenRouter JSON response did not contain extractable text', {
          model,
          contentType,
          schema: this.describeOpenRouterPayload(data)
        });
      }
    }

    if (!content) {
      logger.error('SDK', 'Empty response from OpenRouter', {
        model,
        contentType,
        apiUrl
      });
      return { content: '', tokensUsed };
    }

    // Log actual token usage for cost tracking
    if (tokensUsed) {
      const usage = this.parseUsageFromResponseBody(rawBody, contentType);
      const inputTokens = usage.prompt_tokens || 0;
      const outputTokens = usage.completion_tokens || 0;
      // Token usage (cost varies by model - many OpenRouter models are free)
      const estimatedCost = (inputTokens / 1000000 * 3) + (outputTokens / 1000000 * 15);

      logger.info('SDK', 'OpenRouter API usage', {
        model,
        inputTokens,
        outputTokens,
        totalTokens: tokensUsed,
        estimatedCostUSD: estimatedCost.toFixed(4),
        messagesInContext: truncatedHistory.length
      });

      // Warn if costs are getting high
      if (tokensUsed > 50000) {
        logger.warn('SDK', 'High token usage detected - consider reducing context', {
          totalTokens: tokensUsed,
          estimatedCost: estimatedCost.toFixed(4)
        });
      }
    }

    return { content, tokensUsed };
  }

  private resolveOpenRouterApiUrl(siteUrl?: string): string {
    const trimmed = siteUrl?.trim();
    if (!trimmed) return OPENROUTER_API_URL;

    try {
      const url = new URL(trimmed);
      const pathname = url.pathname.replace(/\/+$/, '');

      if (pathname.endsWith('/chat/completions')) {
        return url.toString();
      }

      if (!pathname || pathname === '/') {
        url.pathname = '/chat/completions';
        return url.toString();
      }

      url.pathname = `${pathname}/chat/completions`.replace(/\/+/g, '/');
      return url.toString();
    } catch {
      return OPENROUTER_API_URL;
    }
  }

  private resolveOpenRouterReferer(siteUrl?: string): string {
    const trimmed = siteUrl?.trim();
    if (!trimmed) return 'https://github.com/thedotmack/claude-mem';

    try {
      const url = new URL(trimmed);
      const path = url.pathname.toLowerCase();
      const looksLikeApiEndpoint = path.includes('/chat/completions') || path.endsWith('/v1') || path.includes('/api/');
      return looksLikeApiEndpoint ? 'https://github.com/thedotmack/claude-mem' : url.toString();
    } catch {
      return 'https://github.com/thedotmack/claude-mem';
    }
  }

  private isSseResponse(contentType: string, rawBody: string): boolean {
    return contentType.includes('text/event-stream') || rawBody.trimStart().startsWith('data:');
  }

  private parseOpenRouterJsonResponse(rawBody: string): OpenRouterResponse {
    try {
      return JSON.parse(rawBody) as OpenRouterResponse;
    } catch (error) {
      throw new Error(`Failed to parse OpenRouter JSON response: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private parseOpenRouterSseResponse(rawBody: string): { content: string; tokensUsed?: number } {
    const events = rawBody
      .split(/\r?\n\r?\n/)
      .map(block => block
        .split(/\r?\n/)
        .filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).trim())
        .join('\n'))
      .filter(Boolean);

    let combinedContent = '';
    let sawDelta = false;
    const fallbackChunks: string[] = [];
    let tokensUsed: number | undefined;

    for (const eventData of events) {
      if (eventData === '[DONE]') continue;

      let payload: OpenRouterResponse;
      try {
        payload = JSON.parse(eventData) as OpenRouterResponse;
      } catch (error) {
        logger.warn('SDK', 'Skipping malformed OpenRouter SSE chunk', {
          error: error instanceof Error ? error.message : String(error)
        });
        continue;
      }

      if (payload.error) {
        throw new Error(`OpenRouter API error: ${payload.error.code} - ${payload.error.message}`);
      }

      const deltaText = this.extractTextValue(payload.choices?.[0]?.delta?.content);
      if (deltaText) {
        combinedContent += deltaText;
        sawDelta = true;
      } else {
        const fallbackText = this.extractOpenRouterContent(payload);
        if (fallbackText) fallbackChunks.push(fallbackText);
      }

      if (typeof payload.usage?.total_tokens === 'number') {
        tokensUsed = payload.usage.total_tokens;
      }
    }

    const content = sawDelta ? combinedContent : fallbackChunks.join('');

    if (!content) {
      logger.error('SDK', 'OpenRouter SSE response did not contain extractable text', {
        eventCount: events.length
      });
    }

    return { content, tokensUsed };
  }

  private parseUsageFromResponseBody(rawBody: string, contentType: string): NonNullable<OpenRouterResponse['usage']> {
    if (this.isSseResponse(contentType, rawBody)) {
      const events = rawBody
        .split(/\r?\n\r?\n/)
        .map(block => block
          .split(/\r?\n/)
          .filter(line => line.startsWith('data:'))
          .map(line => line.slice(5).trim())
          .join('\n'))
        .filter(Boolean);

      for (let i = events.length - 1; i >= 0; i--) {
        if (events[i] === '[DONE]') continue;
        try {
          const payload = JSON.parse(events[i]) as OpenRouterResponse;
          if (payload.usage) return payload.usage;
        } catch {
          // Ignore malformed trailing chunk; parseOpenRouterSseResponse already logged it.
        }
      }
      return {};
    }

    try {
      return (JSON.parse(rawBody) as OpenRouterResponse).usage || {};
    } catch {
      return {};
    }
  }

  private extractOpenRouterContent(payload: OpenRouterResponse): string {
    return this.extractTextValue(payload.output_text)
      || this.extractTextValue(payload.choices?.[0]?.message?.content)
      || this.extractTextValue(payload.choices?.[0]?.delta?.content)
      || this.extractTextValue(payload.choices?.[0]?.text)
      || '';
  }

  private extractTextValue(value: unknown): string {
    if (typeof value === 'string') return value;

    if (Array.isArray(value)) {
      return value
        .map(item => this.extractTextValue(item))
        .filter(Boolean)
        .join('');
    }

    if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      return this.extractTextValue(record.text)
        || this.extractTextValue(record.content)
        || this.extractTextValue(record.value)
        || '';
    }

    return '';
  }

  private describeOpenRouterPayload(payload: OpenRouterResponse): Record<string, unknown> {
    const firstChoice = payload.choices?.[0];
    return {
      topLevelKeys: Object.keys(payload),
      firstChoiceKeys: firstChoice ? Object.keys(firstChoice) : [],
      hasOutputText: !!payload.output_text,
      hasMessageContent: !!firstChoice?.message?.content,
      hasDeltaContent: !!firstChoice?.delta?.content,
      hasChoiceText: !!firstChoice?.text,
    };
  }

  /**
   * Get OpenRouter configuration from settings or environment
   * Issue #733: Uses centralized ~/.claude-mem/.env for credentials, not random project .env files
   */
  private getOpenRouterConfig(): { apiKey: string; model: string; siteUrl?: string; appName?: string } {
    const settingsPath = USER_SETTINGS_PATH;
    const settings = SettingsDefaultsManager.loadFromFile(settingsPath);

    // API key: check settings first, then centralized claude-mem .env (NOT process.env)
    // This prevents Issue #733 where random project .env files could interfere
    const apiKey = settings.CLAUDE_MEM_OPENROUTER_API_KEY || getCredential('OPENROUTER_API_KEY') || '';

    // Model: from settings or default
    const model = settings.CLAUDE_MEM_OPENROUTER_MODEL || 'xiaomi/mimo-v2-flash:free';

    // Optional endpoint override (OpenRouter-compatible API base) or analytics URL
    const siteUrl = settings.CLAUDE_MEM_OPENROUTER_SITE_URL || '';
    const appName = settings.CLAUDE_MEM_OPENROUTER_APP_NAME || 'claude-mem';

    return { apiKey, model, siteUrl, appName };
  }
}

/**
 * Check if OpenRouter is available (has API key configured)
 * Issue #733: Uses centralized ~/.claude-mem/.env, not random project .env files
 */
export function isOpenRouterAvailable(): boolean {
  const settingsPath = USER_SETTINGS_PATH;
  const settings = SettingsDefaultsManager.loadFromFile(settingsPath);
  return !!(settings.CLAUDE_MEM_OPENROUTER_API_KEY || getCredential('OPENROUTER_API_KEY'));
}

/**
 * Check if OpenRouter is the selected provider
 */
export function isOpenRouterSelected(): boolean {
  const settingsPath = USER_SETTINGS_PATH;
  const settings = SettingsDefaultsManager.loadFromFile(settingsPath);
  return settings.CLAUDE_MEM_PROVIDER === 'openrouter';
}
