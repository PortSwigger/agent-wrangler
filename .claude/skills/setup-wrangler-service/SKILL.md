---
name: setup-wrangler-service
description: Use when the user wants to install, reinstall, or repair the
  agent-wrangler background service on macOS (launchd) or Linux (systemd) —
  e.g. "set up the wrangler as a service", "make it always-on", "the service
  won't start". Fills the unit/plist template from scripts/, loads it via
  launchctl or systemctl, and verifies the server is actually serving before
  claiming success.
---

Installs agent-wrangler as a per-user background service — launchd on macOS,
a systemd user unit on Linux (including WSL2, which is a real Linux kernel and
uses this same flow). Detect the platform first (`uname -s`: `Darwin` →
macOS flow below, `Linux` → Linux flow) and follow the matching section.
Anything else (e.g. native Windows outside WSL2), say so and stop.

Both platforms generate the live unit file from a checked-in template —
**generate from it, never hand-write the plist/unit**, so this skill can't
drift from the canonical version.

## macOS (launchd)

Template: `scripts/net.portswigger.agent-wrangler.plist.example`.

### Step 1 — resolve the substitutions

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

### Step 2 — generate the plist

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

### Step 3 — (re)load it

If the label is already loaded (reinstall/repair), boot it out first — a stale
definition wins over the new file otherwise:

```
launchctl bootout gui/$(id -u)/net.portswigger.agent-wrangler 2>/dev/null
launchctl bootstrap gui/$(id -u) "$PLIST"
launchctl kickstart -k gui/$(id -u)/net.portswigger.agent-wrangler
```

### Step 4 — verify it's actually serving

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

### Common failures (macOS)

- **Exit 127 in the log** — `~/.local/bin` missing from `PATH`. Check the
  `PATH` string in the plist matches the template.
- **Terminals render Unicode as `_`** — the server's locale isn't UTF-8.
  `wrangler-start.sh` pins `LANG`/`LC_CTYPE`; confirm with `ps eww <pid>`.
- **Job won't load ("Bootstrap failed: 5: Input/output error")** — usually a
  malformed plist. Validate with `plutil -lint "$PLIST"`.

## Linux (systemd)

Template: `scripts/agent-wrangler.service.example` — same structure and intent
as the launchd plist, just systemd's shape: a `[Service]` `ExecStart=` in
place of `ProgramArguments`, `Environment=` lines in place of the
`EnvironmentVariables` dict, and `LimitNOFILE=` for the fd-limit hardening
that the macOS path instead sets via a shell `ulimit -n` inside
`wrangler-start.sh` — systemd enforces it before the process even starts,
so the Linux unit doesn't need (and mustn't rely on) that shell `ulimit`.

### Step 1 — resolve the substitution

Only the repo path needs substituting — `%h` (a systemd specifier for this
user's home dir) covers the `~/.local/bin` `PATH` entry without a username
edit:

- **Repo path** — the absolute path to this checkout (`git rev-parse
  --show-toplevel`). Wrong path → systemd can't find `wrangler-start.sh`.
- **`~/.local/bin` on `PATH`** — load-bearing: without it `dispatch`/`resume`
  exit 127 because `claude` isn't found. The template's `%h/.local/bin` covers
  this already; don't drop it when substituting.
- **`AW_BIND_HOST=0.0.0.0` (only if you use devcontainer sessions)** — required so
  an in-container agent can reach the wrangler's own `/mcp`. The server binds
  loopback-only by default (`bindHost()`), so a container dialing out to
  `AW_DEVCONTAINER_HOST_ADDR` (the host-gateway address on native Docker Engine)
  can't reach it otherwise — uncomment the `Environment=AW_BIND_HOST=0.0.0.0` line
  the template already has, commented out, for exactly this. Note the
  shared-machine exposure trade-off (the control/MCP posture is
  localhost-advisory) — same as the macOS flow.

```
REPO=$(git rev-parse --show-toplevel)
UNIT_DIR="$HOME/.config/systemd/user"
UNIT="$UNIT_DIR/agent-wrangler.service"
```

### Step 2 — generate the unit

```
mkdir -p "$UNIT_DIR"
sed -e "s#/ABSOLUTE/PATH/TO/agent-wrangler#$REPO#g" \
    "$REPO/scripts/agent-wrangler.service.example" > "$UNIT"
```

### Step 3 — (re)load it

`daemon-reload` picks up a changed unit file; `enable --now` both enables it
for future logins and starts it immediately. Re-running these is safe for a
reinstall/repair — no separate bootout step needed the way launchd needs one:

```
systemctl --user daemon-reload
systemctl --user enable --now agent-wrangler.service
systemctl --user restart agent-wrangler.service
```

### Step 4 — verify it's actually serving

`enable --now` succeeding only means systemd accepted and started the unit,
not that the server came up cleanly. Confirm both the unit state and an HTTP
response on the configured `PORT` (read it from the unit file — default
`7777` in the template):

```
systemctl --user status agent-wrangler.service --no-pager | grep -E 'Active:|Main PID:'
PORT=$(grep -oP '(?<=^Environment=PORT=)\S+' "$UNIT")
curl -s -o /dev/null -w 'http %{http_code}\n' "http://localhost:$PORT/"
```

Success is `Active: active (running)` **and** `http 200`. Report both. If the
unit is active but curl fails, the server crashed on boot — read the journal:
`journalctl --user -u agent-wrangler -n 100 --no-pager`.

### Common failures (Linux)

- **Exit 127 in the journal** — `~/.local/bin` missing from `PATH`. Check the
  `Environment=PATH=` line in the unit matches the template.
- **`tmux` not found** — some distros don't ship it by default; `apt-get
  install -y tmux` / your distro's equivalent.
- **Unit won't load / fails to start** — validate the unit file first:
  `systemd-analyze verify "$UNIT"` catches a malformed unit the same way
  `plutil -lint` does for the plist.
- **Devcontainer sessions can't reach the host** — two independent things must
  both be true, not just one: (1) native Docker Engine (unlike Docker Desktop)
  doesn't resolve `host.docker.internal` on its own — either run the Docker
  daemon with `--add-host=host.docker.internal:host-gateway` available to
  containers, or set `AW_DEVCONTAINER_HOST_ADDR` (an `Environment=` line in the
  unit) to a host address the container can reach; **and** (2) the wrangler
  server itself must be listening on that address, not just loopback — it binds
  `127.0.0.1` by default, so uncomment `Environment=AW_BIND_HOST=0.0.0.0` in the
  unit (see Step 1). Fixing only the address the container dials without also
  widening the server's bind leaves `/mcp` unreachable either way.
