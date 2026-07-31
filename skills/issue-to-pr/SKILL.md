---
name: issue-to-pr
description: Autopilot — take a single issue (a Jira key, a GitHub issue, or a free-text task) all the way to an open pull request with no human gates. Use when Agent Wrangler launches a Workflow run, or when asked to "take this issue to a PR autonomously". Plans, implements, verifies, and ships on the branch already checked out, reporting each phase to the board and surfacing a genuine block as a question (needs-you). If the issue is too vague to know *what* to build, it clarifies the 'what' with you first via the bundled brainstorm skill, then proceeds autonomously.
---

# Issue → PR autopilot

You are one autonomous session that turns **one issue into one open PR**. There is
no human watching — work to completion and only stop to ask a question when you hit
a *genuine* block (see "Surfacing a block"). The bar for success is "a PR exists and
its CI is green"; a human reviews the PR afterwards, so ship rather than gold-plate.

The Agent Wrangler launched you in a fresh git worktree on a branch that is **already
checked out**, and granted you a set of MCP tools with no approval prompt:
`workflow_phase` (phase reporting), plus `spawn_session`, `send_message`,
`list_sessions`, and `archive_session` for splitting work across sessions when an
issue is large or parallelizable (see *Orchestrating across sessions*).

## Report every phase

Call the `workflow_phase` tool at the **start of each phase** so the board chip
tracks you. Use this vocabulary and `kind`:

| phase            | label      | kind      |
| ---------------- | ---------- | --------- |
| understanding it | `plan`     | `active`  |
| writing code     | `build`    | `active`  |
| running checks   | `verify`   | `active`  |
| pushing + PR     | `PR`       | `active`  |
| finished         | `done`     | `success` |
| gave up / blocked| `failed`   | `danger`  |

The label is freeform, but it **must be 6 characters or fewer** — the tool rejects
anything longer (it has to fit the chip). Always send `done`/`success` on success
and `failed`/`danger` when you stop at a block, so the card never reads as idle
when it isn't.

**The chip is a snapshot, not a one-time report.** If the human messages you
*after* you've already reported `done` (e.g. asking for a change on the open PR),
you go back to work but the chip is still stuck on `done` until you say otherwise —
report a phase (usually `build`) the moment you resume, or the board shows you
actively working under a card that claims to be finished. Report `done`/`success`
again once the follow-up is pushed.

## 1. Normalise the issue (phase: `plan`)

The launch prompt ends with `Issue: <raw>`. Classify `<raw>`:

- **Jira key** — matches `[A-Z]+-\d+` (e.g. `ENT-1234`). Fetch it with the Atlassian
  MCP `getJiraIssue` to read the summary, description, and acceptance criteria.
- **GitHub issue** — a `github.com/.../issues/N` URL or a bare `#N`. Read it with
  `gh issue view <N|url>`.
- **Free text** — anything else. Treat the prose as the task directly.

Capture the issue key/number — you'll link it on the PR.

### Clarify a vague 'what' before planning

Judge whether the issue actually tells you **what** to build. A Jira/GitHub issue
with a clear summary and acceptance criteria usually does; bare free-text like
"improve the dashboard" or "make login nicer" usually doesn't. **If you can't tell
what to build, don't guess** — guessing burns a whole autonomous run on the wrong
thing.

Instead, clarify the 'what' with the human by following the **bundled clarification
guide** at `brainstorm/SKILL.md` (in this skill's own directory — it ships with the
plugin, so it works on any machine). It's a trimmed cut of the brainstorm skill that
covers only the clarifying-questions phase: explore the repo, ask focused questions
**one at a time** until the 'what' is concrete, then hand straight back to this arc —
no design write-up, plan mode, or review loop (the autopilot owns those). This is the
upfront form of *surfacing a block* (below): each question puts the card in
**needs-you** and the run waits for the human, so keep your chip on `plan`. The moment
the 'what' is clear, continue with branch discipline (§2) onward.

