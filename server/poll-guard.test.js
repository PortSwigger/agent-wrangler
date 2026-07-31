import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFullSweepGuard } from './poll-guard.js';

test('createFullSweepGuard: a full-sweep tick arriving mid-sweep is skipped — no overlap', async () => {
  let release;
  const gate = new Promise((r) => { release = r; }); // holds the first sweep open
  let runs = 0;
  const guarded = createFullSweepGuard(async () => { runs += 1; await gate; return { skipped: false }; });

  const first = guarded();        // starts; parks on the gate
  const second = await guarded(); // arrives mid-sweep → must be skipped
  assert.deepEqual(second, { skipped: true });
  assert.equal(runs, 1, 'the concurrent tick did not start a second sweep');

  release();
  await first;
  assert.equal(runs, 1);

  // Guard released after the sweep settles, so a later tick runs normally.
  const third = await guarded();
  assert.deepEqual(third, { skipped: false });
  assert.equal(runs, 2);
});

test('createFullSweepGuard: a TARGETED poll (only set) is never starved by an in-flight full sweep', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const seen = [];
  // Only the full sweep parks on the gate; a targeted poll returns immediately.
  const guarded = createFullSweepGuard(async (only) => { seen.push(only); if (!only) await gate; });

  const full = guarded();                            // full sweep parks on the gate
  await guarded({ scope: 'session', ownerId: 'X' }); // targeted → runs immediately, not skipped
  assert.deepEqual(seen, [null, { scope: 'session', ownerId: 'X' }]);

  release();
  await full;
});

test('createFullSweepGuard: guard is released even when the sweep throws', async () => {
  let n = 0;
  const guarded = createFullSweepGuard(async () => { n += 1; throw new Error('gh blew up'); });
  await assert.rejects(() => guarded(), /gh blew up/);
  // A subsequent tick must not be permanently wedged by the prior throw.
  await assert.rejects(() => guarded(), /gh blew up/);
  assert.equal(n, 2);
});
