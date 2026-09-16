import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchPrStatus, mergePr, mergePrArgs, fetchUnresolvedThreadCount, fetchPrDiff } from './pr-status.js';

// run(url) resolves { code, stdout } mimicking the gh invocation; stdout is the
// `<state>\t<rollup>\t<mergeStateStatus>\t<reviewDecision>\t<headRefOid>` the in-gh jq
// derivation produces. The final checkStatus is derived in JS from the rollup
// word gated by mergeStateStatus (passing ONLY when CLEAN).
const runner = (stdout, code = 0) => async () => ({ code, stdout });
const HEAD = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

test('mergeStateStatus CLEAN with an all-green rollup is passing', async () => {
  assert.deepEqual(await fetchPrStatus('u', runner('OPEN\tpassing\tCLEAN\tAPPROVED\t293558cba987\n')),
    { state: 'OPEN', checkStatus: 'passing', reviewDecision: 'APPROVED', dirty: false, headSha: '293558cba987' });
});

test('REGRESSION: an all-green rollup but BLOCKED merge state is pending, not passing', async () => {
  // The rollup holds only the checks already attached to the head commit; a
  // required check whose suite has not started is simply absent, so an all-green
  // rollup can still be BLOCKED. We must NOT fire "checks passed" here.
  assert.deepEqual(await fetchPrStatus('u', runner('OPEN\tpassing\tBLOCKED\t\tsha-blocked\n')),
    { state: 'OPEN', checkStatus: 'pending', reviewDecision: '', dirty: false, headSha: 'sha-blocked' });
});

test('mergeStateStatus DIRTY sets dirty, independent of checkStatus (a DIRTY PR with green CI stays pending)', async () => {
  const res = await fetchPrStatus('u', runner('OPEN\tpassing\tDIRTY\t\tsha\n'));
  assert.equal(res.dirty, true);
  assert.equal(res.checkStatus, 'pending');
});

