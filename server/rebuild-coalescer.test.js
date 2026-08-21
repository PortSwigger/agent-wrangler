import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRebuildCoalescer } from './rebuild-coalescer.js';

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

test('createRebuildCoalescer: a call arriving mid-rebuild does not start a second run', async () => {
  const gate = deferred();
  let runs = 0;
  const coalesced = createRebuildCoalescer(async () => { runs += 1; await gate.promise; return runs; });

  const first = coalesced();   // starts run #1, parks on the gate
  const second = coalesced();  // arrives mid-run — must NOT start its own run
  assert.equal(runs, 1, 'only one run started so far');

  gate.resolve();
  await first;
  // The trailing run (queued by `second`) starts only once the first settles.
  await second;
  assert.equal(runs, 2, 'exactly one trailing run followed, not one per overlapping caller');
});

test('createRebuildCoalescer: several overlapping callers collapse into ONE trailing run', async () => {
  const gate = deferred();
  let runs = 0;
  const coalesced = createRebuildCoalescer(async () => { runs += 1; await gate.promise; return runs; });

  const first = coalesced();
  const second = coalesced();
  const third = coalesced();
  const fourth = coalesced();
  assert.equal(runs, 1);

  gate.resolve();
  const results = await Promise.all([first, second, third, fourth]);
  assert.equal(runs, 2, 'four overlapping callers produced exactly one trailing run, not three');
  assert.deepEqual(results, [1, 2, 2, 2], 'the first caller sees run #1; every coalesced caller sees the SAME trailing run #2');
});

test('createRebuildCoalescer: a caller awaiting the trailing run sees its own prior write reflected', async () => {
  // The property that rules out a silent-skip guard (like pollPrStatuses'): a
  // handler that mutates state then awaits rebuild() must see a run that started
  // AFTER its mutation, not be starved by a same-tick overlap. Recording what each
  // *run* observed (not just the final value, which would be true either way once
  // `mutated` is set) is what actually pins this — a skip-guard that never starts a
  // second run would leave `observed` at `[false]` forever.
  const gate = deferred();
  const observed = [];
  let mutated = false;
  const coalesced = createRebuildCoalescer(async () => {
    observed.push(mutated);
    await gate.promise;
  });

  const first = coalesced(); // in flight; run #1 already observed mutated === false
  mutated = true;
  const second = coalesced(); // arrives after the mutation, mid-run-#1 — queues a trailing run

  gate.resolve();
  await first;
  await second; // the trailing run starts fresh AFTER run #1 settles, observing the mutation
  assert.deepEqual(observed, [false, true], 'run #1 sees the pre-mutation state; the trailing run must start only after run #1 settles and observe the mutation');
});

test('createRebuildCoalescer: sequential (non-overlapping) calls each run independently', async () => {
  let runs = 0;
  const coalesced = createRebuildCoalescer(async () => { runs += 1; return runs; });
  assert.equal(await coalesced(), 1);
  assert.equal(await coalesced(), 2);
  assert.equal(await coalesced(), 3);
});

test('createRebuildCoalescer: a rejected run does not wedge later calls, and the trailing run still fires', async () => {
  let runs = 0;
  const coalesced = createRebuildCoalescer(async () => {
    runs += 1;
    if (runs === 1) throw new Error('boom');
    return runs;
  });
  const first = coalesced();
  const second = coalesced(); // queued as the trailing run while the first (failing) run is in flight
  await assert.rejects(() => first, /boom/);
  assert.equal(await second, 2, 'the trailing run started fresh despite run #1 throwing');

  // Guard is not permanently wedged by the earlier throw.
  assert.equal(await coalesced(), 3);
});
