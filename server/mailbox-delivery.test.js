import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deliverMailNotification } from './mailbox-delivery.js';
import { createPaneDeferral } from './pane-deferral.js';

function deps({ live = {}, entries = {}, mcpConnectsAfterPolls = 0, mcpSeenStale = false } = {}) {
  const sent = [];
  const resumed = [];
  const mcpPolls = [];
  return {
    sent, resumed, mcpPolls,
    sessionManager: {
      entryFor: (id) => entries[id] || null,
      resume: async (...args) => { resumed.push(args); return { tmux: 'cc_woken' }; },
    },
    tmuxFor: (id) => live[id]?.tmux ?? null,
    socketFor: (id) => live[id]?.socket ?? '',
    paneDeferral: {
      deliverOrDefer: async ({ text, tmux, socket, beforeSend }) => {
        await beforeSend?.();
        sent.push({ name: tmux, text, socket });
        return 'sent';
      },
    },
    mcpSeenAt: () => {
      mcpPolls.push(sent.length);
      if (mcpSeenStale) return 1;
      return mcpPolls.length > mcpConnectsAfterPolls ? Date.now() : 0;
    },
    mcpReadyTimeoutMs: 10000,
    mcpReadyPollMs: 1,
  };
}

test('live recipient: delivers into the pane without resuming it', async () => {
  const d = deps({ live: { CARD1: { tmux: 'cc_one', socket: '/s/a' } }, entries: { CARD1: {} } });
  const mode = await deliverMailNotification('CARD1', 'you have mail', d);
  assert.deepEqual(mode, { mode: 'live' });
  assert.deepEqual(d.sent, [{ name: 'cc_one', text: 'you have mail', socket: '/s/a' }]);
  assert.equal(d.resumed.length, 0);
});

test('dormant recipient keeps its mail unread without being resumed', async () => {
  const d = deps({ entries: { CARD1: { cwd: '/tmp/session' } } });
  const mode = await deliverMailNotification('CARD1', 'you have mail', d);
  assert.deepEqual(mode, { mode: 'deferred', reason: 'no tmux target' });
  assert.equal(d.resumed.length, 0);
  assert.deepEqual(d.sent, []);
});

test('dormant recipient is woken with the notification when wakesDormant is on', async () => {
  const d = deps({ entries: { CARD1: { cwd: '/tmp/session' } } });
  const calls = [];
  d.wakesDormant = () => true;
  d.deliverMessage = async (...args) => { calls.push(args); return { mode: 'dormant' }; };
  const mode = await deliverMailNotification('CARD1', 'you have mail', d);
  assert.deepEqual(mode, { mode: 'live' });
  assert.deepEqual(calls.map((c) => [c[0], c[1], c[3]]), [['CARD1', 'you have mail', { reason: 'mail' }]]);
});

test('a failed wake is reported as an error so the mail is retried', async () => {
  const d = deps({ entries: { CARD1: {} } });
  d.wakesDormant = () => true;
  d.deliverMessage = async () => ({ mode: 'error', error: 'boom' });
  assert.deepEqual(await deliverMailNotification('CARD1', 'x', d), { mode: 'error', error: 'boom' });
});

test('live recipient archived during its settle window is skipped', async () => {
  const d = deps({
    live: { CARD1: { tmux: 'cc_one', socket: '/s/a' } },
    entries: { CARD1: { archivedAt: Date.now() } },
  });
  const mode = await deliverMailNotification('CARD1', 'you have mail', d);
  assert.deepEqual(mode, { mode: 'skip' });
  assert.equal(d.sent.length, 0);
});

test('recently resumed live recipient waits for its new MCP connection', async () => {
  const relaunchedAt = Date.now();
  const d = deps({
    live: { CARD1: { tmux: 'cc_one', socket: '/s/a' } },
    entries: { CARD1: { relaunchedAt } },
    mcpConnectsAfterPolls: 3,
  });
  const mode = await deliverMailNotification('CARD1', 'you have mail', d);
  assert.deepEqual(mode, { mode: 'live' });
  assert.deepEqual(d.mcpPolls.slice(0, 4), [0, 0, 0, 0]);
  assert.equal(d.sent.length, 1);
});

test('old relaunch timestamp does not wait on process-local MCP state after restart', async () => {
  const d = deps({
    live: { CARD1: { tmux: 'cc_one', socket: '/s/a' } },
    entries: { CARD1: { relaunchedAt: Date.now() - 60_000 } },
    mcpSeenStale: true,
  });
  const mode = await deliverMailNotification('CARD1', 'you have mail', d);
  assert.deepEqual(mode, { mode: 'live' });
  assert.equal(d.mcpPolls.length, 0);
});

test('gone recipient is skipped', async () => {
  const mode = await deliverMailNotification('CARD1', 'you have mail', deps());
  assert.deepEqual(mode, { mode: 'skip' });
});

test('live recipient mid-prompt leaves mail unread for a durable retry', async () => {
  const pasted = [];
  const d = deps({ live: { CARD1: { tmux: 'cc_one', socket: '' } }, entries: { CARD1: {} } });
  d.paneDeferral = createPaneDeferral({
    tmuxFor: d.tmuxFor,
    socketFor: d.socketFor,
    capture: async () => `${'\x1b'}[39m❯ half a question`,
    sendText: async (name, text, socket) => { pasted.push({ name, text, socket }); },
  });
  const res = await deliverMailNotification('CARD1', '[Agent Wrangler] 📬 New mail', d);
  assert.equal(res.mode, 'deferred');
  assert.deepEqual(pasted, []);
  assert.deepEqual(d.paneDeferral.pending('CARD1'), []);
});

test('a live recipient whose pane is not ready reports why delivery was deferred', async () => {
  const d = deps({ live: { CARD1: { tmux: 'cc_one', socket: '' } }, entries: { CARD1: {} } });
  d.paneDeferral = createPaneDeferral({
    tmuxFor: d.tmuxFor, socketFor: d.socketFor,
    statusFor: () => 'working',
    capture: async () => '',
    sendText: async () => { throw new Error('must not paste'); },
  });
  const mode = await deliverMailNotification('CARD1', 'you have mail', d);
  assert.deepEqual(mode, { mode: 'deferred', reason: 'board status working' });
});
