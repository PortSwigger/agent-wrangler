import { test } from 'node:test';
import assert from 'node:assert/strict';

// Just enough DOM for the panel: properties it sets directly, listeners it
// adds, and a class-name querySelector.
function mkEl(tag) {
  const listeners = {};
  const el = {
    tagName: tag.toUpperCase(), children: [], dataset: {}, attrs: {}, className: '', textContent: '', title: '', value: '',
    type: '', placeholder: '', maxLength: 0, min: '', max: '', step: '', disabled: false, readOnly: false, checked: false,
    spellcheck: true, ariaLabel: '', role: '', isConnected: true, parentNode: null, focused: false,
    setAttribute(k, v) { this.attrs[k] = v; },
    append(...c) { for (const x of c.filter(Boolean)) { if (typeof x === 'object') x.parentNode = this; this.children.push(x); } },
    replaceChildren(...c) { this.children = []; this.append(...c); },
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    fire(type, ev = {}) { for (const fn of listeners[type] || []) fn({ preventDefault() {}, ...ev }); },
    focus() { this.focused = true; },
    select() {},
    querySelector(sel) { return walk(this).slice(1).find((e) => matches(e, sel)) || null; },
    querySelectorAll(sel) { return walk(this).slice(1).filter((e) => matches(e, sel)); },
  };
  return el;
}
const matches = (e, sel) => (sel.startsWith('.') ? String(e.className).split(/\s+/).includes(sel.slice(1)) : e.tagName === sel.toUpperCase());
const walk = (el, out = []) => { out.push(el); for (const c of el.children || []) if (typeof c === 'object') walk(c, out); return out; };
globalThis.document = { createElement: mkEl };

const { mountOutsideClientsPanel, expiryText, lastUseText } = await import('./outside-clients-panel.js');

const DAY = 24 * 60 * 60 * 1000;
const SCOPES = [
  { key: 'jobs:jobs', extId: 'jobs', extension: 'Jobs', label: 'Jobs', description: 'Create and read jobs.', exclusive: false, tools: ['list_jobs', 'create_job'] },
  { key: 'jobs:human', extId: 'jobs', extension: 'Jobs', label: 'Human', description: '', exclusive: true, tools: ['list_jobs', 'press'] },
];
const state = (clients = []) => ({ clients, scopes: SCOPES, endpoint: { url: 'http://127.0.0.1:7880/mcp', host: '127.0.0.1', loopback: true } });
const flush = () => new Promise((r) => setTimeout(r, 0));
const texts = (root) => walk(root).map((e) => e.textContent).filter(Boolean);

function bridge(initial) {
  const calls = [];
  let current = initial;
  return {
    calls,
    copied: [],
    act(action, args) {
      calls.push([action, args]);
      if (action === 'admin.outside-clients') return Promise.resolve({ ok: true, data: current });
      if (action === 'admin.outside-client-mint') {
        if (!args.name) return Promise.resolve({ ok: false, error: { code: 'invalid', message: 'Give the client a name' } });
        const minted = { id: 'c_new', name: args.name, scopes: args.scopes, createdAt: Date.now(), expiresAt: Date.now() + args.days * DAY, expired: false, lastUsedAt: null, lastTool: null };
        current = state([...current.clients, minted]);
        return Promise.resolve({ ok: true, data: { ...current, minted, token: 'awc_SECRET' } });
      }
      if (action === 'admin.outside-client-revoke') {
        current = state(current.clients.filter((c) => c.id !== args.id));
        return Promise.resolve({ ok: true, data: current });
      }
      return Promise.resolve({ ok: false, error: { code: 'unsupported' } });
    },
    copy(text) { this.copied.push(text); return Promise.resolve(); },
  };
}

test('expiry and last-use lines', () => {
  const now = Date.now();
  assert.equal(expiryText({ expiresAt: now + 29.5 * DAY }, now), 'Expires in 30 days');
  assert.equal(expiryText({ expiresAt: now + 3600_000 }, now), 'Expires within a day');
  assert.equal(expiryText({ expiresAt: now - 1, expired: true }, now), 'Expired');
  assert.equal(lastUseText({ lastUsedAt: null }), 'Never used');
  assert.match(lastUseText({ lastUsedAt: now - 5 * 60_000, lastTool: 'list_jobs' }), /^Last used .+ · list_jobs$/);
});

