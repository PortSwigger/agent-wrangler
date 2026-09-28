---
name: archive-to-todo
description: Use when the user explicitly asks to archive the current session as a board TODO for later, including /agent-skills:archive-to-todo in Claude Code. This ends the current session.
disable-model-invocation: true
---

# Archive this session to a TODO

Capture a concise handoff in the current task's board TODO list, then archive this session.

1. Call `get_session_info` to get your session id and current task. If it cannot identify this session, stop and explain the error.
2. Choose a short action-oriented title. Use a title supplied with the command if there is one. Write a description from the conversation: what was learned, what remains, and the next useful step. Include concrete file paths or commands when they matter. Do not invent findings or copy the whole transcript.
3. Call `add_todo` with `text`, `description`, and the current `task_id` (or omit `task_id` for Unassigned). If creation fails, stop; do not archive the session.
4. In commentary, tell the user what TODO you saved and that this session is being archived. Complete any other required user-facing response now.
5. As your final action, call `archive_session` with `target` set to your session id, `allow_self: true`, and `archive_children: false`. This stops your own agent; do not expect another turn after the call.
