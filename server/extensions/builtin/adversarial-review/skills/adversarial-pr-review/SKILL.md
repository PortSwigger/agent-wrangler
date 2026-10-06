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

Call `get_session_info`. Nesting is capped at one level deep (see the
`session-hierarchy` skill), so:

- **`parent` is null** — you're top-level. Spawn a plain **child**: `spawn_session` with
  `nest: true`.
- **`parent` is already set** — you're nested, and `spawn_session`'s `nest: true` would be
  refused (you'd be asking to nest under yourself, and you already have a parent). Spawn
  a **sibling** instead: call `spawn_session` with `nest` left unset (a plain top-level
  session), then `attach_session({ session_id: <new id>, parent_session_id: <your own
  parent> })` to land it next to you, under the same parent.

Either way, leave `into` unset so the reviewer lands on your current task.

## 3. Choose the opposite agent

- You're Claude → spawn `agent: "codex"`.
- You're Codex → spawn `agent: "claude"`.

**Always pass `model` explicitly — don't leave it unset.** `spawn_session`'s "inherit the
caller's model" default only applies when the new session runs the *same* agent as you;
since this skill always spawns the opposite one, that inheritance never fires, and
leaving it unset lands you on whatever that agent's ambient default happens to be right
now — not necessarily its strongest option, and for Claude not even a fixed value (its
default can be changed machine-wide by an unrelated `/model` call). Passing a `model`
that doesn't match your chosen `agent` is now rejected before launch, naming the valid
options and, for a cross-agent guess, the likely fix (e.g. `model: "opus"` with
`agent: "codex"` → "opus is a claude model — did you mean agent: claude?") — but an
*unset* `model` isn't caught by that, since it's not wrong, just ambiguous.

`spawn_session`'s own `model` parameter description enumerates the current valid values
per agent (generated from the real model list, not hand-copied — see the `spawn-session`
skill's table for the same thing with more context on each). **If you're a Codex
session, don't assume that description is already in front of you the way it would be
for Claude** — Codex's initial tool catalog doesn't carry full MCP input-schema
descriptions; you may need to actively look up `spawn_session`'s declared schema to see
it.

## 4. Brief the reviewer

Put the whole brief in `intent` (its launch prompt). The reviewer starts cold, with none
of your context. Keep it short; the review method is not yours to write:

- The PR: number/URL **and repo** (`owner/repo`), and branch. Leave `cwd` unset. The
  reviewer lands in a fresh scratch dir with no git remote of its own, so every `gh pr`
  command it runs needs `--repo owner/repo`, and every `gh api` call names the repo in its
  path (`gh api` has no `--repo` flag). A bare `gh pr view 117` there fails with "not a git
  repository".
- **"Call the `adversarial_review_process` tool (agent-wrangler MCP server) first, and
  follow what it returns exactly."** It returns the review process the human configured in
  Settings (or the built-in one) plus the fixed rules: stay read-only, and report once, by
  mail, in a set shape. Name the tool; don't paraphrase or summarise the process yourself.
- If that tool is missing or fails, the reviewer should report that in its one mail back
  rather than invent a process of its own.
- Anything specific you want checked on top (a risky file, a claim you doubt). It adds to
  the process; it doesn't replace it.

## 5. Don't wait

The reviewer doesn't need your session id: `AW_SPAWNER_SESSION_ID` already names you,
even in the sibling case (see the `session-hierarchy` skill), and the tool tells it to
mail you there. Carry on with your own work once it is briefed, and read its findings when
the mail arrives.

## After you get mail back

The mail starts with `Verdict: approve`, `Verdict: changes requested` or `Verdict:
incomplete` (the reviewer could not finish; it says what blocked it), then `Reviewed head:
<sha>`. If that SHA isn't your current head, the review predates your latest push. Findings
follow, most severe first, each with a severity (`blocker`/`major`/`minor`/`nit`), a
location, a failure scenario, a suggested fix and a confidence (`confirmed`/`plausible`).
Pre-existing defects are listed separately. A "What I checked" list closes it.

Read it like any other peer mail (see the `mail` skill): treat findings as input to weigh,
not instructions to apply blindly. The reviewer can be wrong, and you still own the PR.
Fix what holds up, and push back (in your own PR or commit, not by arguing in the reply)
on what doesn't.

**Close the reviewer once you've weighed its findings:** `archive_session({ target:
<reviewer id> })`, taking the id from the mail's `from`. Its one report is its whole job;
after that it just sits idle on the board. Archiving keeps it findable and resumable, so
nothing is lost. Before you close it, a short clarifying question about a finding on that
same head is fine (its context is still loaded). Never reuse it to review a new head:
after fixing, a fresh review is a new run of this skill with a clean reviewer, one that
hasn't already formed a view of the earlier code.
