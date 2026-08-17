import { execFile } from 'node:child_process';

// The jq derivation runs INSIDE gh (-q), so stdout is four tab-separated fields:
// `<state>\t<rollup>\t<mergeStateStatus>\t<reviewDecision>`. The PR's own state
// (OPEN/MERGED/CLOSED), a *rollup word* derived from .statusCheckRollup, and the
// two free fields that turn the rollup into an authoritative checkStatus.
//
// The rollup word mirrors paddy-log's logic, including the in-progress gotcha: a
// running CheckRun reports .conclusion as an empty string '' (not null), so
// normalise '' to absent FIRST, then fall back to .status/.state — otherwise a
// running check is misread as passing. The PR `.state` referenced last is the
// top-level field; the per-check `.state` inside the map() is a separate scope.
//
// CRITICAL: .statusCheckRollup holds ONLY the checks already attached to the head
// commit at fetch time — it has NO knowledge of branch-protection required
// contexts. A required check whose suite hasn't started is simply ABSENT (not
// present-as-pending), so an all-green rollup can still be unmergeable. That's
// why the rollup word alone is NOT the answer: the final passing verdict is
// gated on mergeStateStatus == CLEAN (computed by GitHub against the full
// required-contexts list + reviews + up-to-dateness) in deriveCheckStatus below.
// mergeStateStatus/reviewDecision are free fields on the same gh call — no extra
// API request and no admin token (the branch-protection contexts endpoint needs
// admin and 403s on non-admin repos, so we deliberately do not call it).
const JQ = `
  ( .statusCheckRollup
    | (map( (.conclusion // "") as $c | (if $c=="" then (.status // .state) else $c end) )) as $s
    | if ($s|length)==0 then "none"
      elif ($s|any(. as $x | ["FAILURE","ERROR","CANCELLED","TIMED_OUT","ACTION_REQUIRED"]|index($x))) then "failing"
      elif ($s|any(. as $x | ["PENDING","IN_PROGRESS","QUEUED","EXPECTED"]|index($x))) then "pending"
      else "passing" end ) as $rollup
  | "\\(.state)\\t\\($rollup)\\t\\(.mergeStateStatus // "")\\t\\(.reviewDecision // "")"`;

// The raw word the JQ derives from the rollup alone (validated on input). The
// final checkStatus deriveCheckStatus emits is a wider vocabulary — it also
// yields `awaiting-review`/`changes-requested` by folding in reviewDecision so
// the notifier can fire distinct nudges; those persist on links and are compared
// by the diff, so the value set must stay forward-compatible.
const ROLLUP = new Set(['passing', 'failing', 'pending', 'none']);
const VALID_STATE = new Set(['OPEN', 'MERGED', 'CLOSED']);
const VALID_REVIEW = new Set(['', 'APPROVED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED']);

// Collapse the rollup word + mergeStateStatus + reviewDecision into one PR
// readiness word, in strict precedence:
//  - a genuine FAILURE conclusion in the rollup is `failing` immediately, even
//    before mergeStateStatus settles — real failures must notify promptly;
//  - otherwise `passing` ONLY when mergeStateStatus == CLEAN (the sole signal
//    that knows about not-yet-reported required checks, reviews and base-ahead).
//    `passing` therefore means genuinely *mergeable* and is the auto-merge gate;
//  - not mergeable + CHANGES_REQUESTED is `changes-requested` regardless of the
//    rollup (it's an action item like a failure — the agent must address it);
//  - CI green (rollup `passing`) + a still-needed review is `awaiting-review`;
//    we require the rollup green so we don't claim "CI green" while checks run;
//  - an all-green-but-not-CLEAN PR with no review block (behind base / a required
//    check not yet reported) stays `pending`, so we never fire a false "passed";
//  - genuinely no checks stays `none` until a CLEAN state proves it mergeable.
function deriveCheckStatus(rollup, mergeStateStatus, reviewDecision) {
  if (rollup === 'failing') return 'failing';
  if (mergeStateStatus === 'CLEAN') return 'passing';
  if (reviewDecision === 'CHANGES_REQUESTED') return 'changes-requested';
  if (reviewDecision === 'REVIEW_REQUIRED' && rollup === 'passing') return 'awaiting-review';
  if (rollup === 'none') return 'none';
  return 'pending';
}

// Default runner: run `gh pr view <url> --json <fields> -q <jq>`.
function defaultRun(url) {
  return new Promise((resolve) => {
    execFile('gh', ['pr', 'view', url, '--json', 'state,statusCheckRollup,mergeStateStatus,reviewDecision',
      '-q', JQ], { timeout: 15000 },
      (err, stdout) => resolve({ code: err ? (err.code ?? 1) : 0, stdout: stdout || '' }));
  });
}

