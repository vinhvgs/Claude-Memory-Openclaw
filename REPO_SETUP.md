# Claude Memory Openclaw — Repo Setup

## Local source path

```bash
/opt/diemmy/workspace/third_party/claude-memory-openclaw
```

## What was prepared

- standalone copy from current working source
- old `.git` history removed
- new git repo initialized on branch `main`
- metadata renamed to **Claude Memory Openclaw**
- package/repository/homepage/issues URLs pointed to:

```text
https://github.com/vinhvgs/Claude-Memory-Openclaw
```

## Important note

This source is prepared to create a **new GitHub repo** quickly.

To avoid breaking runtime compatibility, many internal runtime identifiers were intentionally kept as-is for now, especially places where OpenClaw/plugin runtime may still expect `claude-mem` ids or paths.

So this repo is currently:
- **repo-brand renamed**
- **source standalone**
- **safe for creating a new GitHub repo**
- **not a full deep rename of every internal runtime string**

## Suggested GitHub repo name

```text
claude-memory-openclaw
```

## Create new GitHub repo and push

### Option A — GitHub CLI

```bash
cd /opt/diemmy/workspace/third_party/claude-memory-openclaw
gh repo create vinhvgs/Claude-Memory-Openclaw --public --source=. --remote=origin --push
```

### Option B — Manual Git remote

Create repo on GitHub first, then run:

```bash
cd /opt/diemmy/workspace/third_party/claude-memory-openclaw
git remote add origin https://github.com/vinhvgs/Claude-Memory-Openclaw.git
git add .
git commit -m "Initial import: Claude Memory Openclaw"
git push -u origin main
```

## Recommended validation before first push

```bash
cd /opt/diemmy/workspace/third_party/claude-memory-openclaw
bun install
npm run build
npm run test:e2e:openrouter-mock
```

## If anh muốn rename sâu hơn

Possible next phase:
- rename installer URLs from old upstream repo to new repo
- rename remaining docs links from `thedotmack/claude-mem`
- decide whether to keep or rename runtime ids like `claude-mem`
- update OpenClaw installer/test fixtures accordingly
- run full regression after deep rename
