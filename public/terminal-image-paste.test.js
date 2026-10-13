import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTerminalImagePaste } from './terminal-image-paste.js';

function fakeEl() {
  const listeners = [];
  return {
    listeners,
    addEventListener(type, fn, capture) { listeners.push({ type, fn, capture: !!capture }); },
    removeEventListener(type, fn) { const i = listeners.findIndex((l) => l.type === type && l.fn === fn); if (i >= 0) listeners.splice(i, 1); },
    fire(type, e) { for (const l of listeners.filter((x) => x.type === type)) l.fn(e); },
  };
}
function pasteEvent(data, files = []) {
  const e = { prevented: false, stopped: false, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } };
  e.clipboardData = { files, items: [], types: Object.keys(data), getData: (t) => data[t] ?? '' };
  return e;
}
const tick = () => new Promise((r) => setImmediate(r));
const png = () => new File([new Uint8Array([1])], 'a.png', { type: 'image/png' });

test('an image paste is taken before xterm sees it and sent into the pane', async () => {
  const sent = [];
  const tp = createTerminalImagePaste({ send: (m) => { sent.push(m); return true; }, toast: () => {}, frameOf: async () => ({ mime: 'image/png', dataBase64: 'AA==' }) });
  const el = fakeEl();
  tp.attach(el, { sessionId: 'S1', pasteText: () => assert.fail('no text to paste') });
  assert.ok(el.listeners.find((l) => l.type === 'paste').capture, 'capture phase, so it runs before xterm');
  const e = pasteEvent({}, [png()]);
  el.fire('paste', e);
  assert.ok(e.prevented && e.stopped);
  await tick();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'paste-image');
  assert.equal(sent[0].sessionId, 'S1');
  assert.equal(sent[0].intoPane, true);
  assert.match(sent[0].token, /^term#/);
});

test('a text paste is left to xterm untouched', () => {
  const tp = createTerminalImagePaste({ send: () => assert.fail('nothing to send'), toast: () => {} });
  const el = fakeEl();
  tp.attach(el, { sessionId: 'S1', pasteText: () => assert.fail('xterm pastes it, not us') });
  const e = pasteEvent({ 'text/plain': 'ls -la' });
  el.fire('paste', e);
  assert.ok(!e.prevented && !e.stopped);
});

test('several images go one at a time, each after the previous reply, and the words around them are pasted', async () => {
  const sent = [];
  const pasted = [];
  const tp = createTerminalImagePaste({ send: (m) => { sent.push(m); return true; }, toast: () => {}, frameOf: async (s) => ({ mime: 'image/png', dataBase64: s.url }) });
  const el = fakeEl();
  tp.attach(el, { sessionId: 'S1', pasteText: (t) => pasted.push(t) });
  el.fire('paste', pasteEvent({ 'text/plain': 'two pics', 'text/html': 'two <img src="https://a.test/1.png"><img src="https://a.test/2.png"> pics' }));
  assert.deepEqual(pasted, ['two pics']);
  await tick();
  assert.equal(sent.length, 1, 'the second waits for the first reply');
  assert.equal(tp.onResult({ type: 'paste-image-result', token: sent[0].token, ok: true }), true);
  await tick();
  assert.deepEqual(sent.map((m) => m.dataBase64), ['https://a.test/1.png', 'https://a.test/2.png']);
});

test('a failed reply is toasted; a reply that is not ours is left for the chat view', async () => {
  const toasts = [];
  const sent = [];
  const tp = createTerminalImagePaste({ send: (m) => { sent.push(m); return true; }, toast: (t, err) => toasts.push([t, err]), frameOf: async () => ({ mime: 'image/png', dataBase64: 'AA==' }) });
  const el = fakeEl();
  tp.attach(el, { sessionId: 'S1', pasteText: () => {} });
  el.fire('paste', pasteEvent({}, [png()]));
  await tick();
  assert.equal(tp.onResult({ token: '3#1', ok: true }), false);
  assert.equal(tp.onResult({ token: sent[0].token, ok: false, error: 'That session has no live terminal to paste into.' }), true);
  assert.deepEqual(toasts, [['That session has no live terminal to paste into.', true]]);
});

test('detach removes every listener', () => {
  const tp = createTerminalImagePaste({ send: () => true, toast: () => {} });
  const el = fakeEl();
  const detach = tp.attach(el, { sessionId: 'S1', pasteText: () => {} });
  assert.equal(el.listeners.length, 3);
  detach();
  assert.equal(el.listeners.length, 0);
});
