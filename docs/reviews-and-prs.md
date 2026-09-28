# Reviews and pull requests

Choose a review flow based on what you need reviewed:

## Which review should I use?

| Review flow | Best time to use it | What it reviews | How results return |
| --- | --- | --- | --- |
| **Diff review** | While you are supervising the current session | Uncommitted changes, the full branch, or an attached PR | Your line comments are sent to the owning session as one structured message |
| **Peer review session** | Before a PR exists, or when uncommitted work matters | The selected session's current working directory | A new session opens on the board; it uses the other provider when available |
| **Adversarial PR review** | Before merging a specific pull request, when both providers are installed | The PR as published on GitHub | An opposite-provider reviewer sends findings through Wrangler mail |

## Review a diff yourself

Choose **View diff** from **Actions**, or press `Control+Command+G`. Select **Uncommitted**, **Full
branch** (committed and uncommitted changes against the upstream or default branch), or an attached
pull request.

Switch between inline and side-by-side layouts, comment on lines, then choose **Send to agent**. Drafts
are sent together with code snapshots and locations. Dormant sessions resume before delivery.

## Launch a peer-review session

Choose **Peer review session…** from **Actions**, or press `Control+Command+P`.

The dialog selects the complementary provider when installed, shares the source directory so
uncommitted work is visible, and supplies a review prompt. With one provider installed, it keeps an
available model selected for same-provider review.

The reviewer is a separate session. It shares, but does not own, the source worktree.

## Ask for an adversarial PR review

Ask the working session directly:

> Run an adversarial review of the PR attached to this session.

The `adversarial-pr-review` skill resolves the PR, launches the opposite provider, and returns findings
through Wrangler mail. It requires both Claude Code and Codex; with one provider, use peer review.

## Attach a pull request

The board can detect a branch's pull request automatically, or an agent can attach one using the
`links` skill. Links can belong to a session or task.

With authenticated `gh`, card indicators track required checks, merge conflicts, PR state, and new
unresolved review threads.

## Auto-fix PR checks

**Auto-fix PR checks** defaults on for new sessions and can be changed in **Settings → Automation** or
per session. It nudges the agent about failing checks, conflicts, and new unresolved threads without
repeating unchanged failures.

## Auto-merge

**Auto-merge when checks pass** is an off-by-default session option and Workflow launch setting. It
uses authenticated `gh` to merge the attached PR when required checks become green.
