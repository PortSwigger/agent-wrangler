# Per-session visible checklist

**Status:** design, pending user review
**Date:** 2026-09-02
**Scope:** a new session-scoped checklist, visible in the board UI as a first-class panel,
readable and writable by both the human and the launched agent (via new MCP tools). Does not
touch the existing task-level TODO feature, and does not read or mirror either agent's own
internal planning tool.

## Terminology — three lists that must not be confused

| list | scope | who writes it | where it lives today |
|---|---|---|---|
| **task TODO** (existing) | one board *task* (`t_...`/`adhoc`), shared across every session under it | human only, via the UI | `task-store.js`, `taskStore.snapshot().todos` |
| **checklist** (this design) | one *session* (card id) | human (UI) **and** agent (new MCP tools) | new `checklist-store.js` |
| **native plan** (`TaskCreate`/`TaskUpdate` for Claude, `update_plan` for Codex) | one agent turn/session, private | agent only, for itself | the agent's own transcript/rollout — never read by the wrangler |

The three must stay visually and terminologically distinct. In particular:
**"todo" and "task" are both already taken** — "todo" by the task-level feature, "task" by
Claude's own tool (`TaskCreate`/`TaskUpdate`) *and* the board's own task/card concept
(`t_...` ids, `list_tasks`). This design therefore uses **"checklist"** throughout: store
`checklist-store.js`, WS messages `checklist-add`/`checklist-update`/`checklist-remove`/
`checklist-reorder`, MCP tools `add_checklist_item`/`update_checklist_item`/
`remove_checklist_item`/`list_checklist`, UI label "Checklist". Avoid the bare field name
`checks` anywhere in the store — `pr-status.js`/`notifier.js` already own that word for PR
check-run status (`checkStatus`, `diffCheckStatus`); use `checklist`/`checklistItems`.

## Problem

Today a session's plan is invisible to the human unless they read the pane. The agent's own
`TaskCreate`/`TaskUpdate` (Claude) or `update_plan` (Codex) calls are private scratch state,
rendered only inside the TUI, never surfaced on the board — so glancing at the board tells you
nothing about what a session is actually working through. The existing task-level TODO list
doesn't fill this gap: it's scoped to the *task* (shared across every session under it),
human-authored only, and has no agent-facing tool at all.

## Why not just surface the agent's own native plan (rejected)

Investigated and rejected. Findings, from real local transcripts on this machine:

- Claude Code no longer even calls it `TodoWrite` — every recent transcript uses
  **`TaskCreate`/`TaskUpdate`** instead, an **incremental** API (one call per item/status
  change, referenced by a per-session `task_id` that resets each session). The rename already
  broke a stale reference to `TodoWrite` inside this very repo (`archive-review-runner.js:118`,
  a disallowed-tools list for the archive-review sub-agent).
- Codex's `update_plan` is a **full-replace** API (resends the whole plan array every call) —
  different semantics from Claude's, and rare in practice (2 of 152 local rollouts use it at
  all).
- Neither is designed to be a durable, human-facing artifact: no priority, no notes, no
  timestamps, and nothing stops an agent from silently abandoning a plan mid-list.
- Mirroring either means a future CLI release can silently stop populating the panel with zero
  warning — this repo's CLAUDE.md is already full of "verified against the live binary, could
  change any time" landmines for exactly this class of undocumented internal-tool shape.

**Decision: the wrangler owns its own checklist, populated only through its own MCP tools.**
It is not synced with, and does not attempt to reconcile with, either agent's native planning
tool — they serve different audiences (private scratch work vs. a shared, visible list) and
are kept explicitly separate rather than merged.

## Design

### Data model

New store, `server/checklist-store.js` — a `schedule-store.js`/`task-store.js`-style object
with **synchronous** mutators (not load-mutate-save), since both the human (via WS) and the
agent (via MCP, itself served from the same process) can write concurrently and an `await`
between a read and its write is where they'd clobber each other. Persisted to
`~/.agent-wrangler/checklists.json` via `atomic-json.js`, covered by the existing per-`DATA_DIR`
instance lock.

```
{ "<cardId>": [
    { id, text, done, createdAt }
  ] }
```

