---
name: setup-wrangler-service
description: Use when the user wants to install, reinstall, or repair the
  agent-wrangler launchd background service on macOS — e.g. "set up the
  wrangler as a service", "make it always-on", "the service won't start".
  Fills the plist template from scripts/, loads it via launchctl, and verifies
  the server is actually serving before claiming success.
---

Installs `net.portswigger.agent-wrangler` as a per-user launchd agent. The
template lives at `scripts/net.portswigger.agent-wrangler.plist.example` —
**generate from it, never hand-write the plist**, so this skill can't drift
from the canonical version.

macOS only (launchd). If the user isn't on macOS, say so and stop.

# Step 1 — resolve the substitutions

Three things must be correct or the service silently fails:

- **Repo path** — the absolute path to this checkout (`git rev-parse
  --show-toplevel`). Wrong path → launchd can't find `wrangler-start.sh`.
- **Username** — `id -un`, for the `PATH` and log paths.
- **`~/.local/bin` on `PATH`** — the template already puts it first. This is
  load-bearing: without it `dispatch`/`resume` exit 127 because `claude` isn't
  found. Don't drop it when substituting.
- **`AW_BIND_HOST=0.0.0.0` (only if you use devcontainer sessions)** — required so an
  in-container agent can reach the wrangler's `/mcp` over `host.docker.internal`; also
  needs `@devcontainers/cli` (a bundled dep, on `node_modules/.bin`). Note the
  shared-machine exposure trade-off (the control/MCP posture is localhost-advisory).

```
REPO=$(git rev-parse --show-toplevel)
USER_HOME=$HOME
USER_NAME=$(id -un)
PLIST=~/Library/LaunchAgents/net.portswigger.agent-wrangler.plist
```

# Step 2 — generate the plist

Read the template and substitute the placeholders (`/ABSOLUTE/PATH/TO/agent-wrangler`
→ repo path, `YOUR_USERNAME` → username). Create the log directory first —
launchd won't create it and the service flaps if `StandardOutPath`'s parent is
missing:

```
mkdir -p "$USER_HOME/Library/Logs/wrangler"
sed -e "s#/ABSOLUTE/PATH/TO/agent-wrangler#$REPO#g" \
    -e "s#YOUR_USERNAME#$USER_NAME#g" \
    "$REPO/scripts/net.portswigger.agent-wrangler.plist.example" > "$PLIST"
```

# Step 3 — (re)load it

If the label is already loaded (reinstall/repair), boot it out first — a stale
definition wins over the new file otherwise:

```
launchctl bootout gui/$(id -u)/net.portswigger.agent-wrangler 2>/dev/null
launchctl bootstrap gui/$(id -u) "$PLIST"
launchctl kickstart -k gui/$(id -u)/net.portswigger.agent-wrangler
```

# Step 4 — verify it's actually serving

`bootstrap` succeeding only means launchd accepted the job, not that the server
came up. Confirm both the job state and an HTTP response on the configured
`PORT` (read it from the plist — default `7777` in the template):

```
launchctl print gui/$(id -u)/net.portswigger.agent-wrangler | grep -E 'state =|pid ='
PORT=$(plutil -extract EnvironmentVariables.PORT raw "$PLIST")
curl -s -o /dev/null -w 'http %{http_code}\n' "http://localhost:$PORT/"
```

Success is `state = running` **and** `http 200`. Report both. If the state is
`running` but curl fails, the server crashed on boot — read
`~/Library/Logs/wrangler/wrangler.err`.

# Common failures

- **Exit 127 in the log** — `~/.local/bin` missing from `PATH`. Check the
  `PATH` string in the plist matches the template.
- **Terminals render Unicode as `_`** — the server's locale isn't UTF-8.
  `wrangler-start.sh` pins `LANG`/`LC_CTYPE`; confirm with `ps eww <pid>`.
- **Job won't load ("Bootstrap failed: 5: Input/output error")** — usually a
  malformed plist. Validate with `plutil -lint "$PLIST"`.