test('mints a named client with picked scopes and expiry, shows its token once, then Done hides it', async () => {
  const root = mkEl('div');
  const b = bridge(state());
  mountOutsideClientsPanel(root, b);
  await flush();
  assert.ok(texts(root).includes('No outside clients.'));
  assert.ok(texts(root).includes('Jobs · Human (one client at a time)'));
  root.querySelector('.oc-new-name').value = 'jobs-bot';
  root.querySelector('.oc-new-days').value = '7';
  const boxes = root.querySelectorAll('input').filter((e) => e.type === 'checkbox');
  assert.deepEqual(boxes.map((x) => x.value), ['jobs:jobs', 'jobs:human']);
  boxes[0].checked = true;
  root.querySelector('.oc-mint').fire('click');
  await flush();
  assert.deepEqual(b.calls.at(-1), ['admin.outside-client-mint', { name: 'jobs-bot', scopes: ['jobs:jobs'], days: 7 }]);
  const token = root.querySelector('.oc-token-value');
  assert.equal(token.value, 'awc_SECRET');
  assert.equal(token.readOnly, true);
  assert.equal(token.focused, true);
  assert.ok(texts(root).some((t) => t.includes('shown once') && t.includes('http://127.0.0.1:7880/mcp')));
  const row = root.querySelector('.oc-row');
  assert.equal(row.querySelector('.oc-name').textContent, 'jobs-bot');
  assert.equal(row.querySelector('.oc-meta').textContent, 'Expires in 7 days · Never used');
  const [copy, done] = root.querySelector('.oc-token-row').children.slice(1);
  copy.fire('click');
  await flush();
  assert.deepEqual(b.copied, ['awc_SECRET']);
  done.fire('click');
  assert.equal(root.querySelector('.oc-token'), null, 'the token is gone once dismissed');
  assert.equal(JSON.stringify(texts(root)).includes('awc_SECRET'), false);
});

test('a refused mint shows the deck\'s sentence and keeps the form', async () => {
  const root = mkEl('div');
  mountOutsideClientsPanel(root, bridge(state()));
  await flush();
  root.querySelector('.oc-mint').fire('click');
  await flush();
  assert.equal(root.querySelector('.oc-error').textContent, 'Give the client a name');
  assert.equal(root.querySelector('.oc-mint').disabled, false);
});

test('Revoke is one click and redraws without the client', async () => {
  const root = mkEl('div');
  const now = Date.now();
  const b = bridge(state([{ id: 'c_1', name: 'desk', scopes: ['jobs:human', 'gone:x'], createdAt: now, expiresAt: now + 10 * DAY, expired: false, lastUsedAt: now - 60_000, lastTool: 'press' }]));
  mountOutsideClientsPanel(root, b);
  await flush();
  const chips = root.querySelectorAll('.oc-scope');
  assert.deepEqual(chips.map((c) => [c.textContent, c.className]), [['Jobs · Human', 'oc-scope'], ['gone:x', 'oc-scope gone']]);
  root.querySelector('.oc-revoke').fire('click');
  await flush();
  assert.deepEqual(b.calls.at(-1), ['admin.outside-client-revoke', { id: 'c_1' }]);
  assert.equal(root.querySelector('.oc-row'), null);
  assert.ok(texts(root).includes('No outside clients.'));
});

test('a session API bound beyond loopback is called out; a deck without the actions says so', async () => {
  const root = mkEl('div');
  mountOutsideClientsPanel(root, bridge({ ...state(), endpoint: { url: 'http://127.0.0.1:7880/mcp', host: '0.0.0.0', loopback: false } }));
  await flush();
  assert.match(root.querySelector('.oc-warning').textContent, /bound to 0\.0\.0\.0, beyond loopback, so every client token is refused/);
  const old = mkEl('div');
  mountOutsideClientsPanel(old, { act: () => Promise.resolve({ ok: false, error: { code: 'unsupported' } }) });
  await flush();
  assert.ok(texts(old).includes('This deck does not offer outside MCP clients.'));
});
