import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readLaunchStatus, awaitLaunchStatus } from './launch-status.js';

const finder = (launchStatus) => () => ({ id: 'toyrt', launchStatus });

test('readLaunchStatus is null for a missing entry or a runtime without launchStatus', async () => {
  assert.equal(await readLaunchStatus(null, { find: finder(() => ({ state: 'ok' })) }), null);
  assert.equal(await readLaunchStatus({ runtime: 'toyrt' }, { find: () => ({ id: 'toyrt' }) }), null);
  assert.equal(await readLaunchStatus({ runtime: 'gone' }, { find: () => null }), null);
});

test('readLaunchStatus keeps only the contract fields', async () => {
  const find = finder(() => ({ state: 'ok', url: 'https://claude.ai/code/x', extra: 1 }));
  assert.deepEqual(await readLaunchStatus({ runtime: 'toyrt' }, { find }), { state: 'ok', url: 'https://claude.ai/code/x' });
});

test('readLaunchStatus gives a failed launch an error, defaulting a blank one', async () => {
  assert.deepEqual(
    await readLaunchStatus({}, { find: finder(() => ({ state: 'failed', error: '  no remote  ' })) }),
    { state: 'failed', error: 'no remote' },
  );
  assert.deepEqual(
    await readLaunchStatus({}, { find: finder(() => ({ state: 'failed' })) }),
    { state: 'failed', error: 'The launch failed.' },
  );
});

test('readLaunchStatus treats an off-shape answer or a throw as no answer', async () => {
  assert.equal(await readLaunchStatus({}, { find: finder(() => ({ state: 'done' })) }), null);
  assert.equal(await readLaunchStatus({}, { find: finder(() => 'ok') }), null);
  assert.equal(await readLaunchStatus({}, { find: finder(() => { throw new Error('boom'); }) }), null);
  assert.equal(await readLaunchStatus({}, { find: finder(async () => { throw new Error('boom'); }) }), null);
});

test('awaitLaunchStatus polls until the launch settles', async () => {
  let calls = 0;
  const find = finder(() => (++calls < 3 ? { state: 'pending' } : { state: 'failed', error: 'nope' }));
  const sleeps = [];
  const out = await awaitLaunchStatus({}, { find, sleep: async (ms) => { sleeps.push(ms); }, now: () => 0 });
  assert.deepEqual(out, { state: 'failed', error: 'nope' });
  assert.equal(calls, 3);
  assert.deepEqual(sleeps, [250, 250]);
});

test('awaitLaunchStatus returns pending once the budget runs out', async () => {
  let t = 0;
  const out = await awaitLaunchStatus({}, {
    find: finder(() => ({ state: 'pending' })),
    budgetMs: 1000,
    now: () => t,
    sleep: async (ms) => { t += ms; },
  });
  assert.deepEqual(out, { state: 'pending' });
  assert.equal(t, 1000);
});

test('awaitLaunchStatus does not wait when the runtime has no launchStatus', async () => {
  let slept = false;
  const out = await awaitLaunchStatus({}, { find: () => ({ id: 'local' }), sleep: async () => { slept = true; } });
  assert.equal(out, null);
  assert.equal(slept, false);
});
