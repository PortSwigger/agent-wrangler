---
name: wrangler-post-merge
description: Use when a branch or worktree has just been merged into main in this repo, or when main has been updated via rebase or pull from origin.
---

# Restart after main moves

The live board runs under launchd from the main checkout and does **not** auto-reload. After `main` moves, check what changed and restart if `server/` or `public/` files were touched — changes to only `.claude/`, `docs/`, skills, or other non-server files do not require a restart.

**Restart immediately when server or frontend code changed — without being asked.**

```bash
launchctl kickstart -k gui/$(id -u)/net.portswigger.agent-wrangler
sleep 3 && curl -s -o /dev/null -w "%{http_code}\n" http://localhost:7777/   # expect 200
```

The restart re-runs `wrangler-start.sh` → `sync-deps.sh`, so a dep change self-heals (`npm ci` only when `package-lock.json` changed). For install/repair of the service itself, use the `setup-wrangler-service` skill.

**A rebase is not an exemption.** "I just rebased, nothing new is mine" — the server is still running pre-rebase code. Evaluate and restart.

## Red flags — STOP

- Merged or rebased and moving on without evaluating whether a restart is needed
- Restarting when only `.claude/`, `docs/`, or skills changed — that's unnecessary churn
- "It's only a doc change / nothing new is mine" → still evaluate; restart if any server or public/ file changed
- Curl returns non-200 → service didn't come up; check `log show` before continuing
