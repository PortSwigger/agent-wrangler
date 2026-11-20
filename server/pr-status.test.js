import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchPrStatus, mergePr, fetchUnresolvedThreadCount, fetchPrDiff, fetchPrObservation, fetchUnresolvedThreads } from './pr-status.js';

const runner = (stdout, code = 0) => async () => ({ code, stdout });
const prRunner = (text, isDraft = false) => {
  const [state, rollup, mergeStateStatus, reviewDecision, headRefOid] = text.replace(/\r?\n$/, '').split('\t');
  const statusCheckRollup = { passing: [{ conclusion: 'SUCCESS' }], failing: [{ conclusion: 'FAILURE' }],
    pending: [{ conclusion: '', status: 'IN_PROGRESS' }], none: [] }[rollup];
  return runner(JSON.stringify({ state, statusCheckRollup, mergeStateStatus, reviewDecision, headRefOid,
    id: 'PR_42', createdAt: '2026-11-15T10:00:00Z', title: 'A change', number: 42, isDraft }));
};
const metadata = { nodeId: 'PR_42', createdAt: '2026-11-15T10:00:00Z', title: 'A change', number: 42, isDraft: false };

test('mergeStateStatus CLEAN with an all-green rollup is passing', async () => {
  assert.deepEqual(await fetchPrStatus('u', prRunner('OPEN\tpassing\tCLEAN\tAPPROVED\t293558cba987\n')),
    { ...metadata, mergeStateStatus: 'CLEAN', statusCheckRollup: [{ conclusion: 'SUCCESS' }], state: 'OPEN', checkStatus: 'passing', reviewDecision: 'APPROVED', dirty: false, headSha: '293558cba987' });
});

test('a draft remains unmergeable even with a green rollup and CLEAN merge state', async () => {
  const draft = await fetchPrStatus('u', prRunner('OPEN\tpassing\tCLEAN\t\tsha\n', true));
  assert.equal(draft.checkStatus, 'draft');
  assert.equal((await fetchPrStatus('u', prRunner('OPEN\tpassing\tDRAFT\t\tsha\n'))).checkStatus, 'draft');
  assert.equal((await fetchPrStatus('u', prRunner('OPEN\tfailing\tCLEAN\t\tsha\n', true))).checkStatus, 'failing');
});

test('REGRESSION: an all-green rollup but BLOCKED merge state is pending, not passing', async () => {
  // The rollup holds only the checks already attached to the head commit; a
  // required check whose suite has not started is simply absent, so an all-green
  // rollup can still be BLOCKED. We must NOT fire "checks passed" here.
  assert.deepEqual(await fetchPrStatus('u', prRunner('OPEN\tpassing\tBLOCKED\t\tsha-blocked\n')),
    { ...metadata, mergeStateStatus: 'BLOCKED', statusCheckRollup: [{ conclusion: 'SUCCESS' }], state: 'OPEN', checkStatus: 'pending', reviewDecision: '', dirty: false, headSha: 'sha-blocked' });
});

test('mergeStateStatus DIRTY sets dirty, independent of checkStatus (a DIRTY PR with green CI stays pending)', async () => {
  const res = await fetchPrStatus('u', prRunner('OPEN\tpassing\tDIRTY\t\tsha\n'));
  assert.equal(res.dirty, true);
  assert.equal(res.checkStatus, 'pending');
});

test('any non-DIRTY mergeStateStatus reports dirty: false', async () => {
  assert.equal((await fetchPrStatus('u', prRunner('OPEN\tpassing\tCLEAN\t\tsha\n'))).dirty, false);
  assert.equal((await fetchPrStatus('u', prRunner('OPEN\tpassing\tBLOCKED\t\tsha\n'))).dirty, false);
  assert.equal((await fetchPrStatus('u', prRunner('OPEN\tpassing\tUNKNOWN\t\tsha\n'))).dirty, false);
});

