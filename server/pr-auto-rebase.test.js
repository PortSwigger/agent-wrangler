import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyFetchedStatusBeforeAutoRebase, checkoutSessionsAreIdle, createPrAutoRebaser, createRoutineTransitionQueue, deliverRoutineTransitionAfterRebase, statusAfterAutoRebase } from './pr-auto-rebase.js';

const HEAD = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const BASE = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const rebase = {
  head: { repo: 'acme/project', ref: 'feature', oid: HEAD },
  base: { repo: 'acme/project', ref: 'main', oid: BASE },
  crossRepository: false,
};

test('a successful rebase invalidates stale passing or dirty status until GitHub reports fresh checks', () => {
  const status = { checkStatus: 'passing', dirty: true, headSha: HEAD, rebase };
  assert.deepEqual(statusAfterAutoRebase(status, { kind: 'rebased', newHead: 'cccccccccccccccccccccccccccccccccccccccc' }), {
    checkStatus: 'pending', dirty: false, headSha: 'cccccccccccccccccccccccccccccccccccccccc', rebase,
  });
  assert.equal(statusAfterAutoRebase(status, { kind: 'failed' }), status);
  assert.equal(statusAfterAutoRebase({ ...status, checkStatus: 'changes-requested' }, { kind: 'rebased' }).checkStatus,
    'changes-requested');
});

test('completed rebase repair is applied after a stale fetched status write', async () => {
  let stored = null;
  await applyFetchedStatusBeforeAutoRebase(
    () => { stored = { checkStatus: 'failing', dirty: true }; },
    async () => { stored = { checkStatus: 'pending', dirty: false }; },
  );
  assert.deepEqual(stored, { checkStatus: 'pending', dirty: false });
});

test('routine transitions wait for an admitted rebase and survive a deferral', async () => {
  const delivered = [];
  let settle;
  const result = deliverRoutineTransitionAfterRebase(
    new Promise((resolve) => { settle = resolve; }),
    () => delivered.push('delivered'),
  );
  assert.deepEqual(delivered, []);
  settle({ kind: 'deferred', reason: 'dirty-worktree' });
  assert.equal(await result, true);
  assert.deepEqual(delivered, ['delivered']);
});

test('a rewritten or newly-notified failure supersedes the routine transition', async () => {
  for (const result of [
    { kind: 'rebased' },
    { kind: 'conflict', notified: true },
    { kind: 'failed', notified: true },
  ]) {
    let delivered = false;
    assert.equal(await deliverRoutineTransitionAfterRebase(
      Promise.resolve(result),
      () => { delivered = true; },
    ), false);
    assert.equal(delivered, false);
  }
});

test('a deduplicated failure does not swallow a later routine transition', async () => {
  let delivered = false;
  assert.equal(await deliverRoutineTransitionAfterRebase(
    Promise.resolve({ kind: 'failed', notified: false }),
    () => { delivered = true; },
  ), true);
  assert.equal(delivered, true);
});

test('a transition with no admitted rebase is delivered immediately', async () => {
  let delivered = false;
  assert.equal(await deliverRoutineTransitionAfterRebase(null, () => { delivered = true; }), true);
  assert.equal(delivered, true);
});

test('routine transitions for one PR are delivered sequentially', async () => {
  const queue = createRoutineTransitionQueue();
  const delivered = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const first = queue('session:S1:pr', null, async () => {
    delivered.push('checks-start');
    await gate;
    delivered.push('checks-end');
  });
  const second = queue('session:S1:pr', null, async () => { delivered.push('dirty'); });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(delivered, ['checks-start']);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(delivered, ['checks-start', 'checks-end', 'dirty']);
});

