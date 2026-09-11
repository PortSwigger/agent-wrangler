import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPaneDeferral, MAX_PENDING_PER_CARD } from './pane-deferral.js';

const E = '\x1b';
// The composer as capturePaneStyled renders it: an SGR-prefixed `❯` line whose
// tail is whatever the human has typed. Empty tail ⇒ paneComposerIsEmpty true.
const composer = (body = '') => `${E}[39m❯ ${body}`;

function deps({ live = { c1: { tmux: 'cc_one', socket: '' } }, pane = composer(), captureThrows = false, sendThrows = false } = {}) {
  const sent = [];
  const captures = [];
  // A function lets a test change what the pane shows between calls.
  const paneOf = typeof pane === 'function' ? pane : () => pane;
  return {
    sent,
    captures,
    tmuxFor: (id) => live[id]?.tmux ?? null,
    socketFor: (id) => live[id]?.socket ?? '',
    capture: async (name, lines, socket) => {
      captures.push({ name, lines, socket });
      if (captureThrows) throw new Error('pane gone');
      return paneOf();
    },
    sendText: async (name, text, socket) => {
      if (sendThrows) throw new Error('tmux gone');
      sent.push({ name, text, socket });
    },
  };
}

test('a confirmed-empty composer takes the paste immediately and queues nothing', async () => {
  const d = deps();
  const pd = createPaneDeferral(d);

  assert.equal(await pd.deliverOrDefer({ id: 'c1', text: 'PR #1 merged' }), 'sent');

  assert.deepEqual(d.sent, [{ name: 'cc_one', text: 'PR #1 merged', socket: '' }]);
  assert.deepEqual(pd.pending('c1'), []);
});

test('a composer holding a human draft defers the paste instead of fusing with it', async () => {
  const d = deps({ pane: composer('why is the build fai') });
  const pd = createPaneDeferral(d);

  assert.equal(await pd.deliverOrDefer({ id: 'c1', text: 'PR #1 merged' }), 'deferred');

  assert.deepEqual(d.sent, [], 'nothing may land on top of a half-typed prompt');
  assert.deepEqual(pd.pending('c1'), ['PR #1 merged']);
});

test('a pane that cannot be read defers — emptiness is confirmed, never assumed', async () => {
  const d = deps({ captureThrows: true });
  const pd = createPaneDeferral(d);

  assert.equal(await pd.deliverOrDefer({ id: 'c1', text: 'PR #1 merged' }), 'deferred');
  assert.deepEqual(d.sent, []);
  assert.deepEqual(pd.pending('c1'), ['PR #1 merged']);
});

test('a dormant card (no live pane) defers without touching tmux', async () => {
  const d = deps({ live: {} });
  const pd = createPaneDeferral(d);

  assert.equal(await pd.deliverOrDefer({ id: 'c1', text: 'PR #1 merged' }), 'deferred');
  assert.deepEqual(d.captures, [], 'no pane to capture');
  assert.deepEqual(pd.pending('c1'), ['PR #1 merged']);
});

test('an explicit tmux/socket overrides the lookup (the post-resume pane)', async () => {
  const d = deps({ live: {} });
  const pd = createPaneDeferral(d);

  assert.equal(await pd.deliverOrDefer({ id: 'c1', text: 'checks passing', tmux: 'cc_fresh', socket: 'sock' }), 'sent');
  assert.deepEqual(d.sent, [{ name: 'cc_fresh', text: 'checks passing', socket: 'sock' }]);
});

test('drain leaves the queue alone while the draft is still there', async () => {
  const d = deps({ pane: composer('still typing') });
  const pd = createPaneDeferral(d);
  await pd.deliverOrDefer({ id: 'c1', text: 'PR #1 merged' });

  assert.deepEqual(await pd.drain(), []);
  assert.deepEqual(d.sent, []);
  assert.deepEqual(pd.pending('c1'), ['PR #1 merged']);
});

test('drain delivers everything queued as ONE paste, in order, once the composer clears', async () => {
  let body = 'still typing';
  const d = deps({ pane: () => composer(body) });
  const pd = createPaneDeferral(d);
  await pd.deliverOrDefer({ id: 'c1', text: 'PR #1 merged' });
  await pd.deliverOrDefer({ id: 'c1', text: 'PR #2 checks passing' });

  body = '';
  assert.deepEqual(await pd.drain(), ['c1']);

  assert.deepEqual(d.sent, [
    { name: 'cc_one', text: 'PR #1 merged\nPR #2 checks passing', socket: '' },
  ], 'one bracketed paste, so the agent gets one turn rather than two interleaved ones');
  assert.deepEqual(pd.pending('c1'), []);
});

test('drain with an empty queue costs nothing — no pane is captured', async () => {
  const d = deps();
  const pd = createPaneDeferral(d);

  assert.deepEqual(await pd.drain(), []);
  assert.deepEqual(d.captures, []);
});

test('overlapping drains deliver once', async () => {
  let body = 'typing';
  const d = deps({ pane: () => composer(body) });
  const pd = createPaneDeferral(d);
  await pd.deliverOrDefer({ id: 'c1', text: 'PR #1 merged' });

  // Both drains now see an empty composer; the in-flight guard must stop the
  // second from re-sending the lines the first is already committing.
  body = '';
  const [a, b] = await Promise.all([pd.drain(), pd.drain()]);

  assert.equal([...a, ...b].length, 1, 'exactly one drain claimed the card');
  assert.equal(d.sent.length, 1);
});

test('a failed paste keeps the lines queued for the next drain', async () => {
  const d = deps({ sendThrows: true });
  const pd = createPaneDeferral(d);

  assert.equal(await pd.deliverOrDefer({ id: 'c1', text: 'PR #1 merged' }), 'deferred');
  assert.deepEqual(pd.pending('c1'), ['PR #1 merged'], 'a lost paste must not be a lost notification');
});

test('an identical consecutive line is not queued twice', async () => {
  const d = deps({ pane: composer('typing') });
  const pd = createPaneDeferral(d);
  await pd.deliverOrDefer({ id: 'c1', text: 'PR #1 checks failing' });
  await pd.deliverOrDefer({ id: 'c1', text: 'PR #1 checks failing' });

  assert.deepEqual(pd.pending('c1'), ['PR #1 checks failing']);
});

test('the queue is capped, dropping the OLDEST — a days-old draft cannot grow it without bound', async () => {
  const d = deps({ pane: composer('typing') });
  const pd = createPaneDeferral(d);
  for (let i = 0; i <= MAX_PENDING_PER_CARD; i += 1) {
    await pd.deliverOrDefer({ id: 'c1', text: `line ${i}` });
  }

  const q = pd.pending('c1');
  assert.equal(q.length, MAX_PENDING_PER_CARD);
  assert.equal(q[0], 'line 1', 'oldest dropped');
  assert.equal(q.at(-1), `line ${MAX_PENDING_PER_CARD}`, 'newest kept');
});

test('queues are per card', async () => {
  const d = deps({ live: { c1: { tmux: 'cc_one', socket: '' }, c2: { tmux: 'cc_two', socket: 's2' } }, pane: composer('typing') });
  const pd = createPaneDeferral(d);
  await pd.deliverOrDefer({ id: 'c1', text: 'for one' });
  await pd.deliverOrDefer({ id: 'c2', text: 'for two' });

  assert.deepEqual(pd.pending('c1'), ['for one']);
  assert.deepEqual(pd.pending('c2'), ['for two']);
});