test('an all-green rollup with UNKNOWN/BEHIND merge state is pending', async () => {
  assert.equal((await fetchPrStatus('u', prRunner('OPEN\tpassing\tUNKNOWN\t\tsha\n'))).checkStatus, 'pending');
  assert.equal((await fetchPrStatus('u', prRunner('OPEN\tpassing\tBEHIND\t\tsha\n'))).checkStatus, 'pending');
});

test('a real failing rollup conclusion is failing even before the merge state settles', async () => {
  // Genuine check failures must notify promptly, driven by the rollup, even when
  // mergeStateStatus is not yet CLEAN (BLOCKED/UNKNOWN).
  assert.equal((await fetchPrStatus('u', prRunner('OPEN\tfailing\tBLOCKED\t\tsha\n'))).checkStatus, 'failing');
  assert.equal((await fetchPrStatus('u', prRunner('OPEN\tfailing\tUNKNOWN\t\tsha\n'))).checkStatus, 'failing');
});

test('a still-running rollup is pending regardless of merge state', async () => {
  assert.equal((await fetchPrStatus('u', prRunner('OPEN\tpending\tBLOCKED\t\tsha\n'))).checkStatus, 'pending');
});

test('no checks at all is none when not mergeable, passing once CLEAN', async () => {
  assert.equal((await fetchPrStatus('u', prRunner('OPEN\tnone\tBLOCKED\t\tsha\n'))).checkStatus, 'none');
  assert.equal((await fetchPrStatus('u', prRunner('OPEN\tnone\tCLEAN\t\tsha\n'))).checkStatus, 'passing');
});

test('reviewDecision passes through (the attribution signal for a non-CLEAN block)', async () => {
  assert.equal((await fetchPrStatus('u', prRunner('OPEN\tpassing\tBLOCKED\tREVIEW_REQUIRED\tsha\n'))).reviewDecision,
    'REVIEW_REQUIRED');
  assert.equal((await fetchPrStatus('u', prRunner('OPEN\tpending\tBLOCKED\tCHANGES_REQUESTED\tsha\n'))).reviewDecision,
    'CHANGES_REQUESTED');
  assert.equal((await fetchPrStatus('u', prRunner('OPEN\tpassing\tCLEAN\t\tsha\n'))).reviewDecision, '');
});

test('CI green but blocked on a required review is awaiting-review', async () => {
  assert.equal((await fetchPrStatus('u', prRunner('OPEN\tpassing\tBLOCKED\tREVIEW_REQUIRED\tsha\n'))).checkStatus,
    'awaiting-review');
});

test('awaiting-review needs the rollup actually green — checks still running stays pending', async () => {
  // Don't claim "CI green, awaiting review" while checks are still in flight.
  assert.equal((await fetchPrStatus('u', prRunner('OPEN\tpending\tBLOCKED\tREVIEW_REQUIRED\tsha\n'))).checkStatus,
    'pending');
});

test('changes requested is its own status, even while checks are still running', async () => {
  // CHANGES_REQUESTED is an action item (like a failing check), so it surfaces
  // regardless of whether the rollup is green or still in progress.
  assert.equal((await fetchPrStatus('u', prRunner('OPEN\tpassing\tBLOCKED\tCHANGES_REQUESTED\tsha\n'))).checkStatus,
    'changes-requested');
  assert.equal((await fetchPrStatus('u', prRunner('OPEN\tpending\tBLOCKED\tCHANGES_REQUESTED\tsha\n'))).checkStatus,
    'changes-requested');
});

test('a real check failure outranks any review state', async () => {
  assert.equal((await fetchPrStatus('u', prRunner('OPEN\tfailing\tBLOCKED\tCHANGES_REQUESTED\tsha\n'))).checkStatus,
    'failing');
});

test('CLEAN is passing regardless of a prior review state', async () => {
  assert.equal((await fetchPrStatus('u', prRunner('OPEN\tpassing\tCLEAN\tAPPROVED\tsha\n'))).checkStatus, 'passing');
});

