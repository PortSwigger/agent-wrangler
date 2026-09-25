# Agent capabilities

Managed Claude and Codex sessions receive Wrangler-specific skills: guidance for using the underlying
[agent tools](agent-tools.md) correctly. Ask in ordinary language or use the examples below.

## Built-in Wrangler skills

| Skill | Use it for | Example request |
| --- | --- | --- |
| `adversarial-pr-review` | A second opinion on a pull request from the opposite agent provider. A Claude session launches Codex; a Codex session launches Claude. It requires both providers to be installed and reports concerns through Wrangler mail. | “Run an adversarial review of the PR attached to this session.” |
| `advisor` | Consulting a stronger model before a difficult decision, when stuck, or before declaring substantial work complete. | “Ask an advisor to challenge this design before I commit to it.” |
| `checklist` | Keeping a short, human-visible progress list on the session card. It is deliberately separate from the agent's private plan. | “Keep the Wrangler checklist updated while you do this.” |
| `links` | Attaching Jira issues and GitHub pull requests to a session or task so they appear on the board and drive PR automation. | “Attach PR 123 to this session.” |
| `mail` | Reading queued messages from peer sessions and deciding whether a reply or action is needed. | “Check your Wrangler mailbox and act on anything relevant.” |
| `session-activity` | Reconstructing what was worked on during a date or date range, including archived and suspended sessions. | “Summarise what I worked on yesterday from Wrangler activity.” |
| `session-hierarchy` | Distinguishing board nesting from launch lineage, and finding a session's parent, spawner, or task. | “Which session spawned you, and where are you nested?” |
| `spawn-session` | Starting a new, independent board session with an explicit handoff, agent, model, task, and optional nesting. | “Spawn a Codex session to investigate the failing integration tests.” |
| `task-memory` | Reading and maintaining context shared by every session assigned to the same task, including work across multiple repositories. | “Record that decision in task memory for future sessions.” |
| `todo` | Capturing a short title and descriptive handoff from the current session as a board TODO, then archiving that session. In Claude Code, invoke `/agent-skills:todo` explicitly. | “Turn this session into a TODO for later.” |

New sessions receive the skill catalogue; running sessions pick up changes after resuming.

## Workflow skill

The `issue-to-pr` skill powers **Workflow** launch mode. Given a Jira issue, GitHub issue, or free-text
task, it plans, builds, verifies, and opens a pull request from a dedicated worktree. The card shows its
phase and switches to **needs-you** if blocked. Launch it from the dialog or with `spawn_workflow`.

## Human-visible collaboration surfaces

- **Checklist:** the human and agent edit the same per-session list.
- **Task memory:** durable Markdown shared across all sessions on a task.
- **Links:** Jira and GitHub context displayed on cards and task headings.
- **Mail:** durable peer-to-peer messages; dormant recipients are woken for delivery.
- **Hierarchy:** sessions can be nested for presentation without changing who originally spawned them.

Use these board-visible surfaces instead of burying coordination state in a transcript.

## Availability

Extensions may add skills and tools while enabled. Disabling **Per-session checklist** in Settings
removes its four tools after sessions resume.
