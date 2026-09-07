import test from 'node:test';
import assert from 'node:assert/strict';
import { deliverMessage } from './message-delivery.js';

// The ORDER and the SPLIT are the whole mechanism here, so they get their own
// file rather than being folded into message-delivery.test.js's routing cases.
// Measured against a live Claude pane: a bare image path pasted on its own is
// rewritten to `[Image #1]` and attached, but the same path inside a multi-line
// paste — or with any text after it — stays literal text the model never sees.
// So each path must arrive as its own paste, with no Enter, before the prose.
function deps({ live = true } = {}) {
  const calls = [];
  return {
    calls,
    tmuxFor: () => (live ? 'cc_x' : null),
    socketFor: () => 'sockA',
    prefillPane: async (name, text, socket) => { calls.push({ verb: 'prefill', name, text, socket }); },
    sendText: async (name, text, socket) => { calls.push({ verb: 'sendText', name, text, socket }); },
    sessionManager: {
      entryFor: () => ({ agent: 'claude', cwd: '/tmp', liveSessionId: 'live-1', socket: 'sockA' }),
      isResuming: () => false,
      resume: async () => { calls.push({ verb: 'resume' }); return { tmux: 'cc_woken' }; },
    },
    memoryStore: { bindSession: () => {} },
    taskStore: { taskFor: () => null },
  };
}

test('live: every image path is pasted alone and BEFORE the prose, and only the prose submits', async () => {
  const d = deps();
  const r = await deliverMessage('CARD1', 'What colour is this?\n\nOne line only.', d, {
    imagePaths: ['/m/pastes/paste-1-aa.png', '/m/pastes/paste-2-bb.png'],
  });
  assert.equal(r.mode, 'live');
  assert.deepEqual(d.calls.map((c) => c.verb), ['prefill', 'prefill', 'sendText']);
  // Each path is its OWN paste, carrying nothing but the path.
  assert.deepEqual(d.calls.slice(0, 2).map((c) => c.text), ['/m/pastes/paste-1-aa.png', '/m/pastes/paste-2-bb.png']);
  // The prose keeps its newlines and is never concatenated with a path.
  assert.equal(d.calls[2].text, 'What colour is this?\n\nOne line only.');
  assert.equal(d.calls.every((c) => c.socket === 'sockA'), true);
});

test('live: no images means byte-for-byte the old single-sendText path', async () => {
  const d = deps();
  await deliverMessage('CARD1', 'plain', d);
  assert.deepEqual(d.calls, [{ verb: 'sendText', name: 'cc_x', text: 'plain', socket: 'sockA' }]);
});

test('live: an image with no prose still submits — the bare marker is a complete prompt', async () => {
  const d = deps();
  await deliverMessage('CARD1', '', d, { imagePaths: ['/m/pastes/paste-1-aa.png'] });
  assert.deepEqual(d.calls.map((c) => c.verb), ['prefill', 'sendText']);
  assert.equal(d.calls[1].text, '');
});

test('dormant: attachments force the paste route instead of the resume intent, which would drop them', async () => {
  // Claude's resumeCarriesIntent hands the text to the CLI as a launch argument.
  // There is no composer there for a path to be absorbed into, so taking that
  // shortcut would silently lose every image.
  const d = deps({ live: false });
  const r = await deliverMessage('CARD1', 'look at this', d, { imagePaths: ['/m/pastes/paste-1-aa.png'] });
  assert.equal(r.mode, 'dormant');
  assert.deepEqual(d.calls.map((c) => c.verb), ['resume', 'prefill', 'sendText']);
  assert.equal(d.calls[1].text, '/m/pastes/paste-1-aa.png');
  assert.equal(d.calls[2].text, 'look at this');
});

test('dormant with no images: the resume intent shortcut is still taken (unchanged)', async () => {
  const d = deps({ live: false });
  await deliverMessage('CARD1', 'wake up', d);
  assert.deepEqual(d.calls.map((c) => c.verb), ['resume']);
});