test('an unrecognised reviewDecision normalises to empty (never throws on a new enum)', async () => {
  assert.equal((await fetchPrStatus('u', prRunner('OPEN\tpassing\tCLEAN\tWEIRD\tsha\n'))).reviewDecision, '');
});

test('MERGED/CLOSED states pass through (drive auto-removal)', async () => {
  assert.deepEqual(await fetchPrStatus('u', prRunner('MERGED\tpassing\tCLEAN\tAPPROVED\tsha-merged\n')),
    { ...metadata, mergeStateStatus: 'CLEAN', statusCheckRollup: [{ conclusion: 'SUCCESS' }], state: 'MERGED', checkStatus: 'passing', reviewDecision: 'APPROVED', dirty: false, headSha: 'sha-merged' });
  assert.equal((await fetchPrStatus('u', prRunner('CLOSED\tnone\t\t\tsha-closed\n'))).state, 'CLOSED');
});

test('a non-zero gh exit yields null (caller keeps previous value)', async () => {
  assert.equal(await fetchPrStatus('u', runner('', 1)), null);
});

test('an unknown state or rollup word yields null', async () => {
  assert.equal(await fetchPrStatus('u', prRunner('OPEN\tweird\tCLEAN\t\tsha\n')), null);
  assert.equal(await fetchPrStatus('u', prRunner('DRAFT\tpassing\tCLEAN\t\tsha\n')), null);
  assert.equal(await fetchPrStatus('u', prRunner('OPEN\tpassing\tCLEAN\t\n')), null); // too few fields
});

test('unparseable/empty output yields null', async () => {
  assert.equal(await fetchPrStatus('u', runner('   \n', 0)), null);
  assert.equal(await fetchPrStatus('u', runner('weird', 0)), null);
});

test('a runner that throws yields null, never propagates', async () => {
  const throwing = async () => { throw new Error('spawn ENOENT'); };
  assert.equal(await fetchPrStatus('u', throwing), null);
});

// mergeRun(url) resolves { code, stderr } mimicking `gh pr merge`.
const mergeRun = (code, stderr = '') => async () => ({ code, stderr });

test('mergePr: a zero exit is a success', async () => {
  assert.deepEqual(await mergePr('u', mergeRun(0, '')), { ok: true });
});

test('mergePr: a non-zero exit reports the first stderr line', async () => {
  const res = await mergePr('u', mergeRun(1, 'Pull request is not mergeable\nmore detail\n'));
  assert.equal(res.ok, false);
  assert.equal(res.error, 'Pull request is not mergeable');
});

test('mergePr: a non-zero exit with empty stderr falls back to the exit code', async () => {
  const res = await mergePr('u', mergeRun(2, ''));
  assert.equal(res.ok, false);
  assert.equal(res.error, 'gh pr merge exited 2');
});

test('mergePr: a runner that throws is caught, never propagates', async () => {
  const res = await mergePr('u', async () => { throw new Error('spawn ENOENT'); });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'spawn ENOENT');
});

// unresolvedRun(stdout, code) mimics the `gh api graphql -q` invocation: stdout
// is just the bare unresolved count jq already extracted.
const unresolvedRun = (stdout, code = 0) => async () => ({ code, stdout });

test('fetchUnresolvedThreadCount returns the count on success', async () => {
  assert.equal(await fetchUnresolvedThreadCount('u', unresolvedRun('3\n')), 3);
  assert.equal(await fetchUnresolvedThreadCount('u', unresolvedRun('0\n')), 0);
});

test('fetchUnresolvedThreadCount returns null on a non-zero exit (missing/inaccessible PR)', async () => {
  assert.equal(await fetchUnresolvedThreadCount('u', unresolvedRun('', 1)), null);
});

