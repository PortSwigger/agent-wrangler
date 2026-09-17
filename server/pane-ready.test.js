import { test } from 'node:test';
import assert from 'node:assert/strict';
import { waitForComposerReady, ensureSubmitted, composerHoldsText } from './pane-ready.js';

const ESC = '';
// Byte-exact against ghost-suggestion.js's own markers — paneComposerIsEmpty
// compares the composer line for EQUALITY, so an approximation reads as "not
// empty" and this file would pass while asserting nothing (a bug this file
// really did have once).
const codexEmpty = `${ESC}[1m›${ESC}[0m ${ESC}[2mAsk Codex to do anything${ESC}[0m`;
const claudeEmpty = `${ESC}[0m❯ `;
const booting = 'Loading…';
const working = '• Working (3s • esc to interrupt)';
const nowait = () => Promise.resolve();
const MSG = 'wake up please';
const codexHolding = `${ESC}[1m›${ESC}[0m ${MSG}`;

// classify()'s Codex self-update menu — a numbered list whose bare-Enter default
// is "Update now", which kills the session.
const updateMenu = [
  'Update available!',
  '1. Update now (runs `brew upgrade --cask codex`)',
  '2. Skip',
  '3. Skip until next version',
  'press enter to continue',
].join('\n');

test('waitForComposerReady resolves true as soon as the composer paints', async () => {
  let calls = 0;
  const ok = await waitForComposerReady('cx_a', '/s', 'codex', {
    capture: async () => { calls += 1; return calls < 3 ? booting : codexEmpty; },
    sleep: nowait,
  });
  assert.equal(ok, true);
  assert.equal(calls, 3);
});

test('waitForComposerReady is agent-aware (a Codex composer is not a Claude one)', async () => {
  assert.equal(await waitForComposerReady('cc_a', '/s', 'claude', {
    capture: async () => claudeEmpty, sleep: nowait,
  }), true);
  assert.equal(await waitForComposerReady('cc_a', '/s', 'claude', {
    capture: async () => codexEmpty, timeoutMs: 0, sleep: nowait,
  }), false);
});

// A timeout must FALL THROUGH to the caller's paste, not abort it — but the
// caller then reports UNKNOWN rather than success (see message-delivery).
test('waitForComposerReady returns false on timeout rather than throwing', async () => {
  assert.equal(await waitForComposerReady('cx_a', '/s', 'codex', {
    capture: async () => booting, timeoutMs: 0, sleep: nowait,
  }), false);
});

test('composerHoldsText reads the LAST marked line, so a submitted turn\'s echo is not mistaken for the composer', () => {
  // Exactly the shape a real pane takes after a successful send: the turn is
  // echoed back into the scrollback with the same prompt mark, and the empty
  // composer sits below it.
  const afterSubmit = `${codexHolding}\n• ACK\n${codexEmpty}`;
  assert.equal(composerHoldsText(afterSubmit, 'codex', MSG), false);
  assert.equal(composerHoldsText(`boot\n${codexHolding}`, 'codex', MSG), true);
});

test('composerHoldsText fails safe on an unparseable pane or empty text', () => {
  assert.equal(composerHoldsText('', 'codex', MSG), false);
  assert.equal(composerHoldsText(null, 'codex', MSG), false);
  assert.equal(composerHoldsText(codexHolding, 'codex', ''), false);
  assert.equal(composerHoldsText('no mark here at all', 'codex', MSG), false);
});

test('ensureSubmitted is a no-op once the pane reports working', async () => {
  const keys = [];
  const ok = await ensureSubmitted('cx_a', '/s', {
    text: MSG, agent: 'codex',
    capture: async () => working,
    sendKeys: (n, k) => { keys.push(k); return Promise.resolve(); },
    sleep: nowait,
  });
  assert.equal(ok, true);
  assert.deepEqual(keys, []);
});

// The measured failure: the paste lands in the composer but the CR that follows
// it is dropped, so the text sits there unsent. A bare Enter repairs exactly
// that, and re-pasting must never be used — the text IS already in the composer.
test('ensureSubmitted repairs a stranded paste with a bare Enter (never a re-paste)', async () => {
  const keys = [];
  let pane = codexHolding;
  const ok = await ensureSubmitted('cx_a', '/s', {
    text: MSG, agent: 'codex', windowMs: 0,
    capture: async () => pane,
    sendKeys: (n, k) => { keys.push(k); pane = working; return Promise.resolve(); },
    sleep: nowait,
  });
  assert.equal(ok, true);
  assert.deepEqual(keys, [['Enter']]);
});