test('shared checkout admission ignores dormant cards but blocks every non-idle live session', () => {
  const dormant = { key: '/repo', session: { dormant: true, managed: false, status: 'idle' } };
  const owner = { key: '/repo', session: { managed: true, status: 'idle', hasBackgroundShell: false } };
  assert.equal(checkoutSessionsAreIdle([dormant, owner], '/repo'), true);
  assert.equal(checkoutSessionsAreIdle([
    owner,
    { key: '/repo', session: { managed: false, status: 'working', hasBackgroundShell: false } },
  ], '/repo'), false);
  assert.equal(checkoutSessionsAreIdle([
    owner,
    { key: '/repo', session: { managed: true, status: 'idle', hasBackgroundShell: true } },
  ], '/repo'), false);
});

test('a genuinely mergeable PR skips auto-rebase so auto-merge remains independent', async () => {
  let attempts = 0;
  const autoRebaser = createPrAutoRebaser({
    attempt: async () => { attempts += 1; return { kind: 'rebased' }; },
    sessionFor: () => ({ status: 'idle', managed: true, cwd: '/repo' }),
    rememberFailure: () => {},
    notify: () => {},
  });
  const scheduled = await autoRebaser.schedule({
    link: { scope: 'session', ownerId: 'S1', url: 'https://github.com/acme/project/pull/1' },
    entry: { autoRebaseLinkedPr: true },
    status: { checkStatus: 'passing', rebase },
  });
  assert.equal(scheduled, false);
  assert.equal(attempts, 0);
});

test('a safe-execution failure notifies once but can retry for the same head/base pair', async () => {
  const calls = { attempts: 0, remembered: [], notifications: [] };
  const autoRebaser = createPrAutoRebaser({
    attempt: async () => { calls.attempts += 1; return { kind: 'failed', reason: 'dirty-worktree' }; },
    sessionFor: () => ({ status: 'idle', managed: true, cwd: '/repo' }),
    rememberFailure: (...args) => calls.remembered.push(args),
    notify: (...args) => calls.notifications.push(args),
  });
  const candidate = {
    link: { scope: 'session', ownerId: 'S1', url: 'https://github.com/acme/project/pull/1' },
    entry: { autoRebaseLinkedPr: true, cwd: '/repo' },
    status: { rebase },
  };

  const first = await autoRebaser.consider(candidate);
  const second = await autoRebaser.consider(candidate);

  assert.equal(calls.attempts, 2);
  assert.equal(first.notified, true);
  assert.equal(second.notified, false);
  assert.deepEqual(calls.remembered, [['S1', candidate.link.url, `dirty-worktree:${HEAD}`]]);
  assert.equal(calls.notifications.length, 1);
  assert.equal(calls.notifications[0][1].reason, 'dirty-worktree');
});

test('a transient failure can recover without a head/base change or a second notification', async () => {
  let attempts = 0;
  let notifications = 0;
  const autoRebaser = createPrAutoRebaser({
    attempt: async () => {
      attempts += 1;
      return attempts === 1 ? { kind: 'failed', reason: 'fetch-failed' } : { kind: 'rebased' };
    },
    sessionFor: () => ({ status: 'idle', managed: true, cwd: '/repo' }),
    rememberFailure: () => {},
    notify: () => { notifications += 1; },
  });
  const candidate = {
    link: { scope: 'session', ownerId: 'S1', url: 'https://github.com/acme/project/pull/1' },
    entry: { autoRebaseLinkedPr: true },
    status: { rebase },
  };

  assert.equal((await autoRebaser.consider(candidate)).kind, 'failed');
  assert.equal((await autoRebaser.consider(candidate)).kind, 'rebased');
  assert.equal(attempts, 2);
  assert.equal(notifications, 1);
});

