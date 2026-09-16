import { test } from 'node:test';
import assert from 'node:assert/strict';
import { waitForComposerReady, ensureSubmitted } from './pane-ready.js';

const ESC = '';
// Byte-exact against ghost-suggestion.js's own markers — paneComposerIsEmpty
// compares the composer line for EQUALITY, so an approximation reads as "not
// empty" and this file would pass while asserting nothing.
const codexEmpty = `${ESC}[1m›${ESC}[0m ${ESC}[2mAsk Codex to do anything${ESC}[0m`;
const claudeEmpty = `${ESC}[0m❯ `;
const booting = 'Loading…';
const noop = async () => {};
const nowait = () => Promise.resolve();

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
  const ok = await waitForComposerReady('cc_a', '/s', 'claude', {
    capture: async () => claudeEmpty, sleep: nowait,
  });
  assert.equal(ok, true);
  const notOk = await waitForComposerReady('cc_a', '/s', 'claude', {
    capture: async () => codexEmpty, timeoutMs: 0, sleep: nowait,
  });
  assert.equal(notOk, false);
});

// A timeout must FALL THROUGH to the caller's paste, not abort it: a late
// message beats a lost one, and an unreadable pane must still be deliverable.
test('waitForComposerReady returns false on timeout rather than throwing', async () => {
  const ok = await waitForComposerReady('cx_a', '/s', 'codex', {
    capture: async () => booting, timeoutMs: 0, sleep: nowait,
  });
  assert.equal(ok, false);
});

test('ensureSubmitted is a no-op once the pane reports working', async () => {
  const keys = [];
  const ok = await ensureSubmitted('cx_a', '/s', {
    capture: async () => '… esc to interrupt …',
    sendKeys: async (n, k) => keys.push(k),
    wasReady: true, sleep: nowait,
  });
  assert.equal(ok, true);
  assert.deepEqual(keys, []);
});

// The measured failure: the paste lands in the composer but the CR that follows
// it is dropped, so the text sits there unsent. A bare Enter repairs exactly
// that, and re-pasting must never be used — the text IS already in the composer,
// so a second paste would fuse the two into one mangled prompt.
test('ensureSubmitted retries with a bare Enter (never a re-paste) when nothing started', async () => {
  const keys = [];
  let pane = 'idle pane';
  const ok = await ensureSubmitted('cx_a', '/s', {
    capture: async () => pane,
    sendKeys: async (n, k) => { keys.push(k); pane = '… esc to interrupt …'; },
    wasReady: true, windowMs: 0, sleep: nowait,
  });
  assert.equal(ok, true);
  assert.deepEqual(keys, [['Enter']]);
});

test('ensureSubmitted gives up after its attempt budget', async () => {
  const keys = [];
  const ok = await ensureSubmitted('cx_a', '/s', {
    capture: async () => 'idle pane',
    sendKeys: async (n, k) => keys.push(k),
    wasReady: true, attempts: 2, windowMs: 0, sleep: nowait,
  });
  assert.equal(ok, false);
  assert.equal(keys.length, 2);
});

// The whole safety case for pressing Enter a second time is that we saw a
// well-formed EMPTY composer moments earlier, so no dialog can be on screen.
// Without that, a stray Enter could confirm Codex's self-update menu (which
// defaults to "Update now" on a bare Enter) and kill the session — so an
// unconfirmed pane gets exactly today's behaviour and no extra keys.
test('ensureSubmitted sends nothing when the pane was never confirmed ready', async () => {
  const keys = [];
  const ok = await ensureSubmitted('cx_a', '/s', {
    capture: async () => 'idle pane',
    sendKeys: async (n, k) => keys.push(k),
    wasReady: false, windowMs: 0, sleep: nowait,
  });
  assert.equal(ok, false);
  assert.deepEqual(keys, []);
});

test('ensureSubmitted never captures or sends when handed no pane', async () => {
  let touched = false;
  const ok = await ensureSubmitted('', '/s', {
    capture: async () => { touched = true; return ''; }, sendKeys: noop, wasReady: true, sleep: nowait,
  });
  assert.equal(ok, false);
  assert.equal(touched, false);
});
