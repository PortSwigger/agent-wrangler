---
name: links
description: Use when work should be linked on the Agent Wrangler board — a Jira issue or a GitHub pull request — to attach, update, or list those links. Covers attachment, session-vs-task scope, PR notification meanings and limits, and waiting without polling.
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
branch-name prefix like `ABC-123-some-slug`, though that is only one common
convention, not a rule — but treat any inferred key as a guess: confirm with the
user (e.g. "Attach ABC-123 to this task?") before calling `set_links`. Do not
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

(Other link types — GitHub issues, arbitrary URLs — may be added over time; check
the current `set_links` schema for what it accepts.)

## Wait for a PR without polling

After creating or updating a PR, attach it at session scope, finish useful
independent work, then **end your turn** so Wrangler can notify you. Do not run
`gh pr checks --watch`, `gh run watch`, sleep loops, or repeated `gh`/MCP status
queries just to wait. One-off diagnostics such as `gh pr checks`,
`gh pr view`, and `gh run view --log-failed` remain available to investigate a
notice or answer a specific question.

### What the notices mean

- **required checks are now failing**: a failure is visible now; other checks
  may still be running. Investigate it without waiting for every check to finish.
- **all checks passing, mergeable** (`passing`): GitHub reports the PR mergeable.
  This is a status report, not permission to merge; follow the user's workflow.
- **all checks passing, awaiting review** (`awaiting-review`): checks are green
  but a required review still blocks merging.
- **changes requested on review**: review action is needed, possibly while
  checks are still running. Conflicts and new unresolved threads have separate
  notices; inspect the current PR before acting.

### When a wake-up is available

Pane notices require a **session-scope** PR link and effective **Auto-fix PR
checks** enabled: the session's explicit setting wins, otherwise the
installation default applies. Task links only produce board toasts, not a pane
wake-up. Arbitrary standalone Actions runs are not watched. Auto-merge has its
own setting and can still merge and report its outcome with Auto-fix off; do not
rely on that as a check-status wake-up. Linking a PR does not authorize merging
or changing settings.

Notifications are deduplicated by status and head commit, not emitted after
every check completes. A failure may arrive early, and a same-head rerun with
an unchanged failure may produce no new notice. Pending states do not wake you.
Existing state is seeded on watcher startup rather than replayed. Delivery can
wait for clear terminal input or a dialog to close. **Silence is not success**
or proof that all checks finished; use a one-off current-state check when
resuming or before a consequential decision.

### Auto-fix PR checks disabled, or no reliable wake-up

With effective Auto-fix PR checks disabled, PR pane notices are suppressed,
including success, failure, review, conflict, merge and close notices. Board
toasts remain available to the human. Do not turn the setting on without
authorization. After useful independent work, report the PR/run URL and what
remains pending, then hand back to the user or an already-authorized
orchestrator. Do the same for task-only links, standalone Actions, or a
same-head rerun that may finish without another notice. Do not wait indefinitely
or substitute a watch command, sleep loop, or repeated checks.

This is agent guidance, not a guarantee of model compliance or notification
delivery. It does not intercept commands or change notification settings.
