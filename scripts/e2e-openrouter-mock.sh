#!/usr/bin/env bash
#
# E2E Test: OpenRouter provider with isolated local mock server
#
# Purpose:
# - Run claude-mem worker in a fully isolated temp HOME/data dir
# - Mock an OpenRouter-compatible /chat/completions endpoint locally
# - Exercise end-to-end flow: init -> observations -> summarize -> complete
# - Verify both HTTP API output and SQLite storage
#
# Usage:
#   bash scripts/e2e-openrouter-mock.sh
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMPROOT="$(mktemp -d)"
export HOME="$TMPROOT/home"
export CLAUDE_CONFIG_DIR="$HOME/.claude"
export CLAUDE_MEM_DATA_DIR="$HOME/.claude-mem"
mkdir -p "$HOME" "$CLAUDE_CONFIG_DIR" "$CLAUDE_MEM_DATA_DIR"

WORKER_HOST="127.0.0.1"
WORKER_PORT="37881"
MOCK_HOST="127.0.0.1"
MOCK_PORT="37882"
SESSION_ID="sess-e2e-001"
PROJECT_NAME="openclaw-e2e"
PROJECT_CWD="$REPO_ROOT"
SETTINGS_PATH="$CLAUDE_MEM_DATA_DIR/settings.json"
WORKER_URL="http://${WORKER_HOST}:${WORKER_PORT}"
MOCK_URL="http://${MOCK_HOST}:${MOCK_PORT}"
DB_PATH="$CLAUDE_MEM_DATA_DIR/claude-mem.db"
WORKER_SCRIPT="$REPO_ROOT/plugin/scripts/worker-service.cjs"

PASS=0
FAIL=0
TOTAL=0

log() {
  echo "[$(date +%H:%M:%S)] $*"
}

pass() {
  PASS=$((PASS + 1))
  TOTAL=$((TOTAL + 1))
  log "PASS: $*"
}

fail() {
  FAIL=$((FAIL + 1))
  TOTAL=$((TOTAL + 1))
  log "FAIL: $*"
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Required command not found: $1" >&2
    exit 1
  }
}

json_field() {
  local file="$1"
  local expr="$2"
  bun -e '
    const expr = process.argv[1];
    const file = process.argv[2];
    const data = JSON.parse(await Bun.file(file).text());
    const fn = new Function("obj", `return (${expr});`);
    const value = fn(data);
    if (typeof value === "object") console.log(JSON.stringify(value));
    else console.log(String(value));
  ' "$expr" "$file"
}

wait_for_http() {
  local url="$1"
  local attempts="$2"
  local delay="$3"
  for _ in $(seq 1 "$attempts"); do
    if curl -fsS "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep "$delay"
  done
  return 1
}

cleanup() {
  set +e
  if [[ -n "${WORKER_PID:-}" ]]; then kill "$WORKER_PID" 2>/dev/null || true; fi
  if [[ -n "${MOCK_PID:-}" ]]; then kill "$MOCK_PID" 2>/dev/null || true; fi
}
trap cleanup EXIT

require_cmd bun
require_cmd node
require_cmd curl

if [[ ! -f "$WORKER_SCRIPT" ]]; then
  echo "Worker script not found: $WORKER_SCRIPT" >&2
  echo "Run npm run build first." >&2
  exit 1
fi

