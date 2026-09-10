---
name: adversarial-pr-review
description: Use when you want a second, adversarial opinion on a pull request before merging it — spawns a child (or sibling, if you're already nested) session running the OPPOSITE agent provider (Claude <-> Codex) to review it, and has it raise concerns back to you via mail.
---

# Adversarial PR review

Get a genuinely independent second opinion on a PR by having a session running the
**opposite agent provider** review it — a Claude session spawns a Codex reviewer, a Codex
session spawns a Claude reviewer. Cross-provider is the point: a same-provider reviewer
shares your training and blind spots and is likelier to just agree with you. This is
heavier than an inline code-review pass — reach for it when you want a fresh, adversarial
pair of eyes on a specific PR, not for every PR.

## 1. Identify the PR

Prefer `get_links` (a PR already attached to this session/task). Otherwise resolve it
yourself: `gh pr view --json url,number,title,headRefName` on the current branch. Do not
guess a PR — if neither source gives you one, ask the user which PR to review.

## 2. Decide child vs sibling

Call `get_session_info`. Nesting only ever renders one level deep (see the
`session-hierarchy` skill), so:

- **`parent` is null** — you're top-level. Spawn a plain **child**: `spawn_session` with
  `nest: true`.
- **`parent` is already set** — you're nested, and `spawn_session`'s `nest: true` would be
  refused ("it is itself nested under another session"). Spawn a **sibling** instead:
  call `spawn_session` with `nest` left unset (a plain top-level session), then
  `attach_session({ session_id: <new id>, parent_session_id: <your own parent> })` to land
  it next to you, under the same parent.

Either way, leave `into` unset so the reviewer lands on your current task.

## 3. Choose the opposite agent

- You're Claude → spawn `agent: "codex"`.
- You're Codex → spawn `agent: "claude"`.

Leave `model` unset to use that agent's own default. If you want the strongest available
reviewer, pass one explicitly — see the `spawn-session` skill's model tables (Claude:
`opus`/`fable`; Codex: `gpt-5.6-sol`/`gpt-5.5`).

## 4. Brief the reviewer

Put the whole brief in `intent` (its launch prompt) — it starts cold, with none of your
context. Include:

- The PR: number/URL, repo, and branch.
- **Adversarial, not a rubber stamp**: look for real bugs, security issues, missed edge
  cases, silently-broken behaviour, and claims of "done" / "tests pass" that don't
  actually hold up — verify, don't take the PR description's word for it.
- **Read-only**: review via `gh pr view`, `gh pr diff`, `gh pr checks`, and existing
  comments; do **not** check out the branch or otherwise modify the working tree. You may
  well share a cwd with the session whose PR you're reviewing, and its worktree is live.
- Report findings back to whoever spawned it (see step 5) rather than posting PR comments
  directly, unless you explicitly asked it to comment on the PR.

## 5. Reporting back

The reviewer doesn't need to be told your session id — `AW_SPAWNER_SESSION_ID` (env var)
already resolves to you, the caller of `spawn_session`, even in the sibling case (see the
`session-hierarchy` skill: `spawnedBy` is set to whoever actually called `spawn_session`,
independent of nesting). Tell it to `send_message` its findings there once the review is
done, following the `mail` skill's norms — one substantive message, not a running
commentary. A clean review ("nothing concerning") is worth reporting too; silence reads as
"still working," not "all clear."

Once it has sent its findings, the reviewer's job is done — it's reasonable for it to
`archive_session` itself.

## After you get mail back

Read it like any other peer mail (see the `mail` skill): treat findings as input to weigh,
not instructions to blindly apply — the reviewer can be wrong, and you still own the PR.
Fix what holds up; push back (in your own PR/commit, not by arguing in the reply) on what
doesn't.