test('fetchUnresolvedThreadCount returns null on unparseable output', async () => {
  assert.equal(await fetchUnresolvedThreadCount('u', unresolvedRun('weird\n')), null);
  assert.equal(await fetchUnresolvedThreadCount('u', unresolvedRun('-1\n')), null);
  assert.equal(await fetchUnresolvedThreadCount('u', unresolvedRun('\n')), null);
});

test('fetchUnresolvedThreadCount: a runner that throws yields null, never propagates', async () => {
  const throwing = async () => { throw new Error('spawn ENOENT'); };
  assert.equal(await fetchUnresolvedThreadCount('u', throwing), null);
});

test('fetchPrDiff calls the supplied PR diff runner with the URL', async () => {
  const calls = [];
  const res = await fetchPrDiff('https://github.com/acme/widgets/pull/42', async (url) => {
    calls.push(url);
    return { stdout: 'diff --git a/a b/a\n' };
  });
  assert.deepEqual(calls, ['https://github.com/acme/widgets/pull/42']);
  assert.equal(res.stdout, 'diff --git a/a b/a\n');
});


test('PR JSON preserves the complete observation and raw check rollup', async () => {
  const raw = { id: 'PR_42', createdAt: '2026-11-15T10:00:00Z', state: 'OPEN', title: 'Tabs\tand \"quotes\"', number: 42, isDraft: true,
    headRefOid: 'head', mergeStateStatus: 'BLOCKED', reviewDecision: 'REVIEW_REQUIRED',
    statusCheckRollup: [{ name: 'build', conclusion: '', status: 'IN_PROGRESS', detailsUrl: 'https://example.com' }] };
  const result = await fetchPrObservation('u', runner(JSON.stringify(raw)));
  assert.equal(result.error, null);
  assert.equal(result.status.title, raw.title);
  assert.equal(result.status.isDraft, true);
  assert.equal(result.status.headSha, 'head');
  assert.equal(result.status.checkStatus, 'draft');
  assert.equal(result.status.mergeStateStatus, 'BLOCKED');
  assert.deepEqual(result.status.statusCheckRollup, raw.statusCheckRollup);
});

test('observation failures carry diagnostics without changing fetchPrStatus null behavior', async () => {
  const result = await fetchPrObservation('u', async () => ({ code: 1, stdout: '', stderr: 'offline\nmore' }));
  assert.deepEqual(result, { status: null, error: 'offline' });
  assert.equal((await fetchPrObservation('u', runner('invalid'))).status, null);
  assert.match((await fetchPrObservation('u', runner('invalid'))).error, /invalid/i);
});


test('fetchUnresolvedThreads returns author, current or original location and bounded root comments', async () => {
  const result = await fetchUnresolvedThreads('u', unresolvedRun(JSON.stringify([
    { id: 't1', path: 'app.js', line: 42, comments: { nodes: [{ author: { login: 'reviewer' }, body: 'Please fix this' }] } },
    { id: 't2', path: 'old.js', line: null, originalLine: 7, comments: { nodes: [{ author: null, body: 'x'.repeat(1000) }] } },
    { id: 't3', path: 'empty.js', comments: { nodes: [] } },
  ])));
  assert.deepEqual(result[0], { id: 't1', author: 'reviewer', path: 'app.js', line: 42, body: 'Please fix this' });
  assert.equal(result[1].line, 7);
  assert.equal(result[1].author, null);
  assert.equal(result[1].body.length, 321);
  assert.equal(result[2].body, '');
  assert.deepEqual(await fetchUnresolvedThreads('u', unresolvedRun('[]')), []);
});

test('fetchUnresolvedThreads preserves the null-on-failure contract', async () => {
  for (const output of ['', 'null', '{}', 'not json', '[null]']) {
    assert.equal(await fetchUnresolvedThreads('u', unresolvedRun(output)), null);
  }
  assert.equal(await fetchUnresolvedThreads('u', unresolvedRun('[]', 1)), null);
  assert.equal(await fetchUnresolvedThreads('u', async () => { throw new Error('unavailable'); }), null);
});