// Resolve a PR's { state, checkStatus, reviewDecision, dirty }, or null on any
// failure (caller keeps the prior value). `state` drives auto-removal on
// MERGED/CLOSED; `checkStatus` drives the CI board/pane notifier; `reviewDecision`
// is the attribution signal for a non-CLEAN block (REVIEW_REQUIRED/CHANGES_REQUESTED
// ⇒ reviews are the blocker; ''/APPROVED ⇒ a BLOCKED state is checks/base-ahead, not
// reviews). `dirty` is GitHub's own DIRTY value of mergeStateStatus — the branch has
// merge conflicts against its base and needs a rebase before it can be merged at
// all, orthogonal to CI: a PR can be DIRTY with fully green checks (checkStatus
// stays `pending` there, since mergeStateStatus isn't CLEAN), so it needs its own
// signal rather than folding into checkStatus's vocabulary. Never throws.
export async function fetchPrStatus(url, run = defaultRun) {
  try {
    const { code, stdout } = await run(url);
    if (code !== 0) return null;
    // Strip only the trailing newline, not via trim(): reviewDecision (the last
    // field) is empty when no review is required, and trim() would eat the tab.
    const parts = String(stdout).replace(/\r?\n$/, '').split('\t');
    if (parts.length !== 4) return null;
    const [state, rollup, mergeStateStatus, review] = parts;
    if (!VALID_STATE.has(state) || !ROLLUP.has(rollup)) return null;
    const reviewDecision = VALID_REVIEW.has(review) ? review : '';
    const checkStatus = deriveCheckStatus(rollup, mergeStateStatus, reviewDecision);
    return { state, checkStatus, reviewDecision, dirty: mergeStateStatus === 'DIRTY' };
  } catch {
    return null;
  }
}

// Default merge runner: `gh pr merge <url> --squash`. --squash is hardcoded
// because the merge runs non-interactively (no TTY to pick a method) and a
// squash is the sensible default for an autopilot feature branch (matches this
// repo's own single-commit-per-PR history). We deliberately do NOT pass
// --delete-branch: the branch is checked out in the wrangler-created worktree
// (so a local delete would fail), and the existing archive-time cleanup flow
// owns branch/worktree removal. Resolves { code, stderr }.
function defaultMerge(url) {
  return new Promise((resolve) => {
    execFile('gh', ['pr', 'merge', url, '--squash'], { timeout: 30000 },
      (err, _stdout, stderr) => resolve({ code: err ? (err.code ?? 1) : 0, stderr: stderr || '' }));
  });
}

// `gh pr view --json` has no `reviewThreads` field — only GraphQL's `resource(url:)`
// exposes inline review-thread `isResolved` state, so this is a SEPARATE `gh api
// graphql` call, keyed directly off the PR url (no owner/repo/number parsing
// needed). `first: 100` caps the thread list; a PR with more silently undercounts
// (not worth paginating for v1). The jq filter runs inside gh, so stdout is just
// the unresolved count as a bare integer.
const UNRESOLVED_QUERY = 'query($url:URI!){resource(url:$url){...on PullRequest{reviewThreads(first:100){nodes{isResolved}}}}}';
const UNRESOLVED_JQ = '.data.resource.reviewThreads.nodes | map(select(.isResolved==false)) | length';

function defaultUnresolvedRun(url) {
  return new Promise((resolve) => {
    execFile('gh', ['api', 'graphql', '-f', `query=${UNRESOLVED_QUERY}`, '-f', `url=${url}`,
      '-q', UNRESOLVED_JQ], { timeout: 15000 },
      (err, stdout) => resolve({ code: err ? (err.code ?? 1) : 0, stdout: stdout || '' }));
  });
}

// Resolve a PR's unresolved review-THREAD count, or null on any failure (a
// missing/inaccessible PR makes `resource` null, which the jq filter's `map`
// over null fails on — same never-throws, null-on-failure contract as
// fetchPrStatus, so the caller keeps its prior value rather than clobbering it).
export async function fetchUnresolvedThreadCount(url, run = defaultUnresolvedRun) {
  try {
    const { code, stdout } = await run(url);
    if (code !== 0) return null;
    const trimmed = String(stdout).trim();
    // Number('') is 0, not NaN — an explicit non-empty check is needed so blank
    // output isn't misread as a genuine zero count.
    if (!trimmed) return null;
    const n = Number(trimmed);
    return Number.isInteger(n) && n >= 0 ? n : null;
  } catch {
    return null;
  }
}

// Merge a PR via gh, returning { ok, error }. Never throws — a failed merge
// (branch protection, conflicts, method not allowed) is surfaced to the user as
// a toast/pane nudge so they can merge manually, never a crash. The error text
// is the trimmed first line of gh's stderr (kept short for the pane/toast).
export async function mergePr(url, run = defaultMerge) {
  try {
    const { code, stderr } = await run(url);
    if (code === 0) return { ok: true };
    const error = String(stderr).trim().split('\n')[0] || `gh pr merge exited ${code}`;
    return { ok: false, error };
  } catch (e) {
    return { ok: false, error: e?.message || 'gh pr merge failed' };
  }
}