test('PR status carries exact head and base commits independently of mergeStateStatus', async () => {
  const res = await fetchPrStatus('https://github.com/base/project/pull/7', runner(
    'OPEN\tpassing\tBLOCKED\tAPPROVED\tfeature\taaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\tmain\tbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\tfork/project\ttrue\n',
  ));
  assert.deepEqual(res.rebase, {
    head: { repo: 'fork/project', ref: 'feature', oid: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
    base: { repo: 'base/project', ref: 'main', oid: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
    crossRepository: true,
  });
  assert.equal(res.headSha, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
});

test('any non-DIRTY mergeStateStatus reports dirty: false', async () => {
  assert.equal((await fetchPrStatus('u', runner('OPEN\tpassing\tCLEAN\t\tsha\n'))).dirty, false);
  assert.equal((await fetchPrStatus('u', runner('OPEN\tpassing\tBLOCKED\t\tsha\n'))).dirty, false);
  assert.equal((await fetchPrStatus('u', runner('OPEN\tpassing\tUNKNOWN\t\tsha\n'))).dirty, false);
});

test('an all-green rollup with UNKNOWN/BEHIND merge state is pending', async () => {
  assert.equal((await fetchPrStatus('u', runner('OPEN\tpassing\tUNKNOWN\t\tsha\n'))).checkStatus, 'pending');
  assert.equal((await fetchPrStatus('u', runner('OPEN\tpassing\tBEHIND\t\tsha\n'))).checkStatus, 'pending');
});

test('a real failing rollup conclusion is failing even before the merge state settles', async () => {
  // Genuine check failures must notify promptly, driven by the rollup, even when
  // mergeStateStatus is not yet CLEAN (BLOCKED/UNKNOWN).
  assert.equal((await fetchPrStatus('u', runner('OPEN\tfailing\tBLOCKED\t\tsha\n'))).checkStatus, 'failing');
  assert.equal((await fetchPrStatus('u', runner('OPEN\tfailing\tUNKNOWN\t\tsha\n'))).checkStatus, 'failing');
});

test('a still-running rollup is pending regardless of merge state', async () => {
  assert.equal((await fetchPrStatus('u', runner('OPEN\tpending\tBLOCKED\t\tsha\n'))).checkStatus, 'pending');
});

test('no checks at all is none when not mergeable, passing once CLEAN', async () => {
  assert.equal((await fetchPrStatus('u', runner('OPEN\tnone\tBLOCKED\t\tsha\n'))).checkStatus, 'none');
  assert.equal((await fetchPrStatus('u', runner('OPEN\tnone\tCLEAN\t\tsha\n'))).checkStatus, 'passing');
});

test('reviewDecision passes through (the attribution signal for a non-CLEAN block)', async () => {
  assert.equal((await fetchPrStatus('u', runner('OPEN\tpassing\tBLOCKED\tREVIEW_REQUIRED\tsha\n'))).reviewDecision,
    'REVIEW_REQUIRED');
  assert.equal((await fetchPrStatus('u', runner('OPEN\tpending\tBLOCKED\tCHANGES_REQUESTED\tsha\n'))).reviewDecision,
    'CHANGES_REQUESTED');
  assert.equal((await fetchPrStatus('u', runner('OPEN\tpassing\tCLEAN\t\tsha\n'))).reviewDecision, '');
});

test('CI green but blocked on a required review is awaiting-review', async () => {
  assert.equal((await fetchPrStatus('u', runner('OPEN\tpassing\tBLOCKED\tREVIEW_REQUIRED\tsha\n'))).checkStatus,
    'awaiting-review');
});

test('awaiting-review needs the rollup actually green — checks still running stays pending', async () => {
  // Don't claim "CI green, awaiting review" while checks are still in flight.
  assert.equal((await fetchPrStatus('u', runner('OPEN\tpending\tBLOCKED\tREVIEW_REQUIRED\tsha\n'))).checkStatus,
    'pending');
});

test('changes requested is its own status, even while checks are still running', async () => {
  // CHANGES_REQUESTED is an action item (like a failing check), so it surfaces
  // regardless of whether the rollup is green or still in progress.
  assert.equal((await fetchPrStatus('u', runner('OPEN\tpassing\tBLOCKED\tCHANGES_REQUESTED\tsha\n'))).checkStatus,
    'changes-requested');
  assert.equal((await fetchPrStatus('u', runner('OPEN\tpending\tBLOCKED\tCHANGES_REQUESTED\tsha\n'))).checkStatus,
    'changes-requested');
});

test('a real check failure outranks any review state', async () => {
  assert.equal((await fetchPrStatus('u', runner('OPEN\tfailing\tBLOCKED\tCHANGES_REQUESTED\tsha\n'))).checkStatus,
    'failing');
});

test('CLEAN is passing regardless of a prior review state', async () => {
  assert.equal((await fetchPrStatus('u', runner('OPEN\tpassing\tCLEAN\tAPPROVED\tsha\n'))).checkStatus, 'passing');
});

test('an unrecognised reviewDecision normalises to empty (never throws on a new enum)', async () => {
  assert.equal((await fetchPrStatus('u', runner('OPEN\tpassing\tCLEAN\tWEIRD\tsha\n'))).reviewDecision, '');
});

test('MERGED/CLOSED states pass through (drive auto-removal)', async () => {
  assert.deepEqual(await fetchPrStatus('u', runner('MERGED\tpassing\tCLEAN\tAPPROVED\tsha-merged\n')),
    { state: 'MERGED', checkStatus: 'passing', reviewDecision: 'APPROVED', dirty: false, headSha: 'sha-merged' });
  assert.equal((await fetchPrStatus('u', runner('CLOSED\tnone\t\t\tsha-closed\n'))).state, 'CLOSED');
});

test('a non-zero gh exit yields null (caller keeps previous value)', async () => {
  assert.equal(await fetchPrStatus('u', runner('', 1)), null);
});

test('an unknown state or rollup word yields null', async () => {
  assert.equal(await fetchPrStatus('u', runner('OPEN\tweird\tCLEAN\t\tsha\n')), null);
  assert.equal(await fetchPrStatus('u', runner('DRAFT\tpassing\tCLEAN\t\tsha\n')), null);
  assert.equal(await fetchPrStatus('u', runner('OPEN\tpassing\tCLEAN\t\n')), null); // too few fields
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
  assert.deepEqual(await mergePr('u', { run: mergeRun(0, '') }), { ok: true });
});

test('mergePr: a non-zero exit reports the first stderr line', async () => {
  const res = await mergePr('u', { run: mergeRun(1, 'Pull request is not mergeable\nmore detail\n') });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'Pull request is not mergeable');
});

test('mergePr: a non-zero exit with empty stderr falls back to the exit code', async () => {
  const res = await mergePr('u', { run: mergeRun(2, '') });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'gh pr merge exited 2');
});

test('mergePr: a runner that throws is caught, never propagates', async () => {
  const res = await mergePr('u', { run: async () => { throw new Error('spawn ENOENT'); } });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'spawn ENOENT');
});

test('mergePr pins the merge to the observed head commit', async () => {
  const calls = [];
  const run = async (...args) => { calls.push(args); return { code: 0, stderr: '' }; };
  assert.deepEqual(await mergePr('https://github.com/acme/widgets/pull/42', { headSha: HEAD, run }), { ok: true });
  assert.deepEqual(calls, [['https://github.com/acme/widgets/pull/42', HEAD]]);
  assert.deepEqual(mergePrArgs('https://github.com/acme/widgets/pull/42', HEAD), [
    'pr', 'merge', 'https://github.com/acme/widgets/pull/42', '--squash', '--match-head-commit', HEAD,
  ]);
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
