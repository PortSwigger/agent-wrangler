import { execFile } from 'node:child_process';

const FIELDS = 'id,createdAt,state,title,number,isDraft,statusCheckRollup,mergeStateStatus,reviewDecision,headRefOid';
const FAILING = new Set(['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED']);
const PENDING = new Set(['PENDING', 'IN_PROGRESS', 'QUEUED', 'EXPECTED']);

function checkRollup(checks) {
  if (!checks.length) return 'none';
  const states = checks.map((c) => c.conclusion || c.status || c.state);
  if (states.some((s) => FAILING.has(s))) return 'failing';
  if (states.some((s) => PENDING.has(s))) return 'pending';
  return 'passing';
}

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

function defaultRun(url) {
  return new Promise((resolve) => {
    execFile('gh', ['pr', 'view', url, '--json', FIELDS], { timeout: 15000 },
      (err, stdout, stderr) => resolve({ code: err ? (err.code ?? 1) : 0, stdout: stdout || '', stderr: stderr || '' }));
  });
}

export async function fetchPrObservation(url, run = defaultRun) {
  try {
    const { code, stdout, stderr } = await run(url);
    if (code !== 0) return { status: null, error: String(stderr || '').trim().split('\n')[0] || `gh pr view exited ${code}` };
    const raw = JSON.parse(stdout);
    if (!VALID_STATE.has(raw?.state) || !Array.isArray(raw.statusCheckRollup)
        || raw.statusCheckRollup.some((c) => !c || typeof c !== 'object')
        || typeof raw.title !== 'string' || !Number.isSafeInteger(raw.number) || raw.number <= 0
        || typeof raw.id !== 'string' || !raw.id || typeof raw.createdAt !== 'string' || !Number.isFinite(Date.parse(raw.createdAt))
        || typeof raw.isDraft !== 'boolean' || typeof raw.headRefOid !== 'string') {
      return { status: null, error: 'Invalid gh pr view response' };
    }
    const reviewDecision = VALID_REVIEW.has(raw.reviewDecision) ? raw.reviewDecision : '';
    const mergeStateStatus = raw.mergeStateStatus ?? '';
    return { error: null, status: {
      nodeId: raw.id, createdAt: raw.createdAt, state: raw.state, title: raw.title, number: raw.number, isDraft: raw.isDraft,
      statusCheckRollup: raw.statusCheckRollup, mergeStateStatus, reviewDecision,
      checkStatus: deriveCheckStatus(checkRollup(raw.statusCheckRollup), mergeStateStatus, reviewDecision),
      dirty: mergeStateStatus === 'DIRTY', headSha: raw.headRefOid,
    } };
  } catch (err) {
    return { status: null, error: err instanceof SyntaxError ? 'Invalid gh pr view response' : (err?.message || 'gh pr view failed') };
  }
}

export async function fetchPrStatus(url, run = defaultRun) {
  return (await fetchPrObservation(url, run)).status;
}

// Default merge runner: `gh pr merge <url> --squash`. --squash is hardcoded
// because the merge runs non-interactively (no TTY to pick a method) and a
// squash is the sensible default for an autopilot feature branch (matches this
// repo's own single-commit-per-PR history). We deliberately do NOT pass
// --delete-branch: the branch is checked out in the worktree created by Agent Wrangler
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
const UNRESOLVED_QUERY = 'query($url:URI!){resource(url:$url){...on PullRequest{reviewThreads(first:100){nodes{id isResolved path line originalLine comments(first:1){nodes{author{login} body}}}}}}}';
const UNRESOLVED_JQ = '.data.resource.reviewThreads.nodes | map(select(.isResolved==false)) | length';

function defaultUnresolvedRun(url, jq = UNRESOLVED_JQ) {
  return new Promise((resolve) => {
    execFile('gh', ['api', 'graphql', '-f', `query=${UNRESOLVED_QUERY}`, '-f', `url=${url}`,
      '-q', jq], { timeout: 15000 },
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

export async function fetchUnresolvedThreads(url, run = (u) => defaultUnresolvedRun(u,
  '.data.resource.reviewThreads.nodes | map(select(.isResolved==false) | .comments.nodes |= map(.body = ((.body // "") | .[0:321])))')) {
  try {
    const { code, stdout } = await run(url);
    if (code !== 0) return null;
    const threads = JSON.parse(stdout);
    if (!Array.isArray(threads)) return null;
    return threads.map((thread) => ({
      id: thread.id,
      author: thread.comments?.nodes?.[0]?.author?.login ?? null,
      path: thread.path,
      line: thread.line ?? thread.originalLine ?? null,
      body: String(thread.comments?.nodes?.[0]?.body ?? '').slice(0, 321),
    }));
  } catch {
    return null;
  }
}

function defaultDiffRun(url) {
  return new Promise((resolve, reject) => {
    execFile('gh', ['pr', 'diff', url], { timeout: 15000 }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr || err.stderr;
        reject(err);
        return;
      }
      resolve({ stdout: stdout || '' });
    });
  });
}

export async function fetchPrDiff(url, run = defaultDiffRun) {
  return run(url);
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
