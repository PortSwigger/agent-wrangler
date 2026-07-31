---
name: run-dev
description: Use when running agent-wrangler locally for debugging or feature work — spinning up an isolated instance, driving it (dispatch/fork/archive/resume), or testing changes without touching the live board.
---

# Run an isolated agent-wrangler dev instance

## Overview

Run a clean-slate instance fully isolated from the live board: its own data dir, port, and **auto-generated tmux socket**. A fresh data dir has no legacy entries, so it never scans the default socket — it *cannot* see, attach, or kill the live board's sessions.

## Launch

```bash
# Pick a free port — Node asks the OS for one and releases it before we bind.
# Port 0 collisions between the probe and the actual bind are not possible in
# practice: the OS won't re-issue that port immediately to a different process.
AW_PORT=$(node -e "const net=require('net');const s=net.createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})")
AWDIR=$(mktemp -d /tmp/aw-dev-XXXXX)
AW_DEV=1 AW_DATA_DIR=$AWDIR AW_PORT=$AW_PORT node server/index.js >"$AWDIR/server.log" 2>&1 &
SERVER_PID=$!                                              # needed for teardown
until curl -s -o /dev/null -w "%{http_code}" "http://localhost:$AW_PORT/" | grep -q 200; do sleep 0.5; done
echo "Dev board at http://localhost:$AW_PORT  (data: $AWDIR)"
```

- `AW_DATA_DIR` — isolated state (mappings, memory, config). **`mktemp` ensures a fresh, unique dir with no legacy entries** so the instance never scans the live board's default tmux socket. **Always let `mktemp` mint a unique path — never substitute a fixed, memorable name (`/tmp/aw-dev-todo`) you reuse across runs** (see the lock-blind-spot gotcha).
- `AW_PORT` — auto-selected free port; the board doesn't auto-open a browser (default off; `AW_OPEN_BROWSER=1` to open one).
- The instance generates its socket into `<AW_DATA_DIR>/config.json` (`tmuxSocket`); all its sessions run there.
- `AW_DEV=1` — opts the instance into **self-shutdown** so a forgotten teardown can't leave it running forever (reparented to launchd). It exits when its data dir is wiped out from under it, or after ~30 min idle with no control-WS client connected (`AW_DEV_IDLE_SHUTDOWN_MIN` to tune, `0` to disable the idle timer). The production service never sets `AW_DEV`, so it's unaffected. It exits cleanly (lock released) but does **not** delete its data dir — teardown still owns that.

## Safety — why it can't touch the live board

A fresh `AW_DATA_DIR` has no legacy (socket-less) entries, so `socketsToScan` returns only the generated socket and the **default socket is never scanned**. Never point a dev instance at the live `~/.agent-wrangler` data dir.

## Drive it headlessly (control WS)

Connect to `ws://localhost:<port>/ws` and send JSON (minimal client: `import WebSocket from '<repo>/node_modules/ws/wrapper.mjs'` with an **absolute** path):

| message | effect |
|---|---|
| `{type:'dispatch', cwd:'', intent:'<prompt>', model:'sonnet'}` | new session (blank cwd → scratch dir) |
| `{type:'fork', sessionId:'<cardId>', prompt:'<first msg>'}` | replies `{type:'forked', sessionId}` |
| `{type:'archive', sessionId:'<cardId>'}` / `{type:'resume', sessionId:'<cardId>'}` | archive / restore |

A `{type:'graph', graph}` is pushed on connect and every rebuild; sessions are under **`msg.graph.sessions`** (each has `sessionId` = card id, `liveSessionId`, `managed`, `socket`, `label`). Terminal bytes: `ws://localhost:<port>/pty?sessionId=<cardId>&cols=120&rows=32`.

## Waiting on a session

A session writes its transcript **on its first message**, at `~/.claude/projects/<encoded-cwd>/<liveSessionId>.jsonl`. The bucket is the cwd with `/`→`-` and a leading `-` (macOS resolves `/tmp`→`/private/tmp`), e.g. a scratch cwd `/tmp/aw-dev/sessions/<ts>` → `-private-tmp-aw-dev-sessions-<ts>`. If unsure, discover it: `ls -td ~/.claude/projects/*aw-dev* | head`.

**Poll for the `.jsonl` appearing with a real per-iteration delay** — do NOT use `for i in …; do [ -f X ] && break; done`: the file-test short-circuits so the loop finishes in milliseconds, long before Claude responds. Use a delay each iteration:

```bash
until ls ~/.claude/projects/*aw-dev*/"$LIVE_ID".jsonl >/dev/null 2>&1; do sleep 2; done
```

## Teardown

```bash
kill "$SERVER_PID"
tmux -L "$(node -e "console.log(require('$AWDIR/config.json').tmuxSocket)")" kill-server 2>/dev/null || true
# Derive the Claude transcript bucket from the data dir (macOS resolves /tmp → /private/tmp)
REAL_AWDIR=$(cd "$AWDIR" && pwd -P)
BUCKET=$(echo "$REAL_AWDIR" | tr '/' '-')
rm -rf "$AWDIR"
rm -rf "${HOME}/.claude/projects/${BUCKET}-sessions-"*   # ⚠ shared tree — scoped to THIS data dir's sessions
```

⚠ `~/.claude/projects/` holds **real** transcripts too. The glob above is scoped to scratch session dirs under `$AWDIR` — never use a broad pattern like `*aw-dev*` that could match other dirs.

## Gotchas

- **Launching from a git worktree: it has no `node_modules` of its own — give it a real one, never a symlink to the main checkout's.** `git worktree add` doesn't copy `node_modules` (gitignored), and a worktree normally lives as a *sibling* of the main checkout, not nested inside it, so Node's ESM resolver walking up the filesystem never finds the main checkout's copy — `node server/index.js` fails `ERR_MODULE_NOT_FOUND` for `ws`/`node-pty` on first launch. Fix by running `npm ci` scoped to the worktree (fast — npm's own cache), **not** by symlinking `node_modules` to the main checkout: a symlink means any install run from inside the worktree (e.g. someone reacting to a missing dependency after the branch bumped one) writes into the *same physical directory* the live production service resolves modules from, silently swapping its dependency versions.
- **One dir per run — let `mktemp` pick it; never reuse or wipe-and-recreate a data dir under a live instance.** The one-instance-per-`DATA_DIR` lock is a socket *file* inside the dir (`instance.sock`). Deleting the dir (a `rm -rf` between dev iterations) removes the lock out from under the still-running holder, so the next launch finds no socket and starts cleanly on the *same* dir — now two instances share it and each rewrites the whole `mappings.json`/`tasks.json` snapshot on every save, clobbering the other (sessions vanish, reappear, or reload unassigned). A fresh `mktemp` path every run sidesteps this entirely; if you must tear down, `kill` the server *before* removing its data dir.
- **Never name a shell variable `TMUX`** — it points `tmux` at a bogus socket so `tmux ls` reports nothing (looks like your sessions vanished — they didn't).
- **Card id ≠ session id.** The conversation lives under `liveSessionId`, not the card id (the mapping key). Don't `--resume` a card id.
- **Migration testing:** `AW_LEGACY_TMUX_SOCKET=<fake>` makes the instance treat a *named* socket as the "default/legacy" one, so you can stand up fake old-code sessions on that fake socket and exercise the default-socket drain **without touching the real default socket**.
- A never-messaged fork has no transcript yet (written on first message), so it isn't resumable until you send it one turn.
