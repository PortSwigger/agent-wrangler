import test from 'node:test';
import assert from 'node:assert/strict';
import { clearComposer } from './tmux-scraper.js';
import { deliverMessage } from './message-delivery.js';

// Regression cover for the concatenated-prompt bug. Interrupting a turn makes
// Claude Code restore the interrupted prompt into its OWN composer — verified
// against a live pane, and length-dependent, which is what made it look
// intermittent: a 72-character prompt was not restored, a 281-character one was.
// Every send from the chat view is a paste at the pane's cursor, so the edited
// prompt fused onto the original and the agent received both as ONE prompt.

const ESC = '';
const PROMPT = '❯';
// A composer line as `capture-pane -e` renders it: escapes present, so
// paneComposerIsEmpty can tell faint ghost text from something typed.
const pane = (content) => `${ESC}[0m some earlier output\n${ESC}[0m ${PROMPT} ${content}\n`;
const EMPTY = pane('');
const GHOST = pane(`${ESC}[2mtry the other approach${ESC}[22m`);

test('clearComposer: a composer already empty is left alone — no keys pressed', async () => {
  const presses = [];
  const ok = await clearComposer('cc_x', 'sockA', {
    capture: async () => EMPTY,
    run: async (socket, args) => { presses.push(args); },
  });
  assert.equal(ok, true);
  assert.deepEqual(presses, []);
});

test('clearComposer: faint ghost text is NOT content, so it is not cleared', async () => {
  // Ghost text occupies the composer visually but a paste replaces it wholesale.
  // Pressing Ctrl+U at it would just fight the TUI.
  const presses = [];
  const ok = await clearComposer('cc_x', 'sockA', {
    capture: async () => GHOST,
    run: async (socket, args) => { presses.push(args); },
  });
  assert.equal(ok, true);
  assert.deepEqual(presses, []);
});

test('clearComposer: presses Ctrl+U once per line and stops as soon as the pane confirms empty', async () => {
  // Ctrl+U kills to the start of the LINE, so a three-line restored draft needs
  // three presses — hence a loop that re-reads rather than a fixed count.
  const frames = [pane('line three'), pane('line two'), pane('line one'), EMPTY];
  let i = 0;
  const presses = [];
  const ok = await clearComposer('cc_y', 'sockB', {
    capture: async () => frames[Math.min(i, frames.length - 1)],
    run: async (socket, args) => { presses.push({ socket, args }); i += 1; },
  });
  assert.equal(ok, true);
  assert.equal(presses.length, 3, 'stops on the first confirmed-empty frame, not after a fixed budget');
  assert.deepEqual(presses[0], { socket: 'sockB', args: ['send-keys', '-t', 'cc_y', 'C-u'] });
});

test('clearComposer: reports false when the pane will not come clean, rather than claiming success', async () => {
  // The caller has to be able to tell — pasting into a composer that refused to
  // empty is exactly the fusing this function exists to prevent.
  let presses = 0;
  const ok = await clearComposer('cc_z', '', {
    capture: async () => pane('stubborn draft'),
    run: async () => { presses += 1; },
    maxPresses: 3,
  });
  assert.equal(ok, false);
  assert.equal(presses, 4, 'bounded — it never presses forever');
});

test('clearComposer: an unreadable pane is treated as NOT empty (fail safe), never as clean', async () => {
  // paneComposerIsEmpty refuses to guess without escapes, and this must inherit
  // that: assuming "clean" here is how the bug gets back in.
  const ok = await clearComposer('cc_q', '', {
    capture: async () => '',
    run: async () => {},
    maxPresses: 1,
  });
  assert.equal(ok, false);
});

function deps({ live = true } = {}) {
  const calls = [];
  return {
    calls,
    tmuxFor: () => (live ? 'cc_x' : null),
    socketFor: () => 'sockA',
    clearComposer: async (name, socket) => { calls.push({ verb: 'clear', name, socket }); return true; },
    prefillPane: async (name, text) => { calls.push({ verb: 'prefill', text }); },
    sendText: async (name, text) => { calls.push({ verb: 'sendText', text }); },
    sessionManager: {
      entryFor: () => ({ agent: 'claude', cwd: '/tmp', liveSessionId: 'live-1', socket: 'sockA' }),
      isResuming: () => false,
      resume: async () => { calls.push({ verb: 'resume' }); return { tmux: 'cc_woken' }; },
    },
    memoryStore: { bindSession: () => {} },
    taskStore: { taskFor: () => null },
  };
}

test('deliverMessage: clears the pane composer BEFORE pasting the edited prompt', async () => {
  const d = deps();
  await deliverMessage('CARD1', 'the edited prompt', d, { clearComposer: true });
  assert.deepEqual(d.calls.map((c) => c.verb), ['clear', 'sendText']);
  assert.deepEqual(d.calls[0], { verb: 'clear', name: 'cc_x', socket: 'sockA' });
});

test('deliverMessage: without the flag the composer is untouched — a pane draft is the human\'s', async () => {
  const d = deps();
  await deliverMessage('CARD1', 'plain message', d);
  assert.deepEqual(d.calls.map((c) => c.verb), ['sendText']);
});

test('deliverMessage: clear runs before attachments, so an image is not thrown away with the draft', async () => {
  const d = deps();
  await deliverMessage('CARD1', 'look', d, { clearComposer: true, imagePaths: ['/m/pastes/paste-1-aa.png'] });
  assert.deepEqual(d.calls.map((c) => c.verb), ['clear', 'prefill', 'sendText']);
});

test('deliverMessage: a clear request forces the paste route on a dormant session', async () => {
  // The resume-intent shortcut hands the text to the CLI as a launch argument and
  // never touches a composer, so it would silently skip the clear.
  const d = deps({ live: false });
  const r = await deliverMessage('CARD1', 'edited after interrupt', d, { clearComposer: true });
  assert.equal(r.mode, 'dormant');
  assert.deepEqual(d.calls.map((c) => c.verb), ['resume', 'clear', 'sendText']);
});
