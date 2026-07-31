---
name: task-memory
description: Use at the start of a session and whenever you have cross-cutting context to record — how to read and append the shared per-task memory file (AW_TASK_MEMORY) that the human and agent edit together across every repo the task touches.
---

# Task memory

This session has shared task memory at the file path in the `AW_TASK_MEMORY`
environment variable. This memory is shared across every repo this task touches,
so reserve it for context that is relevant across those repos — cross-cutting
decisions, how the repos fit together, task-wide constraints and goals.

## At the start of a session

Read the file at `AW_TASK_MEMORY` for that shared context.

## When adding context

- Append a brief note to the end. Do **not** rewrite or delete existing content —
  the human may be editing the same file concurrently.
- Do **not** use it as a session scratchpad: keep plans, command output, and
  progress logs out of it.
- Do **not** use it for inter-agent communication — it's a slow, unreliable
  channel since no one may re-read the file after you write. If you need
  another session to act on something or reply, use `send_message` instead.
- Record anything specific to a single repo in that repo's own memory (its
  `CLAUDE.md` / project memory) instead, not here.
