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

test('adopt renders already-staged names as removable chips after any pasted ones', async () => {
  const { ii, input, listEl, sent } = setup();
  input.fire('paste', paste([png()]));
  await tick();
  ii.onResult({ token: sent[0].token, ok: true, name: 'paste-1-aaaa.png' });
  ii.adopt(['paste-2-bbbb.png', 'paste-3-cccc.png']);
  assert.deepEqual(ii.names(), ['paste-1-aaaa.png', 'paste-2-bbbb.png', 'paste-3-cccc.png']);
  assert.equal(listEl.hidden, false);
  assert.equal(listEl.children.length, 3);
  // The second chip's remove button drops just that name.
  listEl.children[1].children[1].fire('click');
  assert.deepEqual(ii.names(), ['paste-1-aaaa.png', 'paste-3-cccc.png']);
  assert.equal(sent.length, 1, 'an adopted name is never uploaded again');
});

test('adopt honours the attachment cap, counting in-flight uploads, and toasts the overflow', async () => {
  const { ii, input, toasts } = setup();
  input.fire('paste', paste([png()]));
  await tick();
  const many = Array.from({ length: 9 }, (_, i) => `paste-${i}-abcd.png`);
  ii.adopt(many);
  assert.deepEqual(ii.names(), many.slice(0, 7), 'one slot is held by the pending upload');
  assert.deepEqual(toasts, ['2 images were skipped — a first prompt holds 8.']);
  ii.adopt(['paste-99-abcd.png']);
  assert.equal(ii.names().length, 7);
  assert.equal(toasts[1], '1 image was skipped — a first prompt holds 8.');
});

test('adopt after reset survives; a later reset clears adopted names too', () => {
  const { ii, listEl } = setup();
  ii.reset();
  ii.adopt(['paste-1-abcd.png', 'paste-1-abcd.png']);
  assert.deepEqual(ii.names(), ['paste-1-abcd.png'], 'a duplicate name is one chip');
  ii.reset();
  assert.deepEqual(ii.names(), []);
  assert.equal(listEl.hidden, true);
  ii.adopt([]);
  assert.equal(listEl.hidden, true);
});
