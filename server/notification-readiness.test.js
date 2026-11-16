import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNotificationReadiness } from './notification-readiness.js';
import { createPaneDeferral } from './pane-deferral.js';

test('fresh launch and resume never paste into the previous empty startup frame', async () => {
  for (const stamp of ['createdAt', 'relaunchedAt']) {
    let seen = 0;
    let resuming = true;
    const entry = { agent: 'codex', [stamp]: 101 };
    const ready = createNotificationReadiness({ startedAt: 100, entryFor: () => entry,
      isResuming: () => resuming, mcpSeenAt: () => seen, now: () => 101 });
    const sent = [];
    const pd = createPaneDeferral({ tmuxFor: () => 'pane', agentFor: () => 'codex',
      readyFor: ready, capture: async () => '\x1b[1m›\x1b[0m \x1b[2mAsk Codex to do anything\x1b[0m',
      sendText: async (...args) => sent.push(args) });
    await pd.deliverOrDefer({ id: 'child', text: 'mail' });
    assert.deepEqual(sent, []);
    resuming = false;
    await pd.drain();
    assert.deepEqual(sent, []);
    seen = 102;
    assert.deepEqual(await pd.drain(), ['child']);
    assert.equal(sent.length, 1);
  }
});

test('server restart does not require old sessions to reconnect and non-mail runtimes can deliver', () => {
  let entry = { createdAt: 90 };
  const ready = createNotificationReadiness({ startedAt: 100, entryFor: () => entry,
    mcpSeenAt: () => 0 });
  assert.equal(ready('child'), true);
  entry = { createdAt: 101, mailCapable: false };
  assert.equal(ready('child'), true);
});

test('notifications resume after the startup timeout even when MCP never connects', async () => {
  let now = 101;
  const ready = createNotificationReadiness({ startedAt: 100, entryFor: () => ({ createdAt: 101 }),
    mcpSeenAt: () => 0, now: () => now });
  const sent = [];
  const pd = createPaneDeferral({ tmuxFor: () => 'pane', agentFor: () => 'codex',
    readyFor: ready, capture: async () => '\x1b[1m›\x1b[0m \x1b[2mAsk Codex to do anything\x1b[0m',
    sendText: async (...args) => sent.push(args) });
  await pd.deliverOrDefer({ id: 'child', text: 'mail' });
  now = 15_100;
  await pd.drain();
  assert.equal(sent.length, 0);
  now = 15_101;
  assert.deepEqual(await pd.drain(), ['child']);
  assert.equal(sent.length, 1);
});