cat > "$SETTINGS_PATH" <<JSON
{
  "CLAUDE_MEM_MODEL": "claude-sonnet-4-6",
  "CLAUDE_MEM_CONTEXT_OBSERVATIONS": "50",
  "CLAUDE_MEM_WORKER_PORT": "$WORKER_PORT",
  "CLAUDE_MEM_WORKER_HOST": "$WORKER_HOST",
  "CLAUDE_MEM_SKIP_TOOLS": "ListMcpResourcesTool,SlashCommand,Skill,TodoWrite,AskUserQuestion",
  "CLAUDE_MEM_PROVIDER": "openrouter",
  "CLAUDE_MEM_CLAUDE_AUTH_METHOD": "cli",
  "CLAUDE_MEM_GEMINI_API_KEY": "",
  "CLAUDE_MEM_GEMINI_MODEL": "gemini-2.5-flash-lite",
  "CLAUDE_MEM_GEMINI_RATE_LIMITING_ENABLED": "true",
  "CLAUDE_MEM_GEMINI_MAX_CONTEXT_MESSAGES": "20",
  "CLAUDE_MEM_GEMINI_MAX_TOKENS": "100000",
  "CLAUDE_MEM_OPENROUTER_API_KEY": "test-key",
  "CLAUDE_MEM_OPENROUTER_MODEL": "mock/model",
  "CLAUDE_MEM_OPENROUTER_SITE_URL": "$MOCK_URL",
  "CLAUDE_MEM_OPENROUTER_APP_NAME": "claude-mem-e2e",
  "CLAUDE_MEM_OPENROUTER_MAX_CONTEXT_MESSAGES": "20",
  "CLAUDE_MEM_OPENROUTER_MAX_TOKENS": "100000",
  "CLAUDE_MEM_DATA_DIR": "$CLAUDE_MEM_DATA_DIR",
  "CLAUDE_MEM_LOG_LEVEL": "DEBUG",
  "CLAUDE_MEM_PYTHON_VERSION": "3.13",
  "CLAUDE_CODE_PATH": "",
  "CLAUDE_MEM_MODE": "code",
  "CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS": "false",
  "CLAUDE_MEM_CONTEXT_SHOW_WORK_TOKENS": "false",
  "CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT": "false",
  "CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_PERCENT": "true",
  "CLAUDE_MEM_CONTEXT_FULL_COUNT": "0",
  "CLAUDE_MEM_CONTEXT_FULL_FIELD": "narrative",
  "CLAUDE_MEM_CONTEXT_SESSION_COUNT": "10",
  "CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY": "true",
  "CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE": "false",
  "CLAUDE_MEM_CONTEXT_SHOW_TERMINAL_OUTPUT": "true",
  "CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED": "false",
  "CLAUDE_MEM_FOLDER_USE_LOCAL_MD": "false",
  "CLAUDE_MEM_TRANSCRIPTS_ENABLED": "false",
  "CLAUDE_MEM_TRANSCRIPTS_CONFIG_PATH": "$CLAUDE_MEM_DATA_DIR/transcript-watch.json",
  "CLAUDE_MEM_MAX_CONCURRENT_AGENTS": "2",
  "CLAUDE_MEM_EXCLUDED_PROJECTS": "",
  "CLAUDE_MEM_FOLDER_MD_EXCLUDE": "[]",
  "CLAUDE_MEM_SEMANTIC_INJECT": "false",
  "CLAUDE_MEM_SEMANTIC_INJECT_LIMIT": "5",
  "CLAUDE_MEM_TIER_ROUTING_ENABLED": "false",
  "CLAUDE_MEM_TIER_SIMPLE_MODEL": "haiku",
  "CLAUDE_MEM_TIER_SUMMARY_MODEL": "",
  "CLAUDE_MEM_CHROMA_ENABLED": "false",
  "CLAUDE_MEM_CHROMA_MODE": "local",
  "CLAUDE_MEM_CHROMA_HOST": "127.0.0.1",
  "CLAUDE_MEM_CHROMA_PORT": "8000",
  "CLAUDE_MEM_CHROMA_SSL": "false",
  "CLAUDE_MEM_CHROMA_API_KEY": "",
  "CLAUDE_MEM_CHROMA_TENANT": "default_tenant",
  "CLAUDE_MEM_CHROMA_DATABASE": "default_database"
}
JSON

cat > "$TMPROOT/mock-openrouter.js" <<'JS'
const http = require('http');
const port = Number(process.env.MOCK_PORT || 37882);

function extractLastUserText(messages) {
  const users = (messages || []).filter(m => m.role === 'user');
  return users.length ? String(users[users.length - 1].content || '') : '';
}

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/chat/completions') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      let payload = {};
      try { payload = JSON.parse(body || '{}'); } catch {}
      const text = extractLastUserText(payload.messages);

      let content;
      if (text.includes('<what_happened>') || text.includes('<parameters>') || text.includes('<outcome>')) {
        content = `
<observation>
  <type>bugfix</type>
  <title>Adapter mapping validated</title>
  <subtitle>OpenClaw adapter E2E</subtitle>
  <facts>
    <fact>OpenRouter mock received observation prompt</fact>
    <fact>Source adapter stores content_session_id correctly</fact>
  </facts>
  <narrative>Worker processed observation via mock OpenRouter response.</narrative>
  <concepts>
    <concept>adapter</concept>
    <concept>e2e</concept>
  </concepts>
  <files_read>
    <file>src/services/worker/http/routes/SessionRoutes.ts</file>
  </files_read>
  <files_modified>
    <file>openclaw/src/index.test.ts</file>
  </files_modified>
</observation>`;
      } else if (text.includes('PROGRESS SUMMARY') || text.includes('<summary>') || text.toLowerCase().includes('last assistant message')) {
        content = `
<summary>
  <request>Run isolated OpenClaw adapter E2E with mock OpenRouter</request>
  <investigated>Worker API flow init → observation → summarize → complete</investigated>
  <learned>OpenRouter provider can be tested locally with a mock /chat/completions endpoint</learned>
  <completed>Stored one observation and one summary in isolated temp data dir</completed>
  <next_steps>Promote this script into repo test automation if desired</next_steps>
  <notes>Mock response path only; no real provider auth required</notes>
</summary>`;
      } else {
        content = `
<observation>
  <type>bugfix</type>
  <title>Session initialized</title>
  <facts>
    <fact>Mock OpenRouter init response delivered</fact>
  </facts>
  <narrative>Initialization completed for isolated E2E run.</narrative>
  <concepts>
    <concept>session</concept>
    <concept>init</concept>
  </concepts>
</observation>`;
      }

      const response = {
        id: 'mock-openrouter',
        choices: [
          { message: { role: 'assistant', content } }
        ],
        usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 }
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(response));
    });
    return;
  }

  if (req.method === 'GET' && req.url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not_found' }));
});

