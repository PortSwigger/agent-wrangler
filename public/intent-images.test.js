import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIntentImages } from './intent-images.js';
import { createExtImageStaging } from './ext-image-staging.js';
import { createStagedPreviews } from './staged-previews.js';

function el() {
  const listeners = {};
  return {
    hidden: false, children: [], textContent: '', value: '', selectionStart: 0, selectionEnd: 0, attrs: {}, style: {}, parent: null,
    addEventListener(t, fn) { (listeners[t] ||= []).push(fn); },
    removeEventListener(t, fn) { listeners[t] = (listeners[t] || []).filter((f) => f !== fn); },
    listenerCount: (t) => (listeners[t] || []).length,
    fire(t, e = {}) { for (const fn of [...(listeners[t] || [])]) fn(e); },
    appendChild(c) { this.children.push(c); c.parent = this; return c; },
    remove() { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); this.parent = null; },
    getBoundingClientRect: () => ({ top: 100, bottom: 132, left: 20, right: 52, width: 32, height: 32 }),
    setAttribute(k, v) { this.attrs[k] = String(v); },
    setRangeText(t) { this.value += t; },
    dispatchEvent() {},
  };
}
const doc = {
  createElement: () => { const e = el(); Object.defineProperty(e, 'textContent', { set() { e.children = []; }, get() { return ''; } }); return e; },
  defaultView: Object.assign(el(), { innerWidth: 1000, innerHeight: 800 }),
};
function fakePreviews() {
  let n = 0;
  const revoked = [];
  const previews = createStagedPreviews({ createObjectURL: () => `blob:fake/${++n}`, revokeObjectURL: (u) => revoked.push(u) });
  return { previews, revoked };
}
function setup({ enabled = () => true, previews, frame = { mime: 'image/png', dataBase64: 'AA==' }, previewHost, adoptBlob } = {}) {
  const input = el();
  const listEl = el();
  Object.defineProperty(listEl, 'textContent', { set() { listEl.children = []; }, get() { return ''; } });
  const sent = [];
  const toasts = [];
  const ii = createIntentImages({
    input, listEl, send: (m) => { sent.push(m); return true; }, toast: (t) => toasts.push(t), enabled,
    frameOf: async () => frame, document: doc, previews, previewHost, adoptBlob,
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

const thumbOf = (chip) => chip.children.find((c) => c.className === 'chat-attachment-thumb');
const dropOf = (chip) => chip.children.find((c) => c.className === 'chat-attachment-drop');

test('a pasted image chip shows a thumbnail of what was uploaded, before its label', async () => {
  const { previews } = fakePreviews();
  const { ii, input, listEl, sent } = setup({ previews });
  input.fire('paste', paste([png()]));
  await tick();
  ii.onResult({ token: sent[0].token, ok: true, name: 'paste-1-aaaa.png' });
  assert.equal(previews.urlFor('paste-1-aaaa.png'), 'blob:fake/1');
  const chip = listEl.children[0];
  const thumb = thumbOf(chip);
  assert.ok(thumb, 'a thumbnail is drawn');
  assert.equal(chip.children[0], thumb);
  assert.equal(thumb.src, 'blob:fake/1');
  assert.equal(thumb.alt, 'Image #1');
  assert.equal(thumb.tabIndex, 0, 'focusable, so the preview is reachable by keyboard');
});

test('a chip with no preview stays text-only, as does a format the browser cannot draw', async () => {
  const { previews } = fakePreviews();
  const { ii, listEl } = setup({ previews });
  ii.adopt(['paste-9-zzzz.png']);
  assert.equal(thumbOf(listEl.children[0]), undefined);
  assert.equal(listEl.children[0].children.length, 2, 'label and remove button, as before');
  const heic = setup({ previews, frame: { mime: 'image/heic', dataBase64: 'AA==' } });
  heic.input.fire('paste', paste([new File([new Uint8Array([1])], 'a.heic', { type: 'image/heic' })]));
  await tick();
  heic.ii.onResult({ token: heic.sent[0].token, ok: true, name: 'paste-2-heic.heic' });
  assert.equal(thumbOf(heic.listEl.children[0]), undefined);
  assert.equal(previews.urlFor('paste-2-heic.heic'), null);
});

test('a failed or dropped upload remembers no preview', async () => {
  const { previews } = fakePreviews();
  const { ii, input, sent } = setup({ previews });
  input.fire('paste', paste([png(), png()]));
  await tick();
  ii.onResult({ token: sent[0].token, ok: false, error: 'Too big' });
  ii.reset();
  ii.onResult({ token: sent[1].token, ok: true, name: 'paste-1-late.png' });
  assert.equal(previews.size(), 0);
});

test('adopt shows previews for names an extension staged through api.images.stage', async () => {
  const { previews } = fakePreviews();
  const extSent = [];
  const ext = createExtImageStaging({
    send: (m) => { extSent.push(m); return true; },
    frameOf: async () => ({ mime: 'image/png', dataBase64: 'AA==' }),
  });
  const staged = ext.stage({ name: 'shot.png', type: 'image/png', size: 1 });
  await tick();
  ext.onResult({ token: extSent[0].token, ok: true, name: 'paste-5-ext.png' });
  await staged;
  assert.equal(previews.size(), 0, 'staged but not yet adopted: no object URL');
  const { ii, listEl } = setup({ previews, adoptBlob: (n) => ext.takeBlob(n) });
  ii.reset();
  ii.adopt(['paste-5-ext.png']);
  assert.equal(thumbOf(listEl.children[0])?.src, 'blob:fake/1');
});

test('reset keeps the previews of names about to be adopted again', () => {
  const { previews, revoked } = fakePreviews();
  const { ii, listEl } = setup({ previews });
  previews.remember('a.png', new Blob([new Uint8Array([1])], { type: 'image/png' }));
  previews.remember('b.png', new Blob([new Uint8Array([1])], { type: 'image/png' }));
  ii.adopt(['a.png', 'b.png']);
  ii.reset({ keep: ['a.png'] });
  assert.deepEqual(revoked, ['blob:fake/2']);
  ii.adopt(['a.png']);
  assert.equal(thumbOf(listEl.children[0])?.src, 'blob:fake/1');
});

test('reset revokes every preview the dialog showed since the last reset, removed chips included, and nothing else', async () => {
  const { previews, revoked } = fakePreviews();
  const { ii, listEl } = setup({ previews });
  for (const n of ['a.png', 'b.png', 'c.png']) previews.remember(n, new Blob([new Uint8Array([1])], { type: 'image/png' }));
  ii.adopt(['a.png', 'b.png']);
  dropOf(listEl.children[0]).fire('click');
  assert.deepEqual(revoked, [], 'removing a chip does not revoke at once');
  assert.equal(previews.urlFor('a.png'), 'blob:fake/1');
  ii.reset();
  assert.deepEqual(revoked.sort(), ['blob:fake/1', 'blob:fake/2']);
  assert.equal(previews.urlFor('c.png'), 'blob:fake/3', 'staged but never shown: left for its owner (or eviction)');
});

function withPreview() {
  const { previews } = fakePreviews();
  previews.remember('a.png', new Blob([new Uint8Array([1])], { type: 'image/png' }));
  const host = el();
  const t = setup({ previews, previewHost: host });
  t.ii.adopt(['a.png']);
  const thumb = thumbOf(t.listEl.children[0]);
  const preview = () => host.children.find((c) => c.className === 'chat-attachment-preview');
  return { ...t, host, thumb, preview };
}
const key = (k) => ({ key: k, prevented: false, stopped: false, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } });

test('hover shows the preview on the host; leaving hides it unless the thumbnail has focus', () => {
  const { thumb, preview } = withPreview();
  thumb.fire('mouseenter');
  assert.ok(preview(), 'shown on hover');
  assert.equal(preview().children[0].src, 'blob:fake/1');
  thumb.fire('mouseleave');
  assert.equal(preview(), undefined);
  thumb.fire('focus');
  thumb.fire('mouseenter');
  thumb.fire('mouseleave');
  assert.ok(preview(), 'still focused, so still open');
  thumb.fire('mouseenter');
  thumb.fire('blur');
  assert.ok(preview(), 'still hovered, so still open');
  thumb.fire('mouseleave');
  assert.equal(preview(), undefined);
});

test('Escape on the dialog closes an open preview without reaching the dialog, and passes through otherwise', () => {
  const { host, thumb, preview } = withPreview();
  const idle = key('Escape');
  host.fire('keydown', idle);
  assert.equal(idle.stopped, false, 'no preview: the dialog cancels as usual');
  thumb.fire('mouseenter');
  const esc = key('Escape');
  host.fire('keydown', esc);
  assert.ok(esc.stopped && esc.prevented);
  assert.equal(preview(), undefined);
});

test('scroll, resize and a broken preview image hide the preview; the listeners go with it', () => {
  const { host, thumb, preview } = withPreview();
  thumb.fire('mouseenter');
  assert.equal(host.listenerCount('scroll'), 1);
  assert.equal(doc.defaultView.listenerCount('resize'), 1);
  host.fire('scroll');
  assert.equal(preview(), undefined);
  assert.equal(host.listenerCount('scroll'), 0);
  assert.equal(doc.defaultView.listenerCount('resize'), 0);
  thumb.fire('mouseenter');
  doc.defaultView.fire('resize');
  assert.equal(preview(), undefined);
  thumb.fire('mouseenter');
  preview().children[0].fire('error');
  assert.equal(preview(), undefined);
});
