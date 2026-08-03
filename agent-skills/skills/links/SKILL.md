---
name: links
description: Use when work should be linked on the Agent Wrangler board — a Jira issue or a GitHub pull request — to attach, update, or list those links. Covers which link types are supported, when to attach them, and session-vs-task scope.
---

# Links

You can record links for this work so they show on the Agent Wrangler board.
Manage them with the `get_links` tool (read the current list) followed by
`set_links` (send the **full** updated list — adding a link means appending it to
what `get_links` returned; removing one means sending the list without it).

## Scope

Default to scope `"session"` — the link belongs to this session. Use scope
`"task"` (shared across every session of the task) only when the user explicitly
says the link belongs to the whole task.

## Supported link types

### Jira issue

Identify the Jira key, then attach it. If the user states the key explicitly,
attach it directly. You may also **infer** a candidate key — most commonly from a
branch-name prefix like `ENT-1234-some-slug`, though that is only one common
convention, not a rule — but treat any inferred key as a guess: confirm with the
user (e.g. "Attach ENT-1234 to this task?") before calling `set_links`. Do not
attach a link you are not confident about.

### GitHub pull request

Find the PR (run `gh pr view --json url` for the current branch, or the user
states it), then call `set_links` with
`{ type: "pr", url: "https://github.com/owner/repo/pull/N" }`. As with the Jira
key: if the user gives the URL explicitly, attach it; if you infer it from the
branch, confirm first. The board polls the PR's CI status and shows it on the
card, and **auto-removes** the link once the PR is merged or closed — you do not
need to clean those up yourself.

**Attach on creation, don't wait to be asked.** When you run `gh pr create`,
treat "create the PR" and "attach the PR link" as one step — call `get_links`
then `set_links` right away, before reporting the PR back to the user. A PR you
created but didn't link is invisible on the board (no CI status, no
auto-removal on merge/close). Scope defaults to `"session"` as above.

**Once linked, inbound CI status is informational only.** After a PR is
attached, the board's own polling handles status monitoring. If a
checks-passed/checks-failed notification comes through for a linked PR, treat
it as an update to read, not a trigger to act — don't proactively fetch logs,
diagnose the failure, or push a fix. Only dig in if the user explicitly asks
you to.

(Other link types — GitHub issues, arbitrary URLs — may be added over time; check
the current `set_links` schema for what it accepts.)