server.listen(port, '127.0.0.1', () => {
  console.log(`mock-openrouter listening on ${port}`);
});
JS

log "Starting isolated mock OpenRouter on $MOCK_URL"
MOCK_PORT="$MOCK_PORT" node "$TMPROOT/mock-openrouter.js" > "$TMPROOT/mock.log" 2>&1 &
MOCK_PID=$!

if wait_for_http "$MOCK_URL/healthz" 40 0.25; then
  pass "mock OpenRouter became healthy"
else
  fail "mock OpenRouter failed to start"
  exit 1
fi

log "Starting worker from $WORKER_SCRIPT"
bun "$WORKER_SCRIPT" > "$TMPROOT/worker.log" 2>&1 &
WORKER_PID=$!

if wait_for_http "$WORKER_URL/api/health" 120 0.5; then
  pass "worker health endpoint became ready"
else
  fail "worker failed to start"
  tail -100 "$TMPROOT/worker.log" || true
  exit 1
fi

curl -fsS "$WORKER_URL/api/health" > "$TMPROOT/health.json"
if [[ "$(json_field "$TMPROOT/health.json" 'obj.status')" == "ok" ]]; then
  pass "worker /api/health returned status=ok"
else
  fail "worker /api/health did not return status=ok"
fi

log "Posting /api/sessions/init"
curl -fsS -X POST "$WORKER_URL/api/sessions/init" \
  -H 'content-type: application/json' \
  -d "{\"contentSessionId\":\"${SESSION_ID}\",\"project\":\"${PROJECT_NAME}\",\"prompt\":\"Run isolated E2E for OpenClaw adapter\",\"platformSource\":\"claude\",\"customTitle\":\"E2E isolated\"}" > "$TMPROOT/init.json"

if [[ "$(json_field "$TMPROOT/init.json" 'typeof obj.sessionDbId === "number"')" == "true" ]]; then
  pass "session init returned sessionDbId"
else
  fail "session init missing sessionDbId"
fi

log "Posting /api/sessions/observations"
curl -fsS -X POST "$WORKER_URL/api/sessions/observations" \
  -H 'content-type: application/json' \
  -d "{\"contentSessionId\":\"${SESSION_ID}\",\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":\"openclaw/src/index.test.ts\",\"old_string\":\"a\",\"new_string\":\"b\"},\"tool_response\":{\"success\":true},\"cwd\":\"${PROJECT_CWD}\",\"platformSource\":\"claude\"}" > "$TMPROOT/obs.json"

if [[ "$(json_field "$TMPROOT/obs.json" 'obj.status')" == "queued" ]]; then
  pass "observation request queued"
else
  fail "observation request did not queue"
fi

log "Posting /api/sessions/summarize"
curl -fsS -X POST "$WORKER_URL/api/sessions/summarize" \
  -H 'content-type: application/json' \
  -d "{\"contentSessionId\":\"${SESSION_ID}\",\"last_assistant_message\":\"E2E local run finished successfully\",\"platformSource\":\"claude\"}" > "$TMPROOT/summarize.json"

if [[ "$(json_field "$TMPROOT/summarize.json" 'obj.status')" == "queued" ]]; then
  pass "summary request queued"
else
  fail "summary request did not queue"
fi

for _ in $(seq 1 80); do
  curl -fsS "$WORKER_URL/api/observations?limit=20" > "$TMPROOT/observations.json"
  curl -fsS "$WORKER_URL/api/summaries?limit=20" > "$TMPROOT/summaries.json"
  OBS_COUNT="$(json_field "$TMPROOT/observations.json" '(obj.items || obj.observations || []).length')"
  SUM_COUNT="$(json_field "$TMPROOT/summaries.json" '(obj.items || obj.summaries || []).length')"
  if [[ "$OBS_COUNT" -ge 2 && "$SUM_COUNT" -ge 1 ]]; then
    break
  fi
  sleep 0.5
done

curl -fsS "$WORKER_URL/api/stats" > "$TMPROOT/stats.json"

