import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDispatchWaiter } from './dispatch-waiter.js';

const settled = (p) => Promise.race([p.then((v) => ['resolved', v], (e) => ['rejected', e.message]), Promise.resolve(['pending'])]);

test('resolves with the ack once the human has launched', async () => {
  const w = createDispatchWaiter();
  let shown = 0;
  const p = w.open(() => { shown += 1; });
  assert.equal(shown, 1);
  assert.deepEqual(w.state(), { submitted: false });
  w.submit();
  w.ack({ type: 'dispatched', sessionId: 'S1' });
  assert.deepEqual(await p, { type: 'dispatched', sessionId: 'S1' });
  assert.equal(w.state(), null);
});

test('an ack that nobody launched is not handed to an open (un-launched) modal', async () => {
  const w = createDispatchWaiter();
  const p = w.open(() => {});
  w.ack({ type: 'dispatched', sessionId: 'OTHER' });
  assert.deepEqual(await settled(p), ['pending']);
  w.close({ wasPending: false });
  assert.equal(await p, null);
});

test('cancel resolves null', async () => {
  const w = createDispatchWaiter();
  const p = w.open(() => {});
  w.close({ wasPending: false });
  assert.equal(await p, null);
});

test('a second open while the first modal is merely open replaces it (first resolves null)', async () => {
  const w = createDispatchWaiter();
  const first = w.open(() => {});
  const second = w.open(() => {});
  assert.equal(await first, null);
  w.submit();
  w.ack({ sessionId: 'S2' });
  assert.deepEqual(await second, { sessionId: 'S2' });
});

test('a second open while a launch awaits its ack rejects and leaves the first intact', async () => {
  const w = createDispatchWaiter();
  const first = w.open(() => {});
  w.submit();
  await assert.rejects(w.open(() => assert.fail('must not open')), /already in flight/);
  w.ack({ sessionId: 'S1' });
  assert.deepEqual(await first, { sessionId: 'S1' });
});

test('closing the modal after a launch keeps waiting for the ack, unless it was held open pending it', async () => {
  const w = createDispatchWaiter();
  const sent = w.open(() => {});
  w.submit();
  w.close({ wasPending: false });
  assert.deepEqual(await settled(sent), ['pending']);
  w.ack({ sessionId: 'S1' });
  assert.deepEqual(await sent, { sessionId: 'S1' });

  const held = w.open(() => {});
  w.submit();
  w.close({ wasPending: true });
  assert.equal(await held, null);
});

test('an error: modal still open returns to retryable; modal closed resolves null', async () => {
  const w = createDispatchWaiter();
  const p = w.open(() => {});
  w.submit();
  w.error({ modalOpen: true });
  assert.deepEqual(w.state(), { submitted: false });
  w.submit();
  w.ack({ sessionId: 'S1' });
  assert.deepEqual(await p, { sessionId: 'S1' });

  const q = w.open(() => {});
  w.submit();
  w.error({ modalOpen: false });
  assert.equal(await q, null);
  w.error({ modalOpen: false }); // no call pending: harmless
});

test('lockTask and the other options are the caller\'s show() business: show runs exactly once per open', async () => {
  const w = createDispatchWaiter();
  const seen = [];
  const p = w.open(() => seen.push({ taskId: 't1', lockTask: true }));
  w.close({ wasPending: false });
  await p;
  assert.deepEqual(seen, [{ taskId: 't1', lockTask: true }]);
});