- **Keyed on card id, never `liveSessionId`** — consistent with every other per-session field
  (per CLAUDE.md's mental-model bullet).
- No priority/notes/assignee for v1 — matches the existing task-todo's minimalism, and nothing
  in the motivating use case needs more than text + done.

### MCP tools

Four new tools, resolved from **the caller's own identity** (`extractCaller`, the same
`X-AW-Session` header / Codex Bearer token every other wrangler tool uses) — **no `session`
parameter**. This is deliberate and load-bearing: if the tool took an explicit session id, a
launched agent could write into a sibling session's checklist, either by hallucinating an id or
by picking one off `list_sessions`. A session can only ever touch its own checklist.

- `add_checklist_item(text)` → `{ id }`
- `update_checklist_item(id, { text?, done? })`
- `remove_checklist_item(id)`
- `list_checklist()` → `[{ id, text, done, createdAt }]`

Granular, one-item-per-call — not a single `set_checklist(items[])` replace-call. With the
human able to edit concurrently through the UI, a replace-call risks the agent silently
clobbering an edit the human made moments earlier between the agent's last read and its next
write; granular ops (mirroring the UI's own `todo-add`/`todo-edit`/`todo-delete` WS shape, and
Claude's own incremental `TaskCreate`/`TaskUpdate` style) mean an agent call and a human click
each touch one item and can't stomp on the other's unrelated edits.

**Registration.** Per CLAUDE.md: a new MCP tool is invisible to a launched agent until it's in
**both** `server/mcp/tools/index.js`'s `TOOLS` and `server/mcp/client-config.js`'s
`ALLOWED_TOOLS`. Since `--allowedTools` is baked into launch argv, **a session already running
when this ships does not get these tools until it is resumed or relaunched** — accepted for v1
(the same gap `entry.mailCapable` existed to close for the mailbox; no equivalent stamp is
being added here, since there's no delivery-correctness reason to track it — worst case, an
already-running agent simply can't call the tool yet).

### Getting the agent to actually use it

Two mechanisms, deliberately split by weight, per CLAUDE.md's "most skills should have none"
guidance for the always-on nudge:

1. **A minimal, always-on nudge** (force-injected the same way the mandatory `task-memory`
   skill's `WRANGLER.md` sidecar is, via `--append-system-prompt`/`developer_instructions`) —
   a couple of sentences: this session has an optional checklist tool for surfacing visible
   progress to the human; keep your own private planning tool for internal scratch work; see
   the `checklist` skill for guidance. **No usage instructions live in the nudge itself.**
2. **A discoverable skill** (`agent-skills/skills/checklist/SKILL.md`, following the existing
   `mail`/`session-hierarchy` pattern) carries the actual guidance: when an item is worth
   adding (durable, human-relevant progress — not a play-by-play of every tool call), how to
   phrase items, when to mark done, and the explicit "this is not the same list as your own
   internal plan, and the two are never synced" note.

This keeps the per-session token cost of the nudge itself tiny while putting the real
guidance where an agent can load it deliberately — the same split the mailbox design uses for
its own "read your mail" norm (nudge = pointer, skill = substance).

### UI

New panel, a sibling `<div id="checklist">` inserted in the DOM between `#panel` (the status
pane) and `#term-wrap`/`#chat-wrap`, inside `<aside id="sidebar">`. Styled like `#panel`:
bordered, **not** `flex: 1` (so it doesn't compete with the terminal/chat pane for space),
own `--card-bg` backdrop.

- Inline add (text input + Enter), inline edit (click text), checkbox toggle, delete (×),
  drag-to-reorder — the same interaction set the existing task-todo rows already have
  (`public/cards.js` `todoRowHtml`/`todoZoneHtml`, `public/app.js`'s todo drag-and-drop), applied
  to the new panel instead of a task tile's TODO zone.
- New WS messages: `checklist-add`, `checklist-update`, `checklist-remove`, `checklist-reorder`,
  handled in a new `server/control/handlers/checklist.js`, mirroring `control/handlers/todos.js`.
- **Patch-in-place render**, mirroring `renderPanel`'s pattern (keep the persistent element,
  patch state class + body) — the ~4s graph poll must not reset scroll position or restart any
  CSS transition on every rebuild.
- Untrusted-content rule applies: item text may be agent-written — render via `textContent`,
  never `innerHTML` (same rule as the diff view and chat view).
- When the feature is enabled (see *Optionality*) but a session's checklist is empty, the panel
  still renders with just the "+ Add" affordance, so a human knows the feature exists on this
  session rather than the panel silently vanishing.

### Optionality

`config.json` flag `checklistEnabled`, **default `true`** — discoverability was the deciding
factor: a default-off flag behind a config edit means most people never find out the feature
exists. When off (either the global flag, or — out of scope for v1, see *Explicitly rejected*
— a future per-session override): the MCP tools are not registered/allow-listed, the nudge is
not injected, and the UI panel is not rendered for any session.

### Lifecycle

- **Resume**: checklist persists — keyed on card id, same as everything else in `mappings.json`.
- **Archive**: checklist persists in the store, reappears if the session is resumed. Archive is
  "set aside," not deletion, consistent with how the mailbox and every other card-id-keyed
  field behaves.
- **Fork**: the fork gets a **new card id and starts with an empty checklist** — no copy-on-fork
  logic. A fork is a new exploratory branch; carrying over a possibly half-done, possibly
  irrelevant list from the parent adds complexity for a benefit nobody asked for. (Note this
  mirrors the mailbox design's own "fork starts empty" decision for unread mail.)
- **Purge**: deleted only when the card itself is purged from `mappings.json`, never before.

## Testing

- **Unit** — `checklist-store.js`: add/update/remove/reorder, keyed correctly on card id,
  synchronous mutation (no interleaving race between a WS write and an MCP write).
- **MCP tools** — each of the four resolves the target session from caller identity, never from
  an argument; a call with no resolvable caller is rejected; assert all four appear in *both*
  `TOOLS` and `ALLOWED_TOOLS` (the silent-failure mode CLAUDE.md calls out).
- **UI** — patch-in-place render does not reset scroll or reorder mid-drag on a poll tick; item
  text renders via `textContent` (regression test analogous to the diff-view/chat-view rule).
- **Lifecycle** — fork starts empty and the parent's checklist is untouched; archive retains and
  resume restores; purge removes the entry.
- **Optionality** — `checklistEnabled: false` registers no MCP tools, injects no nudge, renders
  no panel.

## Documentation to update

- `CLAUDE.md` — new bullet: checklist store's keying (card id), the no-`session`-param MCP
  design and why, the two-place tool registration reminder, fork/archive/purge behaviour.
- New `agent-skills/skills/checklist/SKILL.md` — usage guidance (see *Getting the agent to
  actually use it*).
- `server/mcp/tools/*checklist*.js` descriptions — state plainly that this is independent of the
  agent's own native planning tool, and is meant for durable, human-relevant progress items,
  not a mirror of every internal step.

## Open decisions for review

1. **Per-session enable/disable override**, beyond the global flag — deferred (see *Explicitly
   rejected*); revisit if the global default proves wrong for some sessions in practice.
2. **Whether already-running sessions need a capability stamp** (like `entry.mailCapable`) to
   track which have the new tools — decided **no** for v1, since nothing breaks silently if an
   older session simply lacks the tool until its next resume.

## Explicitly rejected

- **Mirroring/scraping the agent's own native plan tool** (`TaskCreate`/`TaskUpdate` or
  `update_plan`) instead of a new MCP-backed list — see *Why not just surface the agent's own
  native plan*. Already proven brittle by the `TodoWrite`→`TaskCreate` rename.
- **A single full-list `set_checklist(items[])` MCP call** — clobbers concurrent human edits;
  granular per-item ops chosen instead.
- **Default-off config flag** — rejected because a feature nobody discovers might as well not
  exist; default-on trades a small amount of unwanted-panel noise for actual usage.
- **Per-session toggle for v1** — adds a creation-time-stamp mechanism (like
  `entry.childFullView`) for a need not yet demonstrated; the global flag covers "I don't want
  this at all," and per-session granularity can be added later without breaking the data model.
