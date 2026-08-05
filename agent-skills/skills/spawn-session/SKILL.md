---
name: spawn-session
description: Use when you want to spin current work off into its own brand-new Agent Wrangler board session (not a sub-agent, not a fork) — how to call the spawn_session tool, write the handoff, and choose the right agent and model.
---

# Spawn a session

Use the `spawn_session` MCP tool to create a brand-new board session that carries
work forward independently. This is **not** a sub-agent and **not** a fork — it is
a full session on the board.

## Writing the handoff

Put the full handoff in `intent` — it is the new session's launch prompt. Include
what you have done, what the new session should do next, and the key files/paths
it needs. Do **not** write handoff context into task memory: memory is enduring
information about the task itself, not a channel for briefing another session.

## Choosing the agent and model

`agent` defaults to `claude`; pass `codex` to launch a Codex session instead.
`model` defaults to your own model when the new session runs the same agent. Pick
the model to fit the work:

**Claude** (`agent: "claude"`):
- `fable` — Fable 5, 1M context. Most capable; for the hardest, longest-running work.
- `opus` — Opus 5, 1M context. Default for substantial work.
- `sonnet` — Sonnet 5, 200K context. Faster/cheaper for well-scoped tasks.
- `sonnet[1m]` — Sonnet 5, 1M context, for large contexts at Sonnet cost.
- `haiku` — Haiku 4.5, 200K context. Fast and cheap for simple, mechanical work.

**Codex** (`agent: "codex"`):
- `gpt-5.5` — frontier; the default.
- `gpt-5.4` — everyday coding.
- `gpt-5.4-mini` — fast and cheap.

## Placement

The new session joins your current task by default — to keep it there, just omit
`into`. Only pass `into: "<taskId>"` when you have a real task id sourced from the
`list_tasks` tool, for a *different* task. An id not sourced from `list_tasks` does
not error: the session silently lands in Unassigned and has to be moved by hand.

## Nesting

Leave `nest` unset for almost every spawn — including handing off your own
follow-up work, fixing a bug you just found, or splitting off something closely
related to what you were doing. **"This is closely related to my task" is not a
reason to nest — it is not your call to make.** Only pass `nest: true` when
nesting is the deliberate, designed behavior for what you're doing (e.g. the
`issue-to-pr` skill's worker spawns), or the user explicitly asked for it.

**"Child" is the explicit ask — treat it as a keyword, not a vibe.** If the
user's own phrasing calls the new session a "child session," a "child of this
one," or asks you to "nest" it, that IS the explicit request the exception
above refers to: set `nest: true`. Don't rationalize it away as generic
phrasing for "spin off a new session" — "child" is literally the term the
`nest` parameter itself uses ("Tag the new session as a child of you"), so if
the user reaches for that word, match it.

If unsure, and the user hasn't used language like this, leave it unset — the
new session is a plain, independent top-level session on the board. If you do
get it wrong, `attach_session`/`detach_session` can reparent a session after
the fact — see the `session-hierarchy` skill.
