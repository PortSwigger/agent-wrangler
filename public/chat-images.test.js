import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createChatImages, base64ToBlob } from './chat-images.js';

const tick = () => new Promise((r) => setTimeout(r, 0));

function el(tag, className = '') {
  const node = {
    tagName: tag.toUpperCase(), className, children: [], dataset: {}, attrs: {}, _events: new Map(), _parent: null,
    appendChild(c) { c._parent = this; this.children.push(c); return c; },
    append(...cs) { for (const c of cs) this.appendChild(c); },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return this.attrs[k] ?? null; },
    addEventListener(type, fn) { (this._events.get(type) || this._events.set(type, []).get(type)).push(fn); },
    fire(type, extra = {}) { for (const fn of this._events.get(type) || []) fn({ target: this, preventDefault() {}, stopPropagation() {}, ...extra }); },
    focus() {},
    querySelector(sel) { return this.querySelectorAll(sel)[0] ?? null; },
    querySelectorAll(sel) {
      const want = sel.replace(/^\./, '');
      const out = [];
      const walk = (n) => { for (const c of n.children) { if (String(c.className).split(/\s+/).includes(want)) out.push(c); walk(c); } };
      walk(this);
      return out;
    },
    closest(sel) {
      for (let n = this; n; n = n._parent) if (sel === '[data-image-ref]' && n.dataset.imageRef != null) return n;
      return null;
    },
  };
  return node;
}

function thumb(ref) {
  const button = el('button', 'chat-image');
  button.dataset.imageRef = ref;
  button.dataset.state = 'pending';
  button.setAttribute('title', `Read: /a.png`);
  const img = el('img', 'chat-image-img');
  img.setAttribute('alt', 'Read: /a.png');
  button.appendChild(img);
  return button;
}

function setup({ fetchImage, observer = false } = {}) {
  const body = el('body');
  const doc = {
    body,
    createElement: (tag) => {
      const node = el(tag);
      if (tag === 'dialog') {
        node.open = false;
        node.showModal = () => { node.open = true; };
        node.close = () => { node.open = false; };
      }
      return node;
    },
  };
  const made = [];
  const revoked = [];
  const observed = [];
  let observerCb = null;
  const win = {
    URL: { createObjectURL: (blob) => { const u = `blob:test/${made.length}`; made.push({ u, blob }); return u; }, revokeObjectURL: (u) => revoked.push(u) },
    ...(observer ? {
      IntersectionObserver: class {
        constructor(cb) { observerCb = cb; }
        observe(t) { observed.push(t); }
        unobserve() {}
        disconnect() {}
      },
    } : {}),
  };
  const stream = el('div', 'chat-stream');
  let card = 'card-1';
  const calls = [];
  const images = createChatImages({
    stream, document: doc, win, currentCard: () => card,
    fetchImage: fetchImage || (async (c, ref) => { calls.push([c, ref]); return { ok: true, data: { mediaType: 'image/png', data: 'iVBORw0K' } }; }),
  });
  return { images, stream, body, made, revoked, observed, calls, setCard: (c) => { card = c; }, intersect: (t) => observerCb([{ isIntersecting: true, target: t }]) };
}

test('a thumbnail is fetched by its ref for the card on screen and drawn from a blob URL', async () => {
  const { images, stream, made, calls } = setup();
  const node = stream.appendChild(el('div', 'chat-activity'));
  const button = node.appendChild(thumb('1-2-0-8'));
  images.observe(node);
  await tick(); await tick();
  assert.deepEqual(calls, [['card-1', '1-2-0-8']]);
  assert.equal(button.dataset.state, 'loaded');
  assert.equal(button.querySelector('.chat-image-img').attrs.src, 'blob:test/0');
  assert.equal(made[0].blob.type, 'image/png');
});

test('with an IntersectionObserver, nothing is fetched until the thumbnail nears the viewport', async () => {
  const { images, stream, calls, observed, intersect } = setup({ observer: true });
  const node = stream.appendChild(el('div'));
  const button = node.appendChild(thumb('1-2-0-8'));
  images.observe(node);
  await tick();
  assert.deepEqual(calls, []);
  assert.deepEqual(observed, [button]);
  intersect(button);
  await tick(); await tick();
  assert.equal(calls.length, 1);
});

test('two thumbnails of one ref share one fetch and one URL', async () => {
  const { images, stream, calls, made } = setup();
  const node = stream.appendChild(el('div'));
  const a = node.appendChild(thumb('5-6-0-8'));
  const b = node.appendChild(thumb('5-6-0-8'));
  images.observe(node);
  await tick(); await tick();
  assert.equal(calls.length, 1);
  assert.equal(made.length, 1);
  assert.equal(a.querySelector('.chat-image-img').attrs.src, b.querySelector('.chat-image-img').attrs.src);
});

test('clicking a thumbnail opens it full size; clearing the stream closes it and revokes the URLs', async () => {
  const { images, stream, body, revoked } = setup();
  const node = stream.appendChild(el('div'));
  const button = node.appendChild(thumb('1-2-0-8'));
  images.observe(node);
  await tick(); await tick();
  const img = button.querySelector('.chat-image-img');
  stream.fire.call(stream, 'click', { target: img });
  await tick(); await tick();
  const dialog = body.children.find((c) => c.className === 'chat-image-dialog');
  assert.ok(dialog?.open, 'the full-size view is open');
  assert.equal(dialog.querySelector('.chat-image-full').attrs.src, 'blob:test/0');
  assert.equal(dialog.querySelector('.chat-image-dialog-caption').textContent, 'Read: /a.png');
  assert.equal(dialog.dataset.zoom, '0', 'fitted to the window first');
  dialog.querySelector('.chat-image-full').fire('click');
  assert.equal(dialog.dataset.zoom, '1', 'a click shows it at its own size');
  images.clear();
  assert.equal(dialog.open, false);
  assert.deepEqual(revoked, ['blob:test/0']);
});

test('a failed fetch marks the thumbnail, and clicking it tries again', async () => {
  let fail = true;
  const { images, stream } = setup({ fetchImage: async () => (fail ? { ok: false, error: { message: 'gone' } } : { ok: true, data: { mediaType: 'image/png', data: 'iVBORw0K' } }) });
  const node = stream.appendChild(el('div'));
  const button = node.appendChild(thumb('1-2-0-8'));
  images.observe(node);
  await tick(); await tick();
  assert.equal(button.dataset.state, 'failed');
  fail = false;
  stream.fire('click', { target: button });
  await tick(); await tick();
  assert.equal(button.dataset.state, 'loaded');
});

test('a fetch that lands after the stream was cleared makes no URL', async () => {
  let resolve;
  const { images, stream, made } = setup({ fetchImage: () => new Promise((r) => { resolve = r; }) });
  const node = stream.appendChild(el('div'));
  const button = node.appendChild(thumb('1-2-0-8'));
  images.observe(node);
  await tick();
  images.clear();
  resolve({ ok: true, data: { mediaType: 'image/png', data: 'iVBORw0K' } });
  await tick(); await tick();
  assert.equal(made.length, 0);
  assert.equal(button.dataset.state, 'loading', 'the detached thumbnail is left alone');
});

test('base64ToBlob decodes to the original bytes', async () => {
  const blob = base64ToBlob(Buffer.from([1, 2, 250]).toString('base64'), 'image/gif');
  assert.equal(blob.type, 'image/gif');
  assert.deepEqual([...new Uint8Array(await blob.arrayBuffer())], [1, 2, 250]);
});
