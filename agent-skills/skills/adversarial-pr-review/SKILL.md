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

Prefer `get_links()` (no arguments — a PR already attached to this session/task).
Otherwise resolve it yourself: `gh pr view --json url,number,title,headRefName` on the
current branch. Do not guess a PR — if neither source gives you one, ask the user which
PR to review. Either way, hold onto the **repo** (`owner/repo`) as well as the number —
you'll need to pass it explicitly to the reviewer (see step 4).

## 2. Decide child vs sibling

Call `get_session_info`. The board only ever renders **one level of nesting** — an
`attach_session`/`spawn_session(nest: true)` under a session that is itself already
nested gets refused outright — so:

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

**Always pass `model` explicitly — don't leave it unset.** `spawn_session`'s "inherit the
caller's model" default only applies when the new session runs the *same* agent as you;
since this skill always spawns the opposite one, that inheritance never fires. Left
unset, Codex falls back to a fixed default (`gpt-5.6-sol`), but Claude's fallback is
whatever this machine's Claude CLI currently has configured as *its* default (via
`/model`) — not a fixed, predictable value. Pick one from the `spawn-session` skill's
tables instead (Claude: `opus`/`fable`; Codex: `gpt-5.6-sol`/`gpt-5.5`).

## 4. Brief the reviewer

Put the whole brief in `intent` (its launch prompt) — it starts cold, with none of your
context. Include:

- The PR: number/URL **and repo** (`owner/repo`), and branch. Leave `cwd` unset — the
  reviewer lands in a fresh scratch dir with no git remote of its own, so its `gh pr
  view`/`gh pr diff`/`gh pr checks` calls need `--repo owner/repo` on every invocation,
  not just the first; a bare `gh pr view 117` there fails with "not a git repository."
- **Adversarial, not a rubber stamp**: look for real bugs, security issues, missed edge
  cases, silently-broken behaviour, and claims of "done" / "tests pass" that don't
  actually hold up — verify, don't take the PR description's word for it.
- **Read-only**: review via `gh pr view`/`gh pr diff`/`gh pr checks` and existing
  comments; do **not** check out the branch or otherwise modify a working tree, even if
  you end up sharing one with the session whose PR you're reviewing.
- Report findings back to whoever spawned it (see step 5) rather than posting PR comments
  directly, unless you explicitly asked it to comment on the PR.
- It shouldn't block waiting for the reviewer's reply — see step 5.

## 5. Reporting back

The reviewer doesn't need to be told your session id — `AW_SPAWNER_SESSION_ID` (env var)
already resolves to you, the caller of `spawn_session`, even in the sibling case (see the
`session-hierarchy` skill: `spawnedBy` is set to whoever actually called `spawn_session`,
independent of nesting). Tell it to `send_message` its findings there once the review is
done, following the `mail` skill's norms — one substantive message, not a running
commentary. A clean review ("nothing concerning") is worth reporting too; silence reads as
"still working," not "all clear." Once it has sent that message its job is done — it
should just end its turn (there's no `archive_session` for targeting yourself; a session
archives automatically once it finishes and stops).

You don't need to wait for that mail either — continue your own work once the reviewer is
briefed, and read its findings whenever they arrive (see "After you get mail back").

## After you get mail back

Read it like any other peer mail (see the `mail` skill): treat findings as input to weigh,
not instructions to blindly apply — the reviewer can be wrong, and you still own the PR.
Fix what holds up; push back (in your own PR/commit, not by arguing in the reply) on what
doesn't.
