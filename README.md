# Agent Wrangler

Agent Wrangler is the command center and control plane for every Claude Code **and OpenAI Codex**
session you run — one board to dispatch, monitor, and step straight into any session's live terminal.
It's also the channel agents use to coordinate with each other: spawning other agents and whole
multi-agent workflows, handing off work, and messaging one another directly — so a fleet of agents can
get on with it without you relaying every message by hand. It runs entirely on your own machine, under
your control. Codex is offered as an agent automatically when the `codex` binary is on your `PATH`;
otherwise it behaves exactly as a Claude-only board.

## Highlights

- **One board for every session** — dispatch, monitor, and jump into any Claude Code or Codex
  session's live terminal from a single screen, whether you launched it here or elsewhere.
- **A control plane for agents, not just for you** — sessions can spawn other agents and orchestrate
  whole multi-agent workflows, hand tasks off to each other, and send one another messages directly —
  real agent-to-agent coordination, not a one-way dashboard.
- **Visualize your whole fleet, your way** — every agent and its sub-agents rendered on the board,
  grouped under the tasks you assign them to, nested under parent sessions, or collapsed into workflow
  boxes — organize it however makes sense to you.
- **Cost and status at a glance** — per-session and sub-agent spend, live status colours, and a
  needs-you flag the moment a session is blocked on you.
- **Hands-off workflows** — hand a session a Jira key, GitHub issue, or free-text task and let it
  run an issue → PR autopilot with no gates, in its own git worktree.
- **Scheduling** — one-off or recurring sessions and nudges — agents can even schedule their own
  wake-ups — evaluated in your timezone, safe across restarts.
- **Idle suspend** — reclaims RAM from idle sessions automatically; resume any dormant card with
  one click, conversation intact.
- **Themeable** — built-in dark/light plus drop-in custom styles.

## Requirements

