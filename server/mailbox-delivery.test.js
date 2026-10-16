import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
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

// A Claude recipient with a published socket, recording socket sends.
function socketDeps({ agent, socket = { socketPath: '/s/x.sock', keyPath: '/s/x.key' }, sendFails = false } = {}) {
  const d = deps({ live: { CARD1: { tmux: 'cc_one', socket: '/s/a' } }, entries: { CARD1: { agent, liveSessionId: 'LIVE1' } } });
  d.socketSent = [];
  d.socketLookups = [];
  d.findSocket = (id) => { d.socketLookups.push(id); return socket; };
  d.sendSocket = async (target, text) => {
    if (sendFails) throw new Error('socket send failed: ECONNREFUSED');
    d.socketSent.push({ target, text });
  };
  return d;
}

test('live Claude recipient is delivered over its socket and never pasted', async () => {
  const d = socketDeps({ agent: 'claude' });
  const mode = await deliverMailNotification('CARD1', 'you have mail', d);
  assert.deepEqual(mode, { mode: 'live' });
  assert.deepEqual(d.socketSent, [{ target: { socketPath: '/s/x.sock', keyPath: '/s/x.key' }, text: 'you have mail' }]);
  assert.deepEqual(d.socketLookups, ['LIVE1']);
  assert.deepEqual(d.sent, []);
});

test('an entry with no agent recorded is treated as Claude', async () => {
  const d = socketDeps({});
  await deliverMailNotification('CARD1', 'you have mail', d);
  assert.equal(d.socketSent.length, 1);
  assert.deepEqual(d.sent, []);
});

test('live Codex recipient is pasted, never sent over a socket', async () => {
  const d = socketDeps({ agent: 'codex' });
  const mode = await deliverMailNotification('CARD1', 'you have mail', d);
  assert.deepEqual(mode, { mode: 'live' });
  assert.deepEqual(d.socketSent, []);
  assert.deepEqual(d.socketLookups, []);
  assert.equal(d.sent.length, 1);
});

test('Claude recipient with no published socket falls back to the paste', async () => {
  const d = socketDeps({ agent: 'claude', socket: null });
  const mode = await deliverMailNotification('CARD1', 'you have mail', d);
  assert.deepEqual(mode, { mode: 'live' });
  assert.deepEqual(d.socketSent, []);
  assert.deepEqual(d.sent, [{ name: 'cc_one', text: 'you have mail', socket: '/s/a' }]);
});

test('a failed socket send falls back to the paste', async () => {
  const d = socketDeps({ agent: 'claude', sendFails: true });
  const mode = await deliverMailNotification('CARD1', 'you have mail', d);
  assert.deepEqual(mode, { mode: 'live' });
  assert.deepEqual(d.sent, [{ name: 'cc_one', text: 'you have mail', socket: '/s/a' }]);
});

test('the paste fallback still defers behind a draft when the socket send fails', async () => {
  const d = socketDeps({ agent: 'claude', sendFails: true });
  d.paneDeferral = { deliverOrDefer: async ({ onDefer }) => { onDefer('composer not confirmed empty'); return 'deferred'; } };
  const mode = await deliverMailNotification('CARD1', 'you have mail', d);
  assert.deepEqual(mode, { mode: 'deferred', reason: 'composer not confirmed empty' });
});

test('the MCP-ready wait runs before a socket send', async () => {
  const d = socketDeps({ agent: 'claude' });
  d.sessionManager.entryFor = () => ({ agent: 'claude', liveSessionId: 'LIVE1', relaunchedAt: Date.now() });
  d.mcpConnectsAfterPolls = 2;
  let polls = 0;
  d.mcpSeenAt = () => { polls += 1; return polls > 2 ? Date.now() + 1000 : 0; };
  d.sendSocket = async () => { d.socketSent.push({ pollsBefore: polls }); };
  await deliverMailNotification('CARD1', 'you have mail', d);
  assert.ok(d.socketSent[0].pollsBefore > 2);
});

test('a snoozed or archived recipient never reaches the socket', async () => {
  const d = socketDeps({ agent: 'claude' });
  d.sessionManager.entryFor = () => ({ agent: 'claude', archivedAt: 1 });
  assert.deepEqual(await deliverMailNotification('CARD1', 'x', d), { mode: 'skip' });
  assert.deepEqual(d.socketSent, []);
});

