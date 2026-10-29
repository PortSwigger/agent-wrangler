# Board and sessions

This is the operational reference for controls that are easy to miss. See the README for installation
and product concepts.

## Dispatch a session

Choose **New session**, then select a task, folder, agent, and model. Leave the folder blank for a
scratch session; a new path is created at launch. The folder starts filled in from the task's
existing sessions, or from **Settings → Sessions → Default folder for new sessions** when the task
has none.

The dialog places task controls on the left and the model picker on the right, stacking them on
narrow screens. **Intent / first prompt** starts at twelve rows and can be resized vertically.
**Schedule a session** uses the same layout, with timing and action controls on the task side.
Choose **Existing session** to show the target session and optional message instead of launch controls.

Open **Advanced options** below Branch to find **Sandbox** (Codex) or **Permissions** (Claude).
The section is supplied by the selected agent; agents without declared modes show no section.

| Agent | Default | Other choices |
| --- | --- | --- |
| Codex | **Locked to worktree** — workspace-write, never ask, network enabled | **Auto-approve** — a reviewer model can approve leaving the sandbox; **Full access** — bypass sandbox and approvals |
| Claude | **Auto** — automatic permission checks | **Accept edits** — accept file edits and check other actions; **Bypass** — skip Claude permission checks |

Claude permissions are not an OS sandbox. **Also writable** adds existing folders using the folder
picker; Full access and Bypass hide these controls and omit their grants. Extra host folders require **Local**.
The **Launches** line quotes paths and previews the adapter's flags. Codex labels this as a core preview:
an extension such as **aw-codex-policy** can override it through its controls in **Advanced options**.
After launch, the session details show the resolved Codex policy, flags and winning source.

Your browser remembers the last selected mode separately for each agent. A session saves its own mode
and applicable folders: resume, relaunch and fork retain them after a server restart, independently of
browser preferences. Legacy sessions use Locked to worktree for Codex and Auto for Claude. Schedules
save explicit choices; editing an older schedule uses the agent default. Runtimes that supply their
own launch command explain why Claude's Accept edits and Bypass are unavailable. The manual, plan
and dontAsk modes are available only through `spawn_session`'s `permission_mode` argument.

The model section plots measured quality against cost per task on a log scale. Drag the slider or
use its arrow keys to move through the quality/cost curve, cheapest to best. Click a chart point to
choose any available front setting, including points that earn their place only by being faster;
these hide the slider handle. Quality, Cost and Time bars show the selected setting, and the verdict
compares all three against settings your installed agents offer. Red rings mark unavailable settings;
click a ring to see what is missing. A red selected diamond and **Below the front** verdict name an
available setting that is at least as good.

Dots and slider stops share stable colours for each provider/model, named in the key below the
chart. Hover or focus a dot or stop to read its model and effort without selecting it; activate it
to select. Selection has an outer ring, unavailable settings have hollow rings, and below-front
picks have a diamond and a written warning, so the states remain distinct without colour.

The dialog remembers your last explicit agent, model and effort in this browser, including
**Auto**, when you use the slider, chart, **Any model** or a quick-launch button. Cancelling,
closing and reloading keep that choice. Saved schedules and values supplied by extensions take
precedence without replacing your preference; forks inherit their source session's settings.
If a remembered agent or model is unavailable, the dialog uses a live default. Unsupported
remembered effort falls back to **Auto**.

Expand **Any model** for the agent/model and effort dropdowns. **Auto** uses the effort reported by
the agent; without a reported effort or benchmark row, the pick is unscored. Source credit sits under
the chart. **Advanced options** starts collapsed and holds sandbox or permission modes, **Also writable**
folders, the launch preview, auto-compaction and runtime controls.

Optional launch controls include:

- **Also writable:** use the square **+** button beside **Also writable** to grant a local Claude or Codex session access to more existing folders. Browse or type each path, and remove rows you no longer need. Grants persist across resume and fork and are saved with scheduled launches. The main folder remains the working directory. Devcontainer and extension runtimes disable these extra host folder controls; switching back to Local restores your selections.
- **Git worktree:** create or adopt a worktree with an explicit or generated branch name.
- **Effort:** select a provider-supported reasoning level.
- **Auto-compaction threshold:** set the working-context budget.
- **Runtime:** launch Claude locally, inside the project's devcontainer, or on a runtime an enabled extension adds. Codex currently runs on the
  host. **Settings → Sessions → Default runtime for new sessions** picks which one is pre-selected; a runtime that is
  no longer offered or can't run the chosen agent falls back to Local.
- **Workflow:** run the issue-to-PR autopilot in a fresh worktree.
- **Quick launch:** use a model button or `Command+1` through `Command+3`. An extension can replace these with its own quick launches (see [extensions](extensions.md)); its buttons and shortcuts then take their place.

Discoverable sessions launched elsewhere also appear. They can be searched and adopted, but gain an
attachable terminal only after being resumed through the board.

## Organise work with tasks

Tasks are board columns for related sessions. Drag cards between tasks; moving a parent also moves its
nested descendants.

Each task also has:

- **TODOs:** add, complete, reorder, and collapse task-level work items. TODOs are an optional builtin extension (`todos`, on by default); turning it off in Settings → Extensions removes the zone, tools, and skill without deleting stored TODOs.
- **Task memory:** shared Markdown that humans and agents can update across sessions or repositories. It is the built-in `task-memory` extension (Settings > Extensions); turning it off removes the memory button, the `AW_TASK_MEMORY` variable, the extra directory grant and the skill, and keeps the notes on disk.
- **Links:** Jira issues and pull requests shared by the task.
- **Focus, minimise, and activity sort:** controls for a busy board. Minimise is in both the header menu and the tile's right-click menu.
- **Archive task:** removes the task and live sessions while preserving resumable history.

Use task memory for durable decisions, the checklist for session progress, and `AGENTS.md` or
`CLAUDE.md` for repository instructions.

Minimised tasks appear as pills in the bottom tray. Click one to restore it, Shift-click one to
focus it, or choose **Restore all**. Core keeps at least one task visible, and newly created tasks
join the visible board.

An enabled extension can own this strip and replace **Minimise** in both task menus, including
Unassigned, and add an action beside **New task** in the blank task-view right-click menu.
Its strip stays visible even when every task is shown; **Focus** remains available.
Enabling a tray extension preserves tasks you already minimised. Disabling it returns the core tray
and **Minimise** entries with the current view intact. If a tray contribution fails, core falls back
to another registered tray or its own controls.

## Read a session card

Cards show status, model, cost, context budget, links, PR/CI state, checklist progress, and native
sub-agents. Nested children are compact rows unless **Full view** is enabled. Nesting has no depth
limit: a child's own children sit indented beneath it on the same spine, stepping in a level each
until the indent stops growing after four. Attaching a session moves its children with it.

A Codex card's working or idle status comes from Codex's own turn-end notification plus its session log,
with the terminal screen as a tie-breaker. Wrangler sets `notify` when it launches Codex and forwards the
event to any `notify` command already in `~/.codex/config.toml`. The latest turn end for each thread is
kept under `~/.agent-wrangler/codex-turns/`.

The **parent** controls board nesting and can change; the **spawner** records who launched the session
and cannot. **Attach to…** and **Promote to full session** change nesting, not launch lineage.

## Session actions

Right-click a card or open **Actions** to find:

- **Rename** the board label.
- **Fork** into a separate card, optionally with a divergent first prompt.
- **Peer review session…**, using the complementary provider when available.
- **View diff** for uncommitted, branch, and PR review.
- **Copy reference** (right-click only) to paste a session into another agent's chat; the agent reads it with `read_session_transcript`.
- **Open terminal** for a separate shell in the session directory.
- **Snooze** until a preset or custom time, optionally with a wake-up note.
- **Mark read / unread** to manage attention.
- **Auto-fix PR checks** and **Auto-merge when checks pass**.
- **Restart** while retaining the conversation.
- **Attach**, **promote**, or toggle **Full view** for child sessions.
- **Archive** the session.