OBS_COUNT="$(json_field "$TMPROOT/observations.json" '(obj.items || obj.observations || []).length')"
SUM_COUNT="$(json_field "$TMPROOT/summaries.json" '(obj.items || obj.summaries || []).length')"
SESSION_COUNT="$(json_field "$TMPROOT/stats.json" 'obj.database.sessions')"

if [[ "$OBS_COUNT" -ge 2 ]]; then
  pass "API shows at least 2 observations"
else
  fail "API observation count < 2 (got $OBS_COUNT)"
fi

if [[ "$SUM_COUNT" -ge 1 ]]; then
  pass "API shows at least 1 summary"
else
  fail "API summary count < 1 (got $SUM_COUNT)"
fi

if [[ "$SESSION_COUNT" -ge 1 ]]; then
  pass "API stats shows at least 1 session"
else
  fail "API stats session count < 1 (got $SESSION_COUNT)"
fi

log "Posting /api/sessions/complete"
curl -fsS -X POST "$WORKER_URL/api/sessions/complete" \
  -H 'content-type: application/json' \
  -d "{\"contentSessionId\":\"${SESSION_ID}\",\"platformSource\":\"claude\"}" > "$TMPROOT/complete.json"

if [[ "$(json_field "$TMPROOT/complete.json" 'obj.status')" == "completed" ]]; then
  pass "complete endpoint returned completed"
else
  fail "complete endpoint did not return completed"
fi

log "Verifying isolated SQLite DB at $DB_PATH"
bun -e '
  import { Database } from "bun:sqlite";
  const dbPath = process.argv[process.argv.length - 1];
  if (!dbPath || dbPath === "--") {
    throw new Error(`Invalid DB path argument: ${JSON.stringify(process.argv)}`);
  }
  const db = new Database(dbPath, { readonly: true });
  const result = {
    observations: db.query("select id, type, title, prompt_number from observations order by id").all(),
    summaries: db.query("select id, request, completed from session_summaries order by id").all(),
    sessions: db.query("select id, content_session_id, memory_session_id, project, platform_source from sdk_sessions order by id").all(),
  };
  console.log(JSON.stringify(result, null, 2));
' -- "$DB_PATH" > "$TMPROOT/sqlite-verify.json"

DB_OBS_COUNT="$(json_field "$TMPROOT/sqlite-verify.json" 'obj.observations.length')"
DB_SUM_COUNT="$(json_field "$TMPROOT/sqlite-verify.json" 'obj.summaries.length')"
DB_SESSION_COUNT="$(json_field "$TMPROOT/sqlite-verify.json" 'obj.sessions.length')"
DB_SESSION_ID="$(json_field "$TMPROOT/sqlite-verify.json" 'obj.sessions[0]?.content_session_id ?? ""')"
DB_PROJECT="$(json_field "$TMPROOT/sqlite-verify.json" 'obj.sessions[0]?.project ?? ""')"

if [[ "$DB_OBS_COUNT" -ge 2 ]]; then
  pass "DB contains at least 2 observations"
else
  fail "DB observation count < 2 (got $DB_OBS_COUNT)"
fi

if [[ "$DB_SUM_COUNT" -ge 1 ]]; then
  pass "DB contains at least 1 summary"
else
  fail "DB summary count < 1 (got $DB_SUM_COUNT)"
fi

if [[ "$DB_SESSION_COUNT" -ge 1 ]]; then
  pass "DB contains at least 1 session"
else
  fail "DB session count < 1 (got $DB_SESSION_COUNT)"
fi

if [[ "$DB_SESSION_ID" == "$SESSION_ID" ]]; then
  pass "DB preserved content_session_id=$SESSION_ID"
else
  fail "DB content_session_id mismatch (got $DB_SESSION_ID)"
fi

if [[ "$DB_PROJECT" == "$PROJECT_NAME" ]]; then
  pass "DB preserved project=$PROJECT_NAME"
else
  fail "DB project mismatch (got $DB_PROJECT)"
fi

log "Artifacts"
log "  TMPROOT=$TMPROOT"
log "  DB=$DB_PATH"
log "  worker log=$TMPROOT/worker.log"
log "  mock log=$TMPROOT/mock.log"
log "  sqlite verify=$TMPROOT/sqlite-verify.json"

echo
echo "==============================="
echo " OpenRouter Mock E2E Results"
echo "==============================="
echo " Total:  $TOTAL"
echo " Passed: $PASS"
echo " Failed: $FAIL"
echo "==============================="

if [[ "$FAIL" -gt 0 ]]; then
  echo
  echo "--- worker.log ---"
  tail -200 "$TMPROOT/worker.log" || true
  echo
  echo "--- mock.log ---"
  tail -100 "$TMPROOT/mock.log" || true
  exit 1
fi
