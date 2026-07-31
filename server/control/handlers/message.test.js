import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { messageHandler } from './message.js';

function realDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aw-msghandler-'));
}

function ctx({ live = {}, entries = {} } = {}) {
  const calls = { sent: [], resumed: [], reply: [], rebuild: 0 };
  return {
    calls,
    tmuxFor: (id) => live[id]?.tmux ?? null,
    socketFor: (id) => live[id]?.socket ?? '',
    sendText: async (name, text, socket) => { calls.sent.push({ name, text, socket }); },
    sessionManager: {
      entryFor: (id) => entries[id] || null,
      isResuming: () => false,
      resume: async (id, dir, opts) => { calls.resumed.push({ id, dir, opts }); return { tmux: 'cc_woken' }; },
    },
    memoryStore: { bindSession: () => {} },
    taskStore: { taskFor: () => null },
    rebuild: async () => { calls.rebuild += 1; },
    reply: (obj) => calls.reply.push(obj),
  };
}

test('message: live target gets the text pasted into its pane, no rebuild', async () => {
  const c = ctx({ live: { CARD1: { tmux: 'cc_one', socket: '/s/a' } } });
  await messageHandler.handler({ sessionId: 'CARD1', text: 'hi' }, c);
  assert.deepEqual(c.calls.sent, [{ name: 'cc_one', text: 'hi', socket: '/s/a' }]);
  assert.equal(c.calls.reply.length, 0);
  assert.equal(c.calls.rebuild, 0);
});

test('message: dormant target is woken and the message rides the resume intent; board rebuilds', async () => {
  const dir = realDir();
  const c = ctx({ entries: { CARD1: { cwd: dir, agent: 'claude' } } });
  await messageHandler.handler({ sessionId: 'CARD1', text: 'wake up' }, c);
  assert.equal(c.calls.resumed.length, 1);
  assert.deepEqual(c.calls.resumed[0].opts, { intent: 'wake up' });
  assert.equal(c.calls.rebuild, 1);
  assert.equal(c.calls.reply.length, 0);
});

test('message: archived target replies with an error, never resumed', async () => {
  const dir = realDir();
  const c = ctx({ entries: { CARD1: { cwd: dir, archivedAt: Date.now() } } });
  await messageHandler.handler({ sessionId: 'CARD1', text: 'hi' }, c);
  assert.equal(c.calls.resumed.length, 0);
  assert.equal(c.calls.reply.length, 1);
  assert.equal(c.calls.reply[0].type, 'error');
  assert.match(c.calls.reply[0].message, /archived/);
});

test('message: no text replies with an error and touches nothing', async () => {
  const c = ctx({ live: { CARD1: { tmux: 'cc_one', socket: '/s/a' } } });
  await messageHandler.handler({ sessionId: 'CARD1', text: '' }, c);
  assert.equal(c.calls.sent.length, 0);
  assert.equal(c.calls.reply.length, 1);
  assert.equal(c.calls.reply[0].type, 'error');
});
