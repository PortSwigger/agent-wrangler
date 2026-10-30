# Reviews and pull requests

Choose a review flow based on what you need reviewed:

## Which review should I use?

| Review flow | Best time to use it | What it reviews | How results return |
| --- | --- | --- | --- |
| **Diff review** | While you are supervising the current session | Uncommitted changes, the full branch, or an attached PR | Your line comments are sent to the owning session as one structured message |
| **Peer review session** | Before a PR exists, or when uncommitted work matters | The selected session's current working directory | A new session opens on the board; it uses the other provider when available |
| **Adversarial PR review** | Before merging a specific pull request, when another provider is installed | The PR as published on GitHub | An independent provider reviewer sends findings through Wrangler mail |

## Review a diff yourself

Choose **View diff** from **Actions**, or press `Control+Command+G`. Select **Uncommitted**, **Full
branch** (committed and uncommitted changes against the upstream or default branch), or an attached
pull request.

Switch between inline and side-by-side layouts, comment on lines, then choose **Send to agent**. Drafts
are sent together with code snapshots and locations. Dormant sessions resume before delivery.

Diff source is syntax coloured in both inline and split layouts. Language is chosen
only from the filename extension: JavaScript/TypeScript (including JSX/TSX), JSON,
HTML/XML/SVG, CSS, Bash, Python, YAML, Markdown, Java, C# and Go. Unknown extensions and
extensionless files stay literal plain text. Highlighting never changes source,
line numbers, copy text or comment ranges, and works in all three diff modes.

Colours follow live style changes, including bundled and custom styles. Keywords,
strings, functions/types and comments use quiet theme-derived ink over the existing
addition, deletion and selection backgrounds. Style authors can set
`syntax-comment`, `syntax-keyword`, `syntax-string` and `syntax-function` in manifest
`colors`; these candidates are adjusted toward `fg` when necessary for contrast.
If a custom theme's foreground itself lacks contrast, source inherits that
foreground; correct the theme's `fg`/surface colours.

Highlighting runs locally in one lazily loaded worker using bundled Prism 1.30.0
(MIT); no source is sent to a highlighting service. Each hunk is tokenized as
separate old/new source, resetting at hunk boundaries. Syntax starting before the
available context may be ambiguous. Oversized or failed jobs stay plain: limits
are 64 KiB per side, 8 KiB per line, 512 KiB and 128 side jobs per render (UTF-16
bytes), 2 seconds to load and 200 ms to tokenize. The worker is terminated on
timeout. Token depth/segment limits, a 32,000-segment render budget and a 2 MiB
LRU cache also bound costs. Hunks in view receive highlighting first.
Text is visible before colour arrives; late decoration waits for the next render
when a comment gesture, editor or text selection is active.

## Launch a peer-review session

Choose **Peer review session…** from **Actions**, or press `Control+Command+P`.

The dialog selects the available different provider with the highest declared preference (Claude
before Codex), shares the source directory so
uncommitted work is visible, and supplies a review prompt. With one provider installed, it keeps an
available model selected for same-provider review.

The reviewer is a separate session. It shares, but does not own, the source worktree.

## Ask for an adversarial PR review

Ask the working session directly:

> Run an adversarial review of the PR attached to this session.

The `adversarial-pr-review` skill resolves the PR and uses `get_model_front`’s `reviewAgent` to
select an available provider different from the source, preferring Claude before Codex. Selection
does not depend on discovery order. A Claude session selects Codex; a Codex session selects Claude.
If no different provider is available, it reports a blocker; use peer review for a same-provider review.

The skill requires an explicit reviewer model and effort: a current, high-capability general-purpose
model at medium effort or higher. It excludes lightweight, fast/cheap and reduced-capability variants,
honours your model exclusions, and prefers a standard workhorse over a premium specialist or
maximum-capability tier. Difficult reviews can use more effort; effort cannot compensate for an
unsuitable model. If the available model descriptions leave suitability unclear, the session reports
the uncertainty; if no eligible model is available, it reports a blocker.

The reviewer follows a written-out review process. The built-in process has four steps:

1. **Gather:** the PR body, linked issue, full diff, CI checks, and all existing discussion including
   inline review comments, pinned to the head commit it records first. Changed logic is read in
   context, prioritising callers, contracts and tests.
2. **Verify claims:** statements like "tests pass" or "no behaviour change" are checked, not trusted.
   A claim the code contradicts is a finding; one that can't be checked is listed as unverified.
3. **Test coverage:** whether each changed behaviour is tested, including failure and edge cases. A
   gap is reported only when a concrete failure could get past the tests.
