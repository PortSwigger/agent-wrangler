---
name: adversarial-pr-review
description: Use when you want a second, adversarial opinion on a pull request before merging it — spawns a child session running the preferred available different agent provider to review it, and has it raise concerns back to you via mail.
---

# Adversarial PR review

Get a genuinely independent second opinion on a PR by having a session running the
**preferred available different agent provider** review it. Cross-provider is the point: a same-provider reviewer
shares your training and blind spots and is likelier to just agree with you. This is
heavier than an inline code-review pass — reach for it when you want a fresh, adversarial
pair of eyes on a specific PR, not for every PR.

## 1. Identify the PR

Prefer `get_links()` (no arguments — a PR already attached to this session/task).
Otherwise resolve it yourself: `gh pr view --json url,number,title,headRefName` on the
current branch. Do not guess a PR — if neither source gives you one, ask the user which
PR to review. Either way, hold onto the **repo** (`owner/repo`) as well as the number —
you'll need to pass it explicitly to the reviewer (see step 4).

## 2. Spawn it as a child

Call `spawn_session` with `nest: true`, however deep you are yourself: nesting has no depth
limit, so the reviewer lands under you whether you are top-level or already nested. Leave
`into` unset so it lands on your current task.

## 3. Choose an independent provider

Call `get_model_front` with `reviewFor` set to your source provider. Use its
`reviewAgent`: the available provider with the lowest declared review priority,
excluding the source (Claude before Codex). Availability ordering does not matter.
If it is null, report that no independent provider is available; do not launch a
same-provider reviewer.

**Always pass `model` and `effort` explicitly — don't leave either unset.** `spawn_session`'s "inherit the
caller's model" default only applies when the new session runs the *same* agent as you;
since this skill always spawns a different provider, that inheritance never fires, and
leaving it unset lands you on whatever that agent's ambient default happens to be right
now — not necessarily a suitable option, and for Claude not even a fixed value (its
default can be changed machine-wide by an unrelated `/model` call). Passing a `model`
that doesn't match your chosen `agent` is now rejected before launch, naming the valid
options and, for a cross-agent guess, the likely fix — but an
*unset* `model` isn't caught by that, since it's not wrong, just ambiguous.

`spawn_session`'s own `model` parameter description enumerates the current valid values
per agent (generated from the real model list, not hand-copied — see the `spawn-session`
skill's table for the same thing with more context on each). **If you're a Codex
session, don't assume that description is already in front of you the way it would be
for Claude** — Codex's initial tool catalog doesn't carry full MCP input-schema
descriptions; you may need to actively look up `spawn_session`'s declared schema to see
it.

### Reviewer model and effort

Select a current, high-capability general-purpose model suitable for independent code
review, using **medium effort or higher**. Exclude lightweight, fast/cheap, and
reduced-capability variants. Among models meeting that capability floor, prefer the
standard workhorse over a premium specialist or maximum-capability tier. Increase effort
for difficult reviews; do not use extra effort to compensate for an unsuitable model.
Honour the user's model exclusions.

Use the available model descriptions to establish suitability. If they do not establish
that an option meets this floor, report the uncertainty rather than silently choosing a
weaker option. If no eligible model is available, report the blocker instead of lowering
the capability or effort floor.

Call `get_model_front` to help pick a reviewer that's strong for its price from
the selected provider's eligible models, while respecting the capability and effort
floor above and the user's exclusions. Its numbers measure doing a coding task,
not review quality. Filtering the front never restricts how it judges a `pick`;
an unscored pick has no benchmark verdict.

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
(see the `session-hierarchy` skill), and the tool tells it to
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