test('dormant recipient keeps its mail unread without being resumed', async () => {
  const d = deps({ entries: { CARD1: { cwd: '/tmp/session' } } });
  const mode = await deliverMailNotification('CARD1', 'you have mail', d);
  assert.deepEqual(mode, { mode: 'deferred', reason: 'no tmux target' });
  assert.equal(d.resumed.length, 0);
  assert.deepEqual(d.sent, []);
});

test('dormant recipient is resumed bare, with the notification left for the gated live path', async () => {
  const d = deps({ entries: { CARD1: { cwd: os.tmpdir() } } });
  d.wakesDormant = () => true;
  const mode = await deliverMailNotification('CARD1', 'you have mail', d);
  assert.equal(mode.mode, 'deferred');
  assert.equal(d.resumed.length, 1);
  assert.deepEqual([d.resumed[0][0], d.resumed[0][2]], ['CARD1', { reason: 'mail', automatic: true }]);
  assert.deepEqual(d.sent, []);
});

test('a snoozed dormant recipient is never woken for mail', async () => {
  const d = deps({ entries: { CARD1: { cwd: os.tmpdir(), snooze: { until: Date.now() + 3600_000, createdAt: 1 } } } });
  d.wakesDormant = () => true;
  const mode = await deliverMailNotification('CARD1', 'x', d);
  assert.equal(mode.mode, 'deferred');
  assert.equal(d.resumed.length, 0);
});

test('a dormant recipient archived before the wake is skipped, not resumed', async () => {
  const d = deps({ entries: { CARD1: { cwd: os.tmpdir() } } });
  d.wakesDormant = () => true;
  const entry = d.sessionManager.entryFor('CARD1');
  const real = d.sessionManager.entryFor;
  let calls = 0;
  d.sessionManager.entryFor = (id) => (++calls > 1 ? { ...entry, archivedAt: 1 } : real(id));
  assert.deepEqual(await deliverMailNotification('CARD1', 'x', d), { mode: 'skip' });
  assert.equal(d.resumed.length, 0);
});

test('a recipient that went live during the directory lookup is not resumed again', async () => {
  const live = {};
  const d = deps({ live, entries: { CARD1: { cwd: os.tmpdir() } } });
  d.wakesDormant = () => true;
  const tmuxFor = d.tmuxFor;
  let calls = 0;
  d.tmuxFor = (id) => (++calls > 1 ? 'cc_other' : tmuxFor(id));
  const mode = await deliverMailNotification('CARD1', 'x', d);
  assert.equal(mode.mode, 'deferred');
  assert.equal(d.resumed.length, 0);
});

test('a resume that loses to an archive is skipped, not retried', async () => {
  const d = deps({ entries: { CARD1: { cwd: os.tmpdir() } } });
  d.wakesDormant = () => true;
  d.sessionManager.resume = async () => {
    d.sessionManager.entryFor('CARD1').archivedAt = 1;
    throw new Error('archived during resume');
  };
  assert.deepEqual(await deliverMailNotification('CARD1', 'x', d), { mode: 'skip' });
});

test('a snooze set during the wake window defers the mail without resuming', async () => {
  const d = deps({ entries: { CARD1: { cwd: os.tmpdir() } } });
  d.wakesDormant = () => true;
  const entry = d.sessionManager.entryFor('CARD1');
  let calls = 0;
  d.sessionManager.entryFor = () => (++calls > 1 ? { ...entry, snooze: { until: 1, createdAt: 1 } } : entry);
  const mode = await deliverMailNotification('CARD1', 'x', d);
  assert.equal(mode.mode, 'deferred');
  assert.equal(d.resumed.length, 0);
});

test('a resume discarded because a snooze appeared mid-launch defers instead of erroring', async () => {
  const d = deps({ entries: { CARD1: { cwd: os.tmpdir() } } });
  d.wakesDormant = () => true;
  d.sessionManager.resume = async () => {
    d.sessionManager.entryFor('CARD1').snooze = { until: 1, createdAt: 1 };
    throw new Error('discarded');
  };
  assert.equal((await deliverMailNotification('CARD1', 'x', d)).mode, 'deferred');
});

test('a failed resume propagates so the sweep reopens the settle window', async () => {
  const d = deps({ entries: { CARD1: { cwd: os.tmpdir() } } });
  d.wakesDormant = () => true;
  d.sessionManager.resume = async () => { throw new Error('boom'); };
  await assert.rejects(deliverMailNotification('CARD1', 'x', d), /boom/);
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