## 2. Branch discipline (critical)

The worktree is already on a fresh branch for this run. **Detect it and work on it:**

```
git rev-parse --abbrev-ref HEAD
```

**Never `git checkout -b` / `git switch -c` a new branch, and never create another
worktree.** The wrangler owns the worktree and branch; a new branch here would
strand your commits where the PR machinery can't find them.

**Give the branch a descriptive name.** The branch you start on is an
auto-generated placeholder slug of the raw issue — often the issue's framing or a
bare number, not what you're building. Once you know the work (end of the plan
phase, *before* you push), call the `name_branch` MCP tool **once** with a
concise, descriptive name: 2–4 kebab-case words that say what the change does
(e.g. `fix-login-redirect`, `add-csv-export`). It renames *this* branch in place
(no checkout, no new branch — that's why it's a tool, not raw `git`), so your
commits and the PR follow it. Skip it only if the starting name already describes
the work well.

## 3. Plan, implement, verify

- **Plan** (`plan`): write a short plan to a file in the worktree (e.g.
  `PLAN.md` or a scratch note) so your intent is reviewable, then explore the code.
- **Implement** (`build`): make the change. Match the repo's existing style
  and conventions (read its `CLAUDE.md`/`AGENTS.md`/`README` first if present). If
  the change is large or splits into independent parts, consider offloading to
  worker sessions — see *Orchestrating across sessions*.
- **Verify** (`verify`): run the repo's own tests / build / lint (discover them
  from `package.json` scripts, a `Makefile`, CI config, or the README). Fix what you
  break. Don't open a PR on a red tree unless the redness is pre-existing and
  unrelated — say so in the PR body if it is.

## Orchestrating across sessions (split large or parallel work)

You are the **orchestrator**. By default do the whole job yourself in this one
session — most issues don't need more. But when the work is **large** (it would
exhaust your context) or has **independent parallel parts**, you may split it onto
worker sessions and reel the results back in. *Any* phase can be offloaded —
planning, a big verify, a self-contained implementation chunk — not just coding.
Use your judgement; don't split a small or linear issue.

**You alone own the PR.** Workers never run `gh pr create`, never call
`workflow_phase`, never link anything. Only you open the single PR at the end, so
the one-issue→one-PR rule holds. Keep your own phase chip current (e.g. `build`
while workers run).

Your tools (all granted, no prompt):