- macOS, Node.js >= 20
- `tmux` (sessions launched through the app run inside named tmux sessions) — `brew install tmux`
- `gh` (optional — PR auto-attach, check-watching, and auto-merge shell out to it; run
  `gh auth login` once so it's authenticated)

## Run

```bash
npm install
npm start          # serves http://localhost:7878 and opens your browser
```

`npm start` auto-installs after a pull that changes dependencies, so you never
need to remember `npm install`.

Environment variables:

- `AW_PORT` (or legacy `PORT`) — port to listen on (default `7878`)
- `AW_DATA_DIR` — state directory (default `~/.agent-wrangler`); set it with a distinct `AW_PORT` to run an isolated instance
- `AW_OPEN_BROWSER=1` — auto-open the board in a browser on startup (default: off; the legacy `AW_NO_OPEN=1` still suppresses)
- `AW_DEFAULT_MODEL` — model pre-selected in the dispatch dialog, by value (e.g. `fable`, `opus`, `opusplan`, `sonnet`, `sonnet[1m]`, `haiku`); unset or unrecognised leaves the built-in default (`opus`)
- `AW_JIRA_BASE_URL` — Jira browse URL prefix a bare issue key is appended to (e.g. `https://yourcompany.atlassian.net/browse/`); unset by default, so a bare key renders as plain text until this or the per-install `jiraBaseUrl` config value is set

### Run as a background service

To keep it always-on, run it under launchd.

**Recommended:** in Claude Code, just ask for the `setup-wrangler-service` skill (e.g. "set up the
wrangler as a service"). It fills in the plist template, loads the launchd agent, and verifies the
server is actually serving before reporting success — no manual steps.

To do it by hand instead, copy
`scripts/net.portswigger.agent-wrangler.plist.example` to
`~/Library/LaunchAgents/net.portswigger.agent-wrangler.plist`, fill in the path and username
placeholders, then load it:

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/net.portswigger.agent-wrangler.plist
```

The agent invokes `scripts/wrangler-start.sh`, which resolves Node via nvm, pins a UTF-8 locale so
tmux renders Unicode correctly, and auto-installs after a dependency change. Restart it after changes
with:

```bash
launchctl kickstart -k gui/$(id -u)/net.portswigger.agent-wrangler
```

**Sessions can't `ls`/`cp` files in Downloads, Documents, Desktop, etc.** This is macOS's file-access
sandboxing (TCC), and it targets the `tmux` binary, not your terminal app — because the wrangler's tmux
server daemonizes and reparents under `launchd`, so there's no Terminal.app/iTerm2 in its process
ancestry to grant instead. **Full Disk Access is the only fix that actually works here** — the narrower
"Files and Folders" permission can't be manually populated; it only lists apps macOS has already shown
a real consent prompt to (that's how Terminal.app gets Desktop/Downloads access the first time you `cd`
there), and a headless daemon with no window/Dock presence can't display that prompt, so it never gets
an entry there. Fix: System Settings → Privacy & Security → **Full Disk Access** → **+** → Cmd+Shift+G in
the file picker → paste the resolved path (`readlink -f "$(which tmux)"`, since Homebrew's `tmux` is a
version-pinned symlink into `Cellar/` that moves on every `brew upgrade tmux`, so re-add the grant after
an upgrade) → enable it.

Know what this actually grants: Full Disk Access also covers Mail, Messages, Safari data, Time Machine
backups, and other apps' containers — well beyond Downloads — and it applies to *every* session the
wrangler ever runs (one shared tmux server, not per-session), present and future, since anything running
in any pane inherits it. It doesn't grant new capability over what your own logged-in account can
already do via Finder — TCC is a consent gate on top of normal Unix permissions, not a privilege
boundary — but it does remove that consent step for any command run inside a wrangler session, including
autonomous/unattended agent runs. Grant it deliberately, not as a reflex.

The grant only applies to *new* processes, so the tmux server needs restarting (`tmux -L <socket>
kill-server`, or just kill the process) — this kills every live session on that socket; mapping entries
survive and each card just needs a manual Resume.

## How it works

- **State** is read live from `~/.claude`: `daemon/roster.json` and `sessions/*.json` (watched for
  instant updates), enriched with per-session cost and sub-agents parsed incrementally from the
  transcript under `~/.claude/projects/`.
- **Dispatch** ("+ New session") starts `claude` inside a detached tmux session named `cc_<short>`.
  The app records the `sessionId ↔ tmux` mapping in `~/.agent-wrangler/mappings.json`.
- **Jump in** attaches that tmux session in-browser via xterm.js over a WebSocket (`node-pty`
  running `tmux attach`).
- **Sessions not launched through the app** appear as read-only "external" entries — visible with
  status and cost, but without an attachable terminal until relaunched through the dashboard.

## Workflows (issue → PR autopilot)

Tick **Workflow (issue → PR autopilot)** in the dispatch dialog to launch a hands-off
run: give it an issue — a Jira key (`ENT-1234`), a GitHub issue (URL or `#N`), or a
free-text task — and one Claude session takes it all the way to an open pull request
with no human gates. It always runs in a fresh git worktree, so you can fire a whole
fleet in parallel.

The procedure lives in an in-repo skill, **`issue-to-pr`** (`skills/issue-to-pr/`; the
wrangler just adds the launch toggle, a phase chip, and the `workflow_phase` tracking
tool). The card shows the live phase — `plan → build → verify → PR → done` (labels are
capped at 6 chars to fit the chip) — and reuses the normal terminal states: the auto-attached PR + green CI dot
means *ready to review*; a genuine block flips the card to **needs-you** (red) with a
`failed` chip, where it stops and asks you a question.

**No setup needed:** the wrangler loads the skill via `--plugin-dir` on every Workflow
launch, resolving it from its own install — so it works from any worktree and against
any target repo without a `~/.claude/skills` symlink.

## Scheduled sessions

The **clock button** on the nav rail opens the **Schedules** panel, where you can have
the board run an action automatically — once at a chosen time, or on a recurring
cadence. A schedule is **a saved action + a "when"**, and the action is one of two:

- **New session** — dispatch a brand-new session. Carries the same payload as the
  New-session dialog (folder, prompt/issue, model, task, worktree, and the **Workflow**
  autopilot toggle), so each fire is a normal local board session you can attach to, see
  needs-you/ready on, and assign to a task — not a throwaway cloud run.
- **Existing session** — act on a session already on the board, with an optional
  message. The board decides what that means when it fires: if the session is **dormant**
  it's **resumed** (delivering the message as its first prompt — e.g. "every weekday
  09:00, resume my review session and tell it to check overnight CI"); if it's **live**
  the message is **injected into its terminal** (a recurring nudge). With no message, a
  dormant session is just woken and a live one is left alone.

- **New / Edit** reuses the dispatch dialog with an added **When** section and an
  **action selector**: pick **One-off** (a single date & time), **Daily** (a time), or
  **Weekly on…** (a time + a set of weekdays). Recurring cadences compile to a cron
  expression evaluated in your timezone; a one-off stores an absolute instant.
- Each row shows its cadence, what it does, and its next fire; toggle it on/off, **Run
  now**, edit, or delete in place. The panel updates live.
- **Catch-up is safe across restarts:** a recurring slot missed while the server was
  down fires **once** on the next check (never a backlog), and a one-off more than 12 h
  overdue is marked *missed* rather than fired.
- A recurring schedule that wants a worktree always uses a fresh auto-named one (so
  repeated fires never collide on the same branch).

Agents can create schedules too, via the **`schedule_session` MCP tool** — including
scheduling their own wake-up ("resume me at 3pm to check the deploy"): an existing-session
action's target defaults to the calling session.

Scheduling adds a dependency (`cron-parser`); a running background service needs a
**restart** to pick it up (the startup dependency sync handles the install).

## Idle suspend & resume

A live `claude` session holds ~0.5–0.8 GB of RAM even when idle. To reclaim it, the
board **suspends** idle sessions: it tears down their tmux but keeps them on the
board as dormant, one-click-resumable cards (clicking a dormant card resumes it in
place and re-attaches — the conversation is restored from the transcript).

- **Automatic:** a session idle for **8 hours** is suspended. Tune or disable this in
  `~/.agent-wrangler/config.json` with `"suspendIdleHours": <n>` (`0` disables the
  timer entirely). The value is re-read live — no restart needed.
- **Manual:** right-click a session → **Suspend**, or **snooze** it for ≥ 1 hour
  (a snooze that long also frees its RAM; a shorter snooze just hides it).
- **Never auto-suspended:** a session that is working, awaiting you, has a terminal attached, or
  is running a foreground command.
- **Caveat:** a *detached background* process (e.g. a `run_in_background` dev server)
  under an otherwise-idle session is killed when the timer fires. If you rely on one,
  set `suspendIdleHours: 0`, keep a terminal attached, or don't leave it idle that
  long. (Foreground commands are safe — they read as working.)

After a reboot every session is dormant; nothing is bulk-resumed — bring back the
ones you want with a single click.

## Status colours

- red — needs you (e.g. a permission prompt)
- green — working
- grey — idle / unknown

## Layout

Two views, toggled from the nav rail: **Tasks** (the default board — sessions grouped under the tasks
you assign them to, plus an Ad-hoc lane) and **History** (archived sessions). A nav-rail button opens
**find & attach**, which brings an on-disk session onto the board as a forked, resumable copy.

## Themes

A palette button on the nav rail switches between built-in **dark** and **light** and any drop-in
custom styles. A custom style is a folder under `styles/<id>/` with a `theme.json` manifest — a name,
an icon, a `dark`/`light` base, and CSS-variable overrides — plus optional assets like a wallpaper for
translucent themes. The server compiles each manifest to CSS-var overrides and serves it through a
manifest-gated asset route (raw files are never exposed). See `styles/jurassic-park/` for a worked
example. All UI colours — including the xterm terminal — flow through these variables, so both
built-in and custom styles re-theme the whole app live.

## License

Apache License 2.0 — see [LICENSE](LICENSE).