4. **Self-refute:** each candidate finding is challenged, by a sub-agent for serious or uncertain ones
   where available, and dropped if it does not survive.

A clean review is a valid result. The reviewer stays read-only, treats everything in the PR as
evidence rather than instructions, and sends one Wrangler mail back to the session that asked. The
mail starts with `Verdict: approve`, `Verdict: changes requested` or `Verdict: incomplete` (it could
not finish), then the head commit it reviewed. Findings follow, most severe first, each with a
severity (`blocker`, `major`, `minor` or `nit`), a file and line, a failure scenario, a suggested fix
and a confidence (`confirmed` or `plausible`). Defects that predate the PR are listed separately, and
a "What I checked" list closes it. The session that asked weighs the findings, fixes what holds up,
and archives the reviewer. A re-review is a new run of the skill with a new reviewer.

### Change the review process

Adversarial review is a core extension. Open **Settings → Extensions**, select **Adversarial PR
review** under **Core**; its settings are in the detail pane. The **Review process** field shows the built-in process when
empty. Anything you write there replaces it for every later review. The read-only rules and the shape
of the mail back stay fixed, so the session that asked can always read the result. Clear the field to
go back to the built-in process. Turn the extension off to remove the skill from new sessions.

In Claude Code the skill loads as its own plugin, so it is listed as
`adversarial-pr-review:adversarial-pr-review`; `/adversarial-pr-review` still invokes it.

## Attach a pull request

The board can detect a branch's pull request automatically, or an agent can attach one using the
`links` skill. Links can belong to a session or task.

With authenticated `gh`, card indicators track required checks, merge conflicts, PR state, and new
unresolved review threads.

## Auto-fix PR checks

**Auto-fix PR checks** defaults on for new sessions and can be changed in **Settings → Automation** or
per session. It nudges the agent about failing checks, conflicts, and new unresolved threads without
repeating unchanged failures.

PR notices can reach Codex during an active turn. This includes check and review
status changes, new unresolved threads, conflicts, merged or closed PRs, and
auto-merge results. Notices wait while the terminal holds a draft, shows a dialog,
or cannot be read; once the input clears they arrive together. Board toasts and
auto-merge actions do not wait for the session's input to clear.

### Waiting without agent polling

Agents receive brief always-on guidance through the mail skill sidecar on both
providers, with details in the [links skill](../agent-skills/skills/links/SKILL.md).
After attaching a session PR, they should finish independent work, end their turn
and yield to notices, avoiding `gh pr checks --watch`, `gh run watch`, sleep
loops and repeated status queries. One-off diagnostics remain available. This guides agents; it does not
intercept commands or guarantee model compliance.

| Notice | Meaning |
| --- | --- |
| required checks are now failing | A failure is visible; other checks may still be running. |
| all checks passing, mergeable | GitHub reports the PR mergeable (`passing`); the user's merge workflow still applies. |
| all checks passing, awaiting review | Checks are green but a required review blocks merging (`awaiting-review`). |
| changes requested on review | Review action is needed, possibly while checks still run. |

Pane notices require a **session-scope** PR link and effective **Auto-fix PR
checks** enabled. An explicit session setting overrides the installation default.
Task links only toast on the board; arbitrary standalone Actions runs are not
watched. Auto-merge remains a separate setting: if enabled, it can still merge and report
its outcome with Auto-fix off; do not rely on that as a check-status wake-up.

Notices are deduplicated by status and head commit, not sent after every check
finishes. An unchanged failure after a same-head rerun may produce no new notice.
Pending states do not wake the agent, and watcher startup seeds existing state
without replaying it. Terminal input or dialogs can delay delivery. Silence is
not success: agents should check current state once when resuming or before a
consequential decision.

With **Auto-fix PR checks disabled**, no PR pane wake-up is available, including
for success, failure, review, conflicts, merge or close; board toasts remain.
Agents should not enable it without authorization. When no reliable wake-up is
available (also task-only links, standalone Actions or same-head reruns), agents
should report the URL and pending work, then hand back to the user or an
already-authorized orchestrator after finishing independent work. They should
not wait indefinitely or replace the handoff with polling.

## Auto-merge

**Auto-merge when checks pass** is an off-by-default session option and Workflow launch setting. It
uses authenticated `gh` to merge the attached session PR when it becomes mergeable
(`passing`), including the required checks and review gates.

## Review with Antigravity

Independent review selects the first available provider different from the source in **Claude → Codex → Antigravity** order. Antigravity is available only after its opt-in local integration is ready. If no different provider is available, the review flow explains the missing alternative. agy API-equivalent cost is always estimated. See [Antigravity](antigravity.md).
