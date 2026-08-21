---
name: session-hierarchy
description: Use when a session needs to discover its own place in the Agent Wrangler hierarchy — its session id, who spawned it, whether/what it's nested under, and its task — via env vars and MCP tools, no filesystem access needed. Also use when deciding whether "parent" means board-nesting or launch lineage.
---

# Session hierarchy

Agent Wrangler tracks **two different, independently-nullable relations** for a
session. Don't conflate them — either can be set with the other null:

- **`parent`** (`parentSession`) — who this session is nested under on the
  board. This is what "**parent**"/"**child**" mean in Agent Wrangler's own
  vocabulary. It's opt-in: set at spawn time via `spawn_session`'s `nest: true`
  (see the `spawn-session` skill), or later via `attach_session`/
  `detach_session`. A session can be re-nested after launch, so this can change
  over a session's lifetime.
- **`spawnedBy`** — who actually called `spawn_session`/`spawn_workflow` to
  launch this session. Set once, at launch, only for that launch path. A
  session dispatched directly from the board UI has `spawnedBy: null` even if
  it's later nested under something.

A session asking "what is my parent" wants `parent`, not `spawnedBy`. A session
asking "who spawned me" wants `spawnedBy`, not `parent`. They frequently agree
(a `spawn_session` call with `nest: true` sets both to the same id) but often
don't — e.g. a board-dispatched session that's later attached under an
orchestrator has a real `parent` and a null `spawnedBy`.

## Fastest path: the env var (zero tool calls)

If you were launched via `spawn_session`/`spawn_workflow`, your spawner's
session id is already in your environment as `AW_SPAWNER_SESSION_ID` — no tool
call needed. This is static at launch: it reflects `spawnedBy`, never `parent`,
and won't update if you're attached/detached afterward. It's also simply
**absent** if you were dispatched from the board UI rather than spawned by
another session — that's expected, not an error; fall through to the tool
below.

## Definitive path: `get_session_info`

Call the `get_session_info` MCP tool (no arguments — it answers for the calling
session only) to get both relations, each walked to root:

```
get_session_info()
```

Returns:
- `sessionId`, `label`, `task` — your own identity and task.
- `parent` (immediate `parentSession` id, or `null`), `parentLabel` (that
  session's name, or `null`), and `parentChain` (your nesting ancestors,
  nearest first, up to root — each with its own id/label/task).
- `spawnedBy` (immediate id, or `null`), `spawnedByLabel` (that session's
  name, or `null`), and `spawnerChain` (your launch-lineage ancestors, nearest
  first, up to root).

This is the only path that's guaranteed correct after a re-nesting — the env
var is frozen at launch, this tool reads live state.

**When telling the user about your parent or spawner, use `parentLabel`/
`spawnedByLabel`, not the raw `parent`/`spawnedBy` id** — but see "Naming a
session for the user" below: a label alone is not always enough either.

## Looking up ANOTHER session's lineage

`get_session_info` only answers for the caller. To check another session's
`parent`/`spawnedBy` (but not its full chain), use `list_sessions` — every row
now carries `parentSession` and `spawnedBy` alongside the existing id/label/
task/status fields. Those two are still bare ids with no label sibling on the
row itself; look the id up against another row's `sessionId` in the same
result to name it.

## Naming a session for the user

A raw session id (`sessionId`/`parent`/`spawnedBy`/…) means nothing to a
human — always prefer the label. But **a label is not guaranteed unique**:
it's frequently derived from the session's own launch intent (see
`sessionLabel` in `state-reader.js`), so a session and a child it spawned to
do "the same" nominal thing can easily end up sharing the identical displayed
label. Real example seen on a live board — two unrelated rows both labeled
"Haiku about squirrels" (a root session and its own child):

```
Haiku about squirrels   idle   root, spawned "Haiku about squirrels" child
Haiku about squirrels   idle   child of the above
```

Label-only output like this is genuinely ambiguous to the user — there is no
way to tell the two rows apart. **Whenever more than one session is in view
at once** (a list, a table, a comparison — "the session that did X" vs "the
one that did Y"), pair the label with a short id disambiguator:

```
(<first 8 chars of the id>, "<label>")
```

e.g. `(03f68d2a, "Story about Richard the sausage")`. A single, unambiguous
reference to "the session" when only one is in play doesn't need this — the
label alone reads fine. The full id is still what every tool call actually
needs; only DISPLAYED text truncates it.

## Known limitations

- `parentChain`/`spawnerChain` only include sessions still known to the
  wrangler (mapped, live or archived). A chain link pointing at a session no
  longer tracked stops there rather than erroring.
- Neither chain is deduplicated against the other — a session can appear in
  both if `parent` and `spawnedBy` happen to trace through the same ids.

## Falling back to the raw file

If the tools are ever unavailable, both relations live in
`~/.agent-wrangler/mappings.json`, keyed by session (card) id: `parentSession`
and `spawnedBy` (either may be absent, not just `null`, on older entries).
Walk either field by hand the same way — following it session-to-session until
an id isn't a key in the file, which is root.
