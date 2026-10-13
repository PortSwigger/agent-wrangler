import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIntentImages } from './intent-images.js';

function el() {
  const listeners = {};
  return {
    hidden: false, children: [], textContent: '', value: '', selectionStart: 0, selectionEnd: 0,
    addEventListener(t, fn) { (listeners[t] ||= []).push(fn); },
    fire(t, e) { for (const fn of listeners[t] || []) fn(e); },
    appendChild(c) { this.children.push(c); return c; },
    setAttribute() {},
    setRangeText(t) { this.value += t; },
    dispatchEvent() {},
  };
}
const doc = { createElement: () => { const e = el(); Object.defineProperty(e, 'textContent', { set() { e.children = []; }, get() { return ''; } }); return e; } };
function setup({ enabled = () => true } = {}) {
  const input = el();
  const listEl = el();
  Object.defineProperty(listEl, 'textContent', { set() { listEl.children = []; }, get() { return ''; } });
  const sent = [];
  const toasts = [];
  const ii = createIntentImages({
    input, listEl, send: (m) => { sent.push(m); return true; }, toast: (t) => toasts.push(t), enabled,
    frameOf: async () => ({ mime: 'image/png', dataBase64: 'AA==' }), document: doc,
  });
  return { ii, input, listEl, sent, toasts };
}
const paste = (files, data = {}) => ({
  prevented: false, preventDefault() { this.prevented = true; },
  clipboardData: { files, items: [], getData: (t) => data[t] ?? '' },
});
const png = () => new File([new Uint8Array([1])], 'a.png', { type: 'image/png' });
const tick = () => new Promise((r) => setImmediate(r));

test('a pasted image is uploaded STAGED and becomes a chip holding the minted name', async () => {
  const { ii, input, listEl, sent } = setup();
  const e = paste([png()]);
  input.fire('paste', e);
  assert.ok(e.prevented);
  await tick();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].staged, true);
  assert.equal(sent[0].sessionId, undefined, 'no session exists yet');
  assert.ok(ii.busy());
  assert.equal(ii.onResult({ token: sent[0].token, ok: true, name: 'paste-1-abcd.png' }), true);
  assert.deepEqual(ii.names(), ['paste-1-abcd.png']);
  assert.equal(listEl.hidden, false);
  assert.equal(listEl.children.length, 1);
  assert.equal(ii.busy(), false);
});

test('text pastes are untouched, and nothing is taken while disabled (schedules)', async () => {
  const { input, sent } = setup({ enabled: () => false });
  const e = paste([png()]);
  input.fire('paste', e);
  assert.equal(e.prevented, false);
  const t = setup();
  const te = paste([], { 'text/plain': 'just words' });
  t.input.fire('paste', te);
  assert.equal(te.prevented, false);
  await tick();
  assert.equal(sent.length + t.sent.length, 0);
});

test('reset drops chips and makes an in-flight reply unmatchable', async () => {
  const { ii, input, sent } = setup();
  input.fire('paste', paste([png()]));
  await tick();
  ii.reset();
  assert.equal(ii.onResult({ token: sent[0].token, ok: true, name: 'paste-1-abcd.png' }), true, 'still ours, so the chat view never sees it');
  assert.deepEqual(ii.names(), []);
});

test('a failed upload is toasted; replies for other tokens are not ours', async () => {
  const { ii, input, sent, toasts } = setup();
  input.fire('paste', paste([png()]));
  await tick();
  assert.equal(ii.onResult({ token: 'term#1', ok: true }), false);
  assert.equal(ii.onResult({ token: '4#2', ok: true }), false);
  ii.onResult({ token: sent[0].token, ok: false, error: 'That image is over 10 MB.' });
  assert.deepEqual(toasts, ['That image is over 10 MB.']);
  assert.deepEqual(ii.names(), []);
});