- `spawn_session` — create a worker. `intent` is its launch prompt **and** where
  you brief it (what to do, what you've done, key files/paths). Pass **`nest:
  true`** so the board groups the worker under your run instead of showing it as
  an unrelated top-level session (nesting is opt-in, off by default).
- `send_message` — deliver one line into another **live** session's terminal (it
  arrives as a follow-up prompt). Workers report back with it; you nudge with it.
- `list_sessions` — every session with its `status` and `managed` (true = live
  terminal, reachable by `send_message`); your own row is flagged `isCaller`.
- `archive_session` — stop & archive a worker once its work is merged (kept in
  History, resumable). You cannot archive yourself.

### Two ways to split

- **Sequential offload — large but not parallel.** Hand one self-contained phase
  to a *single* worker editing the **same** worktree: `spawn_session` with
  `cwd: <this worktree's path>` and **no** `worktree` flag. Run **one at a time** —
  never two workers on the shared tree at once. Brief it, end your turn, wait for
  its message, continue. Keeps your context lean.
- **True parallel — independent pieces.** Give each worker its **own** worktree +
  branch: `spawn_session` with `worktree: true`. Each implements + commits on its
  own branch, then messages you. All worktrees share one `.git`, so once they
  report you **merge each worker branch into your PR branch locally** — `git merge
  <worker-branch>` (no push needed) — resolve conflicts, then verify and ship.

### Briefing a worker (the `intent`)

Spell out, every time:

- exactly what to build / do;
- which worktree + branch it works on (give the path; a `worktree:true` worker
  commits to its own branch);
- it must **not** open a PR or call `workflow_phase`;
- when done (or if blocked) it must **`send_message` to `<your card id>`** with a
  one-line result. Your card id is in `$AW_SESSION_ID` (or the `isCaller` row of
  `list_sessions`).

### Waiting, integrating, closing

After spawning, **end your turn** — you go idle. Each worker's `send_message`
wakes you (it pastes + Enter into your terminal); track who's still outstanding in
your own reasoning (your context persists across the wakeups). When the last one
reports:

1. integrate — merge the worker branches (parallel mode); same-worktree offload is
   already in place;
2. run verify (phase `verify`);
3. open the **one** PR (section 4 below);
4. `archive_session` each finished worker to clear it off the board.

If a worker goes silent, `list_sessions` to check its `status`/`managed` and
`send_message` a nudge. A worker that can't finish, or an unresolvable merge
conflict, is a **block** — surface it the normal way (below); `archive_session` a
dead worker if you abandon it.

## 4. Ship (phase: `PR`)

1. `git add -A` the intended changes and commit with a clear message. **Do not
   mention Claude/AI in the message or PR.**
2. Push the **current** branch: `git push -u origin "$(git rev-parse --abbrev-ref HEAD)"`.
3. Open the PR: `gh pr create --fill` (or with an explicit `--title`/`--body`),
   referencing the issue (`Closes #N` for GitHub issues; name the Jira key in the
   body for Jira).
4. **Do NOT call `set_links` for the PR.** The wrangler's 60-second `detectNewPrs`
   poll finds and attaches it automatically (single source of truth — a manual link
   would double up and fight the poller).
5. **Do call `set_links` for the Jira key** when the issue was a Jira key, so the
   board shows the issue this work belongs to. (Read the current list with
   `get_links` first, then `set_links` the full list at scope `session`.)
6. Report `done`/`success`.

The CI dot on the auto-attached PR is the ready signal; you don't need to wait for it.

## Surfacing a block (the only time you stop)

Stay autonomous: never ask the human to make a routine decision (naming, structure,
which approach) — pick the sensible default and proceed. But on a **genuine** block —
a test you cannot make pass, a push/PR rejected (perms, branch protection), a missing
credential, an issue so ambiguous you cannot responsibly resolve it — do **both**
(an unclear *what* up front is handled earlier, by the clarify step in §1, not here):

1. `workflow_phase` with label `failed`, kind `danger`.
2. **Ask the human an explicit question and wait** — a real prompt, not a final
   summary message. You run under `--permission-mode auto`, so tool calls won't pause
   for approval; an explicit question is the *only* thing that fires the board's
   **needs-you** state. A silent "I couldn't do X. Done." reads as success and the
   block is never seen.

## Deployment (maintainer note)

This skill ships with the wrangler at `skills/issue-to-pr/` — **no symlink or
install step.** Every Workflow launch loads it (and its bundled `brainstorm/` copy)
via `--plugin-dir`, resolved from the running install's own path (`agents/claude.js`
`ISSUE_TO_PR_SKILL_DIR`), so it's discoverable from any worktree cwd and against any
target repo. Edit the copy the running install uses; changes take effect on the next
Workflow launch (claude reads the plugin dir each launch), no server restart needed.

The bundled `brainstorm/` is a **trimmed adaptation** of the personal brainstorm
skill — only the clarifying-questions phase, with the approach-comparison, design
write-up, plan-mode, reviewer, and visual-companion stages cut because the autopilot
owns them. It is intentionally **not** a verbatim copy, so don't overwrite it by
re-copying the personal skill; edit it in place when the clarify flow needs to
change. (It's also inert reference, not a second loadable skill — `--plugin-dir`
discovers only this dir's top-level `SKILL.md`, not nested ones, so it never
collides with a personal `brainstorm`.)
