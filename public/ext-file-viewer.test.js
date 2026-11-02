import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createExtFileViewer } from './ext-file-viewer.js';

const here = path.dirname(fileURLToPath(import.meta.url));

// Just enough of a DOM for the viewer: a <dialog> that records showModal/close,
// listeners per element, and focus tracking.
function fakeEl(doc, id) {
  const listeners = {};
  return {
    id, textContent: '', innerHTML: '', children: [],
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    dispatch(type, init = {}) {
      const e = { type, target: this, defaultPrevented: false, propagationStopped: false, ...init,
        preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.propagationStopped = true; } };
      for (const fn of listeners[type] || []) fn(e);
      return e;
    },
    replaceChildren(...c) { this.children = c; },
    focus() { doc.activeElement = this; },
  };
}

function harness(replies) {
  const doc = { activeElement: null };
  const els = Object.fromEntries(['ext-file-modal', 'ext-file-title', 'ext-file-path', 'ext-file-body', 'ext-file-close'].map((id) => [id, fakeEl(doc, id)]));
  const modal = els['ext-file-modal'];
  modal.open = false;
  modal.calls = [];
  modal.showModal = () => { assert.equal(modal.open, false, 'showModal on an open dialog throws'); modal.open = true; modal.calls.push('showModal'); };
  modal.close = () => { modal.open = false; modal.calls.push('close'); };
  doc.getElementById = (id) => els[id];
  doc.createElement = (tag) => ({ tag });
  const fetchImpl = async () => ({ json: async () => (typeof replies === 'function' ? replies() : replies) });
  const viewer = createExtFileViewer({ document: doc, fetchImpl, renderMarkdown: (md) => `<p>${md}</p>` });
  return { viewer, modal, els, doc };
}

const MD = { ok: true, kind: 'markdown', path: '/w/out/report.md', text: 'hi' };

test('index.html declares the viewer as a <dialog>, so showModal puts it in the top layer', () => {
  const html = fs.readFileSync(path.join(here, 'index.html'), 'utf8');
  assert.match(html, /<dialog id="ext-file-modal"/);
});

test('open shows the file with showModal, focuses Close and replies { ok:true }', async () => {
  const { viewer, modal, els, doc } = harness(MD);
  assert.deepEqual(await viewer.open('ext', MD.path), { ok: true });
  assert.deepEqual(modal.calls, ['showModal']);
  assert.equal(els['ext-file-title'].textContent, 'report.md');
  assert.equal(els['ext-file-body'].innerHTML, '<p>hi</p>');
  assert.equal(doc.activeElement, els['ext-file-close']);
  // A second open while shown swaps the content without calling showModal again.
  await viewer.open('ext', MD.path);
  assert.deepEqual(modal.calls, ['showModal']);
});

test('a failed reply opens nothing and passes the reason through', async () => {
  const { viewer, modal } = harness({ ok: false, reason: 'not-found' });
  assert.deepEqual(await viewer.open('ext', '/gone.md'), { ok: false, reason: 'not-found' });
  assert.deepEqual(modal.calls, []);
});

test('Escape closes the viewer and does not reach the page behind it', async () => {
  const { viewer, modal } = harness(MD);
  await viewer.open('ext', MD.path);
  const e = modal.dispatch('keydown', { key: 'Escape' });
  assert.equal(modal.open, false);
  assert.ok(e.defaultPrevented && e.propagationStopped);
});

test('the dialog cancel event (Escape with focus elsewhere) closes through the same path', async () => {
  const { viewer, modal } = harness(MD);
  await viewer.open('ext', MD.path);
  const e = modal.dispatch('cancel');
  assert.ok(e.defaultPrevented);
  assert.equal(modal.open, false);
});

test('a backdrop mousedown closes; one inside the card does not', async () => {
  const { viewer, modal, els } = harness(MD);
  await viewer.open('ext', MD.path);
  modal.dispatch('mousedown', { target: els['ext-file-body'] });
  assert.equal(modal.open, true);
  modal.dispatch('mousedown', { target: modal });
  assert.equal(modal.open, false);
});

test('the Close button closes, and close() on a closed viewer is a no-op', async () => {
  const { viewer, modal, els } = harness(MD);
  await viewer.open('ext', MD.path);
  els['ext-file-close'].dispatch('click');
  viewer.close();
  assert.deepEqual(modal.calls, ['showModal', 'close']);
});

test('a slow reply does not reopen the viewer after it was closed', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const { viewer, modal } = harness(async () => { await gate; return MD; });
  const pending = viewer.open('ext', MD.path);
  viewer.close();
  release();
  assert.deepEqual(await pending, { ok: true });
  assert.deepEqual(modal.calls, []);
});