test('a conflict is persisted as blocked and never retried for the same head/base pair', async () => {
  let attempts = 0;
  const blocked = [];
  const autoRebaser = createPrAutoRebaser({
    attempt: async () => { attempts += 1; return { kind: 'conflict', reason: 'rebase-conflict' }; },
    sessionFor: () => ({ status: 'idle', managed: true, cwd: '/repo' }),
    rememberFailure: () => {},
    rememberBlocked: (...args) => blocked.push(args),
    notify: () => {},
  });
  const candidate = {
    link: { scope: 'session', ownerId: 'S1', url: 'https://github.com/acme/project/pull/1' },
    entry: { autoRebaseLinkedPr: true },
    status: { rebase },
  };

  assert.equal((await autoRebaser.consider(candidate)).kind, 'conflict');
  assert.equal(await autoRebaser.consider(candidate), null);
  assert.equal(attempts, 1);
  assert.deepEqual(blocked, [['S1', candidate.link.url, `${HEAD}:${BASE}`]]);
});

test('a conflict against a newly advanced base notifies again before blocking the new pair', async () => {
  const notifications = [];
  const autoRebaser = createPrAutoRebaser({
    attempt: async () => ({ kind: 'conflict', reason: 'rebase-conflict' }),
    sessionFor: () => ({ status: 'idle', managed: true, cwd: '/repo' }),
    rememberFailure: () => {},
    rememberBlocked: () => {},
    notify: (_link, result) => notifications.push(result),
  });
  const candidate = (baseOid) => ({
    link: { scope: 'session', ownerId: 'S1', url: 'https://github.com/acme/project/pull/1' },
    entry: { autoRebaseLinkedPr: true },
    status: { rebase: { ...rebase, base: { ...rebase.base, oid: baseOid } } },
  });

  await autoRebaser.consider(candidate(BASE));
  await autoRebaser.consider(candidate('dddddddddddddddddddddddddddddddddddddddd'));
  assert.equal(notifications.length, 2);
});

test('a persisted conflict block survives coordinator restart', async () => {
  let attempts = 0;
  const autoRebaser = createPrAutoRebaser({
    attempt: async () => { attempts += 1; return { kind: 'rebased' }; },
    sessionFor: () => ({ status: 'idle', managed: true, cwd: '/repo' }),
    rememberFailure: () => {},
    notify: () => {},
  });
  const result = await autoRebaser.consider({
    link: {
      scope: 'session', ownerId: 'S1', url: 'https://github.com/acme/project/pull/1',
      rebaseBlockedKey: `${HEAD}:${BASE}`,
    },
    entry: { autoRebaseLinkedPr: true },
    status: { rebase },
  });
  assert.equal(result, null);
  assert.equal(attempts, 0);
});

test('overlapping full and targeted polls cannot rebase the same checkout twice', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let attempts = 0;
  const autoRebaser = createPrAutoRebaser({
    attempt: async () => { attempts += 1; await gate; return { kind: 'rebased' }; },
    sessionFor: () => ({ status: 'idle', managed: true, cwd: '/repo' }),
    rememberFailure: () => {},
    notify: () => {},
  });
  const candidate = {
    link: { scope: 'session', ownerId: 'S1', url: 'https://github.com/acme/project/pull/1' },
    entry: { autoRebaseLinkedPr: true, cwd: '/repo' },
    status: { rebase },
  };

  const first = autoRebaser.consider(candidate);
  const overlapping = autoRebaser.consider(candidate);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(attempts, 1);
  release();
  assert.equal((await first).kind, 'rebased');
  assert.equal((await overlapping).kind, 'rebased');
});

