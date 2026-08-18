---
name: advisor
description: Use when you want a second opinion from a stronger model mid-task — before a non-obvious design decision, when stuck, or before declaring the work done — by spawning a short-lived advisor session and consulting it with send_message.
---

# Advisor

Claude Code has no built-in equivalent of the
[Claude API's advisor tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/advisor-tool)
— a stronger model that a faster one can consult mid-generation for a plan or a
course correction. This skill gives you the same pattern with two Agent Wrangler
tools: `spawn_session` to bring up the advisor, `send_message` to consult it.

## When to consult

- Before committing to a non-obvious design decision or a plan for a hard task.
- When you're stuck: an error keeps recurring, your approach isn't converging, or
  a result doesn't fit what you expected.
- Before declaring the task done, on anything non-trivial — one last check for
  something you might have missed. Make your work durable first (commit, save the
  file) so a slow consult can never cost you a finished result.

Skip it for simple, single-step lookups or mechanical edits — a consult adds
latency and cost with nothing substantive to weigh in on.

## Spawning the advisor

Call `spawn_session` once per task that needs one (not once per question):

- `intent` — an advisor persona briefing, not a work briefing. State plainly that
  it is acting as an advisor for a peer session in the same directory: it will
  receive questions over `send_message`, should read whatever code it needs to
  answer well, must not edit any files, must not call `workflow_phase`, and
  should reply with focused advice via `send_message` back to your own session
  id (`$AW_SESSION_ID`) rather than attempting the work itself.
- `cwd` — your own working directory, not the default scratch dir, so the
  advisor can read the same files you're working from. Do not set `worktree`.
- `model` — the strongest model available for the agent you launch (Claude:
  `opus`; Codex: `gpt-5.6-sol` — see the `spawn-session` skill for the full menu).
  If you're already running that model yourself, spawn one anyway: a fresh
  context with no accumulated assumptions can catch what you've anchored past.
- `nest: true` — an advisor is a deliberate, designed child of the session that
  spawned it (it exists only to be consulted by you, shares your cwd, and gets
  archived when you're done with it), so opt it into nesting explicitly. The
  board then groups it visually under your card instead of showing it as an
  unrelated top-level session.

Keep the returned session id — that's who you `send_message` for every consult
on this task, and who you `archive_session` once you're done.

## Consulting

For each question, `send_message` a **self-contained** brief: the advisor did not
see any of your prior work and does not watch your files change, so state what's
relevant now — the task, what you've tried or decided, and the specific
question. Keep it tight; a wall of transcript defeats the point.

After sending, your turn ends. `send_message` now queues into the advisor's
mailbox rather than pasting the body directly — you'll get back a short "you've
got mail" notification once it replies, not the advice itself; call `read_mail()`
to fetch what it actually said. ("Idle" here doesn't mean asleep — your session
stays live at its prompt the whole time; the notification just arrives once the
advisor has answered, same as waiting on a worker — see the `spawn-session`
skill.) Reuse the same advisor session for later questions on this task instead
of spawning a new one each time; it holds the thread of earlier advice.

## Weighing the advice

Give it real weight, but don't switch course silently: if a step it suggested
fails empirically, or you have direct evidence it didn't have, adapt. If your own
evidence points one way and the advice points another, send one more message
naming the conflict and asking which constraint wins, rather than picking a side
unstated.

## Wrapping up

Once you're done consulting for this task, `archive_session` the advisor — you
cannot archive yourself, but you can archive it. Leaving it running just clutters
the board with a session that has nothing left to do.
