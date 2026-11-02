import test from 'node:test';
import assert from 'node:assert/strict';
import { interruptHandler } from './control/handlers/interrupt.js';
import { clearComposer } from './tmux-scraper.js';
import { composerHoldsText } from './pane-ready.js';
const idle = '────────────────────────────\n> \n────────────────────────────\n? for shortcuts      auto   Gemini 3.8 Flash · medium';
test('agy Stop sends Escape and restores the actual pane draft without generating Ctrl-C', async () => {
  const keys = [], replies = [];
  await interruptHandler.handler({ sessionId: 'card' }, {
    tmuxFor: () => 'ag_fixture', socketFor: () => '', sessionFromGraph: () => ({ agent: 'agy' }),
    sendKeys: async (_target, value) => keys.push(value), capturePaneStyled: async () => idle.replace('> ', '> restored human prompt'),
    reply: (reply) => replies.push(reply), restoreSettleMs: 0,
  });
  assert.deepEqual(keys, [['Escape']]);
  assert.equal(replies[0].text, 'restored human prompt');
  assert.equal(replies[0].source, 'pane');
});
test('agy clears drafts with bounded Ctrl-U and repairs Enter only for its exact framed input', async () => {
  let pane = idle.replace('> ', '> draft');
  const calls = [];
  await clearComposer('ag_fixture', '', { agent: 'agy', capture: async () => pane, run: async (_socket, args) => { calls.push(args); pane = idle; return { stdout: '' }; } });
  assert.equal(calls.length, 1);
  assert.ok(calls[0].includes('C-u'));
  assert.ok(!calls.flat().includes('C-c'));
  assert.equal(composerHoldsText(idle.replace('> ', '> own text'), 'agy', 'own text'), true);
  assert.equal(composerHoldsText('tool output > own text\nAn unknown menu', 'agy', 'own text'), false);
  assert.equal(composerHoldsText(idle.replace('> ', '> own text plus a competing paste'), 'agy', 'own text'), false);
});

test('agy image dispatch never pastes or submits after a readiness or attachment failure', async () => {
  const { deliverFirstPrompt } = await import('./dispatch-runner.js');
  let pastes = 0, sends = 0;
  const args = { tmux: 'ag_fixture', agent: 'agy', text: 'image prompt', imagePaths: ['/tmp/fixture.png'] };
  const deps = { waitReady: async () => false, paste: async () => { pastes++; return false; }, send: async () => { sends++; }, log: () => {} };
  await deliverFirstPrompt(args, deps);
  assert.equal(pastes, 0); assert.equal(sends, 0);
  await deliverFirstPrompt(args, { ...deps, waitReady: async () => true });
  assert.equal(pastes, 1); assert.equal(sends, 0);
});