test('path aliases for one checkout share a single-flight lock', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let attempts = 0;
  const autoRebaser = createPrAutoRebaser({
    attempt: async () => { attempts += 1; await gate; return { kind: 'rebased' }; },
    checkoutKey: async () => '/canonical/repo',
    sessionFor: (id) => ({ status: 'idle', managed: true, cwd: id === 'S1' ? '/repo/a' : '/repo/b' }),
    rememberFailure: () => {},
    notify: () => {},
  });
  const candidate = (ownerId) => ({
    link: { scope: 'session', ownerId, url: 'https://github.com/acme/project/pull/1' },
    entry: { autoRebaseLinkedPr: true },
    status: { rebase },
  });

  const first = autoRebaser.consider(candidate('S1'));
  await new Promise((resolve) => setImmediate(resolve));
  const overlapping = autoRebaser.consider(candidate('S2'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(attempts, 1);
  release();
  assert.equal((await first).kind, 'rebased');
  assert.equal((await overlapping).kind, 'rebased');
});

test('different PR operations with the same commits never share a rebase result', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let attempts = 0;
  const autoRebaser = createPrAutoRebaser({
    attempt: async () => { attempts += 1; if (attempts === 1) await gate; return { kind: 'rebased' }; },
    sessionFor: () => ({ status: 'idle', managed: true, cwd: '/repo' }),
    rememberFailure: () => {},
    notify: () => {},
  });
  const candidate = (number) => ({
    link: { scope: 'session', ownerId: 'S1', url: `https://github.com/acme/project/pull/${number}` },
    entry: { autoRebaseLinkedPr: true },
    status: { rebase },
  });

  const first = autoRebaser.consider(candidate(1));
  const differentPr = autoRebaser.consider(candidate(2));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(attempts, 1);
  release();
  assert.equal((await first).kind, 'rebased');
  assert.equal(await differentPr, null);
  assert.equal((await autoRebaser.consider(candidate(2))).kind, 'rebased');
  assert.equal(attempts, 2);
});

test('stale GitHub status cannot re-run a successful rebase for the same head/base pair', async () => {
  let attempts = 0;
  const autoRebaser = createPrAutoRebaser({
    attempt: async () => { attempts += 1; return { kind: 'rebased' }; },
    sessionFor: () => ({ status: 'idle', managed: true, cwd: '/repo' }),
    rememberFailure: () => {},
    notify: () => {},
  });
  const candidate = {
    link: { scope: 'session', ownerId: 'S1', url: 'https://github.com/acme/project/pull/1' },
    entry: { autoRebaseLinkedPr: true },
    status: { rebase },
  };

  assert.equal((await autoRebaser.consider(candidate)).kind, 'rebased');
  assert.deepEqual(await autoRebaser.consider(candidate), { kind: 'rebased', repeated: true });
  assert.equal(attempts, 1);
});

test('linking a PR does not opt a session into history rewriting', async () => {
  let attempts = 0;
  const autoRebaser = createPrAutoRebaser({
    attempt: async () => { attempts += 1; return { kind: 'rebased' }; },
    sessionFor: () => ({ status: 'idle', managed: true, cwd: '/repo' }),
    rememberFailure: () => {},
    notify: () => {},
  });

  const result = await autoRebaser.consider({
    link: { scope: 'session', ownerId: 'S1', url: 'https://github.com/acme/project/pull/1' },
    entry: { cwd: '/repo' },
    status: { rebase },
  });

  assert.equal(result, null);
  assert.equal(attempts, 0);
});

test('busy and task-scoped links never start a local rebase', async () => {
  let attempts = 0;
  const autoRebaser = createPrAutoRebaser({
    attempt: async () => { attempts += 1; return { kind: 'rebased' }; },
    sessionFor: () => ({ status: 'working', managed: true, cwd: '/repo' }),
    rememberFailure: () => {},
    notify: () => {},
  });
  const common = { entry: { autoRebaseLinkedPr: true }, status: { rebase } };

  assert.equal(await autoRebaser.consider({
    ...common, link: { scope: 'session', ownerId: 'S1', url: 'https://github.com/acme/project/pull/1' },
  }), null);
  assert.equal(await autoRebaser.consider({
    ...common, link: { scope: 'task', ownerId: 'T1', url: 'https://github.com/acme/project/pull/1' },
  }), null);
  assert.equal(attempts, 0);
});