// THE regression this redesign exists for. paneComposerIsEmpty deliberately
// strips faint runs, so a Claude composer holding nothing but a ghost suggestion
// reads as EMPTY — while pressing Enter on ghost text submits it
// (ghost-suggestion.js says so). Gating the repair on "we saw an empty composer
// before sending" would therefore fire here and start an unsolicited turn in
// text nobody wrote. Gating on our own text being present cannot.
test('ensureSubmitted never presses Enter on a ghost suggestion', async () => {
  const keys = [];
  const ghost = `${ESC}[0m❯ ${ESC}[2mshall I run the tests?${ESC}[0m`;
  const ok = await ensureSubmitted('cc_a', '/s', {
    text: MSG, agent: 'claude', windowMs: 0,
    capture: async () => ghost,
    sendKeys: (n, k) => { keys.push(k); return Promise.resolve(); },
    sleep: nowait,
  });
  assert.equal(ok, false, 'unconfirmed, so the caller reports unknown');
  assert.deepEqual(keys, [], 'a ghost suggestion must never be submitted');
});

// A dialog can appear AFTER the pre-send readiness check, so "we saw an empty
// composer earlier" proves nothing here. classify() already calls the Codex
// self-update menu needs-you; the loop must stop on it rather than press the
// Enter that would choose "Update now".
test('ensureSubmitted stops dead on a needs-you dialog and sends no keys', async () => {
  const keys = [];
  const ok = await ensureSubmitted('cx_a', '/s', {
    text: MSG, agent: 'codex',
    capture: async () => updateMenu,
    sendKeys: (n, k) => { keys.push(k); return Promise.resolve(); },
    sleep: nowait,
  });
  assert.equal(ok, false);
  assert.deepEqual(keys, []);
});

// A turn that submitted and finished inside the observation window leaves an
// empty composer. That is deliberately NOT read as success (pre-paste looks
// identical), but it must not earn an Enter either.
test('ensureSubmitted sends no Enter against an empty composer', async () => {
  const keys = [];
  const ok = await ensureSubmitted('cx_a', '/s', {
    text: MSG, agent: 'codex', windowMs: 0,
    capture: async () => codexEmpty,
    sendKeys: (n, k) => { keys.push(k); return Promise.resolve(); },
    sleep: nowait,
  });
  assert.equal(ok, false);
  assert.deepEqual(keys, []);
});

// Another paste path (pane-deferral's drain, a mail announcement) can land in
// the same pane. Its text is not ours, so the repair must keep its hands off
// rather than submit someone else's half-delivered content.
test('ensureSubmitted will not submit a competing paste it did not write', async () => {
  const keys = [];
  const other = `${ESC}[1m›${ESC}[0m [Agent Wrangler] PR #12 checks passing`;
  const ok = await ensureSubmitted('cx_a', '/s', {
    text: MSG, agent: 'codex', windowMs: 0,
    capture: async () => other,
    sendKeys: (n, k) => { keys.push(k); return Promise.resolve(); },
    sleep: nowait,
  });
  assert.equal(ok, false);
  assert.deepEqual(keys, []);
});

// "Stranded" is judged only after the full window: immediately post-sendText the
// text is legitimately in the composer with the original Enter still in flight,
// and pressing again there races the TUI into two turns of the same prompt.
test('ensureSubmitted gives the original Enter its full window before repairing', async () => {
  const keys = [];
  let polls = 0;
  const ok = await ensureSubmitted('cx_a', '/s', {
    text: MSG, agent: 'codex', windowMs: 1000, pollMs: 300,
    capture: async () => { polls += 1; return polls < 3 ? codexHolding : working; },
    sendKeys: (n, k) => { keys.push(k); return Promise.resolve(); },
    sleep: nowait,
  });
  assert.equal(ok, true);
  assert.deepEqual(keys, [], 'the original Enter landed; no repair needed');
});

test('ensureSubmitted gives up after its attempt budget', async () => {
  const keys = [];
  const ok = await ensureSubmitted('cx_a', '/s', {
    text: MSG, agent: 'codex', attempts: 2, windowMs: 0,
    capture: async () => codexHolding,
    sendKeys: (n, k) => { keys.push(k); return Promise.resolve(); },
    sleep: nowait,
  });
  assert.equal(ok, false);
  assert.equal(keys.length, 2);
});

test('ensureSubmitted never captures or sends when handed no pane', async () => {
  let touched = false;
  const ok = await ensureSubmitted('', '/s', {
    text: MSG,
    capture: async () => { touched = true; return ''; },
    sendKeys: () => Promise.resolve(),
    sleep: nowait,
  });
  assert.equal(ok, false);
  assert.equal(touched, false);
});
