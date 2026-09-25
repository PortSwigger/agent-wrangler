# Board and sessions

This is the operational reference for controls that are easy to miss. See the README for installation
and product concepts.

## Dispatch a session

Choose **New session**, then select a task, folder, agent, and model. Leave the folder blank for a
scratch session; a new path is created at launch.

Optional launch controls include:

- **Git worktree:** create or adopt a worktree with an explicit or generated branch name.
- **Effort:** select a provider-supported reasoning level.
- **Auto-compaction threshold:** set the working-context budget.
- **Runtime:** launch Claude locally or inside the project's devcontainer. Codex currently runs on the
  host.
- **Workflow:** run the issue-to-PR autopilot in a fresh worktree.
- **Quick launch:** use a model button or `Command+1` through `Command+3`.

Discoverable sessions launched elsewhere also appear. They can be searched and adopted, but gain an
attachable terminal only after being resumed through the board.

## Organise work with tasks

Tasks are board columns for related sessions. Drag cards between tasks; moving a parent also moves its
nested descendants.

Each task also has:

- **TODOs:** add, complete, reorder, and collapse task-level work items.
- **Task memory:** shared Markdown that humans and agents can update across sessions or repositories.
- **Links:** Jira issues and pull requests shared by the task.
- **Focus, minimise, and activity sort:** controls for a busy board.
- **Archive task:** removes the task and live sessions while preserving resumable history.

Use task memory for durable decisions, the checklist for session progress, and `AGENTS.md` or
`CLAUDE.md` for repository instructions.

## Read a session card

Cards show status, model, cost, context budget, links, PR/CI state, checklist progress, and native
sub-agents. Nested children are compact rows unless **Full view** is enabled.

The **parent** controls board nesting and can change; the **spawner** records who launched the session
and cannot. **Attach to…** and **Promote to full session** change nesting, not launch lineage.

## Session actions

Right-click a card or open **Actions** to find:

- **Rename** the board label.
- **Fork** into a separate card, optionally with a divergent first prompt.
- **Peer review session…**, using the complementary provider when available.
- **View diff** for uncommitted, branch, and PR review.
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
- Task memory, checklists, child-card and Chat defaults, and completion sounds.
- PR auto-fix, Codex folder trust, and optional extraction of archive learnings into task memory.
- Extension installation, enablement, updates, and extension-specific settings.
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