test('a dormant session never starts a local rebase', async () => {
  let attempts = 0;
  const autoRebaser = createPrAutoRebaser({
    attempt: async () => { attempts += 1; return { kind: 'rebased' }; },
    sessionFor: () => ({ status: 'idle', managed: false, cwd: '/repo' }),
    rememberFailure: () => {},
    notify: () => {},
  });

  const result = await autoRebaser.consider({
    link: { scope: 'session', ownerId: 'S1', url: 'https://github.com/acme/project/pull/1' },
    entry: { autoRebaseLinkedPr: true },
    status: { rebase },
  });

  assert.equal(result, null);
  assert.equal(attempts, 0);
});

test('an idle session with a background shell never starts a local rebase', async () => {
  let attempts = 0;
  const autoRebaser = createPrAutoRebaser({
    attempt: async () => { attempts += 1; return { kind: 'rebased' }; },
    sessionFor: () => ({ status: 'idle', managed: true, hasBackgroundShell: true, cwd: '/repo' }),
    rememberFailure: () => {},
    notify: () => {},
  });
  const result = await autoRebaser.consider({
    link: { scope: 'session', ownerId: 'S1', url: 'https://github.com/acme/project/pull/1' },
    entry: { autoRebaseLinkedPr: true },
    status: { rebase },
  });
  assert.equal(result, null);
  assert.equal(attempts, 0);
});

test('a persisted failure fingerprint suppresses another wake but still allows a retry', async () => {
  let attempts = 0;
  let notifications = 0;
  const autoRebaser = createPrAutoRebaser({
    attempt: async () => { attempts += 1; return { kind: 'failed', reason: 'dirty-worktree' }; },
    sessionFor: () => ({ status: 'idle', managed: true, cwd: '/repo' }),
    rememberFailure: () => {},
    notify: () => { notifications += 1; },
  });

  const result = await autoRebaser.consider({
    link: {
      scope: 'session', ownerId: 'S1', url: 'https://github.com/acme/project/pull/1',
      rebaseFailureKey: `dirty-worktree:${HEAD}`,
    },
    entry: { autoRebaseLinkedPr: true },
    status: { rebase },
  });

  assert.equal(result.kind, 'failed');
  assert.equal(attempts, 1);
  assert.equal(notifications, 0);
});

test('the live eligibility callback observes opt-out while an attempt is in flight', async () => {
  let eligible = true;
  const autoRebaser = createPrAutoRebaser({
    attempt: async ({ isIdle }) => {
      eligible = false;
      return { kind: 'deferred', reason: await isIdle() ? 'still-eligible' : 'eligibility-changed' };
    },
    isEligible: () => eligible,
    sessionFor: () => ({ status: 'idle', managed: true, cwd: '/repo' }),
    rememberFailure: () => {},
    notify: () => {},
  });

  const result = await autoRebaser.consider({
    link: { scope: 'session', ownerId: 'S1', url: 'https://github.com/acme/project/pull/1' },
    entry: { autoRebaseLinkedPr: true },
    status: { rebase },
  });

  assert.deepEqual(result, { kind: 'deferred', reason: 'eligibility-changed' });
});

test('an unexpected attempt error becomes a fingerprinted failure instead of aborting the poll', async () => {
  const calls = { remembered: [], notifications: [] };
  const autoRebaser = createPrAutoRebaser({
    attempt: async () => { throw new Error('git disappeared'); },
    sessionFor: () => ({ status: 'idle', managed: true, cwd: '/repo' }),
    rememberFailure: (...args) => calls.remembered.push(args),
    notify: (...args) => calls.notifications.push(args),
  });
  const candidate = {
    link: { scope: 'session', ownerId: 'S1', url: 'https://github.com/acme/project/pull/1' },
    entry: { autoRebaseLinkedPr: true },
    status: { rebase },
  };

  const result = await autoRebaser.consider(candidate);

  assert.deepEqual(result, { kind: 'failed', reason: 'unexpected-error', detail: 'git disappeared', notified: true });
  assert.deepEqual(calls.remembered, [['S1', candidate.link.url, `unexpected-error:${HEAD}`]]);
  assert.equal(calls.notifications.length, 1);
});