Extensions may add more actions to this menu.

## Chat, terminal, and files

The side pane switches between transcript-backed Chat and the live terminal. Chat supports multiline
prompts, images, Markdown previews, drafts, model switching for idle Claude sessions,
interrupt-and-edit, context display, and suggested prompts. Use Terminal for permission prompts,
streaming output, or direct TUI control.

Rendered Markdown never loads a remote image by itself: an image an agent writes is shown as a link
to it, so opening a message or file sends nothing to that site until you click.

Paste or drop an image into the Chat composer, the agent terminal, or the new-session dialog's
**Intent / first prompt** box (local launches; the session starts and then receives the images with
its first prompt): screenshots, Copy Image from a
browser or Slack, image files copied in Finder, a selection containing images, or a `data:` image
URL. BMP and other formats the browser can draw are converted to PNG before upload; HEIC and TIFF are
converted to PNG by the server, which needs macOS. An image on another site is fetched by your browser
only if that site allows it; otherwise use Copy Image instead.
In the new-session dialog, each attached image's chip shows a thumbnail; hover over it or focus it
for a larger preview. While a preview is open, Escape closes the preview rather than the dialog.

When a message resumes a dormant Codex session, Wrangler waits for its terminal
input to be ready, including during an active turn. If a draft, dialog or unreadable
terminal prevents delivery, the chat reports the uncertainty and keeps your message
available to retry.

**Open terminal** creates an independent shell; it does not replace or interrupt the agent terminal.

## Snooze, suspend, archive, and search

- **Snooze** hides a session until a chosen time. When automatic suspension is enabled, snoozes of at
  least one hour mark the process for suspension once work is idle, terminals are detached, and
  background shells have exited.
- **Suspend** removes the tmux process but keeps the card resumable. Idle sessions suspend after the
  configured interval.
- **Archive** stops the session and removes it from the board, but keeps it searchable and resumable.
- **Search** covers board, archived, and off-board conversations. Filter by speaker, provider, task,
  status, or age, then resume, fork, restore, or delete.

Worktree and devcontainer cleanup is withheld while another session uses the directory or container.

## Settings worth knowing about

**Settings** has Appearance, Sessions, Automation, Extensions, and Shortcuts tabs, covering:

- Theme, terminal side, terminal font size, and chat font size.
- Child-card and Chat defaults, and the default folder for new sessions.
- PR auto-fix, Codex and Claude folder trust, and optional extraction of archive learnings into task memory.
  Claude folder trust covers scratch sessions and worktrees of a repo you already trust in Claude: the
  worktree inherits the repo's trust (just that worktree, never its parent folder), so a job or
  auto-session in a worktree doesn't stall on "Do you trust this folder?". A worktree of an untrusted
  repo still asks.
- Extension installation, enablement, updates, and extension-specific settings. Sounds offers
  shared audio cues, uploaded audio files, and previews. The per-session checklist is a builtin
  extension, so its on/off switch lives here (an older `checklistEnabled: false` is carried over
  automatically).
- Board-navigation axis preference and the complete keyboard-shortcut reference.

## Keyboard shortcuts

The complete list is under **Settings → Shortcuts**. Common shortcuts are:

| Shortcut | Action |
| --- | --- |
| `Control+Command+N` | New session |
| `Control+Command+T` | Toggle a plain shell terminal |
| `Control+Command+B` | Fork the selected session |
| `Control+Command+P` | Launch a peer-review session |
| `Control+Command+G` | Toggle the diff panel |
| `Control+Command+S` | Snooze or unsnooze |
| `Control+Command+A` | Label cards for keyboard jump |
| `Control+Command+,` | Open Settings |
| `/` | Open Search and focus its input |
| `Command+Enter` (dispatch dialog) | Launch the session |
| `Command+1`–`3` (dispatch dialog) | Quick-launch with the first, second or third model |

Shortcuts added by enabled extensions are listed under each extension's name in
**Settings → Shortcuts**.