test('scheduling a rebase does not wait for the git operation to finish', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let settle;
  const settled = new Promise((resolve) => { settle = resolve; });
  const results = [];
  const autoRebaser = createPrAutoRebaser({
    attempt: async () => { await gate; return { kind: 'rebased' }; },
    sessionFor: () => ({ status: 'idle', managed: true, cwd: '/repo' }),
    rememberFailure: () => {},
    notify: () => {},
    onResult: (...args) => results.push(args),
  });
  const candidate = {
    link: { scope: 'session', ownerId: 'S1', url: 'https://github.com/acme/project/pull/1' },
    entry: { autoRebaseLinkedPr: true },
    status: { rebase },
  };

  assert.equal(await autoRebaser.schedule(candidate, settle), true);
  assert.deepEqual(results, []);
  release();
  assert.equal((await settled).kind, 'rebased');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(results[0][1].kind, 'rebased');
});

test('a busy session sharing the checkout blocks the rebase', async () => {
  let attempts = 0;
  const autoRebaser = createPrAutoRebaser({
    attempt: async () => { attempts += 1; return { kind: 'rebased' }; },
    checkoutIdleGuard: async () => () => false,
    sessionFor: () => ({ status: 'idle', managed: true, cwd: '/repo' }),
    rememberFailure: () => {},
    notify: () => {},
  });

  const result = await autoRebaser.consider({
    link: { scope: 'session', ownerId: 'S1', url: 'https://github.com/acme/project/pull/1' },
    entry: { autoRebaseLinkedPr: true },
    status: { rebase },
  });

  assert.equal(result, null);
  assert.equal(attempts, 0);
});

test('scheduling reports false when asynchronous checkout admission declines', async () => {
  let attempts = 0;
  let results = 0;
  const autoRebaser = createPrAutoRebaser({
    attempt: async () => { attempts += 1; return { kind: 'rebased' }; },
    checkoutIdleGuard: async () => () => false,
    sessionFor: () => ({ status: 'idle', managed: true, cwd: '/repo' }),
    rememberFailure: () => {},
    notify: () => {},
    onResult: () => { results += 1; },
  });

  const admitted = await autoRebaser.schedule({
    link: { scope: 'session', ownerId: 'S1', url: 'https://github.com/acme/project/pull/1' },
    entry: { autoRebaseLinkedPr: true },
    status: { rebase },
  });

  assert.equal(admitted, false);
  assert.equal(attempts, 0);
  assert.equal(results, 0);
});

test('the scheduling path reapplies pending status for a stale passing completed fingerprint', async () => {
  let stored;
  const autoRebaser = createPrAutoRebaser({
    attempt: async () => ({ kind: 'rebased' }),
    sessionFor: () => ({ status: 'idle', managed: true, cwd: '/repo' }),
    rememberFailure: () => {},
    notify: () => {},
    onResult: (candidate, result) => { stored = statusAfterAutoRebase(candidate.status, result); },
  });
  const candidate = {
    link: { scope: 'session', ownerId: 'S1', url: 'https://github.com/acme/project/pull/1' },
    entry: { autoRebaseLinkedPr: true },
    status: { checkStatus: 'pending', rebase },
  };
  assert.equal(await autoRebaser.schedule(candidate), true);
  await new Promise((resolve) => setImmediate(resolve));
  const stalePassing = { ...candidate, status: { checkStatus: 'passing', dirty: true, rebase } };
  await applyFetchedStatusBeforeAutoRebase(
    () => { stored = stalePassing.status; },
    () => autoRebaser.schedule(stalePassing),
  );
  assert.deepEqual(stored, { checkStatus: 'pending', dirty: false, rebase });
});
