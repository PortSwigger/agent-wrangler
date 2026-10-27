import { test } from 'node:test';
import assert from 'node:assert/strict';
import extension from './index.js';
import { createSlots } from '../../../../../public/slots.js';

function dom() {
  const doc = { createElement(tag) {
    const el = { tagName: tag.toUpperCase(), ownerDocument: doc, children: [], dataset: {}, value: '', className: '', _text: '', listeners: {},
      appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
      append(...cs) { cs.forEach((c) => this.appendChild(c)); },
      replaceChildren(...cs) { this.children = []; this._text = ''; this.append(...cs); },
      removeChild(c) { this.children.splice(this.children.indexOf(c), 1); c.parentNode = null; },
      addEventListener(name, cb) { this.listeners[name] = cb; },
      setAttribute(name, value) { this[name] = value; },
      set textContent(v) { this._text = v; this.children = []; },
      get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); },
    }; return el;
  } }; return doc;
}
const graph = { logins: { logins: [{ slug: 'personal', label: 'Personal', claude: { present: true, capturedAt: Date.now() - 350 * 86400000 }, codex: { present: false, email: null } }], sessions: { mapped: 'personal' } } };
function setup() {
  const document = dom(); const sent = []; const contributions = {};
  const api = { send: (msg) => sent.push(msg), runtimes: () => [{ id: 'cloud', label: 'Cloud', ownLaunch: true }] };
  extension.register({ api, register: (slot, c) => { contributions[slot] = c; } });
  return { document, sent, api, contributions, make: () => document.createElement('div') };
}
const ctx = { draft: { model: 'codex-model' }, agents: [{ id: 'codex', models: [{ value: 'codex-model' }] }] };
function walk(el, predicate) { return predicate(el) ? el : el.children.map((c) => walk(c, predicate)).find(Boolean); }

test('Login field lists Default, reads selection, blocks provider/runtime, resets, and retains removed selection', () => {
  const { make, api, contributions } = setup(); const el = make(); const c = contributions['dispatch.field'];
  c.mount(el, api); c.update(el, ctx, graph);
  const select = walk(el, (e) => e.tagName === 'SELECT');
  assert.deepEqual(select.children.map((o) => o.textContent), ['Default', 'Personal']);
  select.value = 'personal'; select.listeners.change();
  assert.deepEqual(c.ext(el), { login: 'personal' });
  assert.equal(c.validate(el, ctx), '"Personal" has no Codex login');
  assert.ok(el.textContent.includes('"Personal" has no Codex login'));
  assert.equal(c.validate(el, { draft: { agent: 'claude', runtime: 'cloud' } }), '"Personal" cannot be used with runtime "Cloud"');
  c.update(el, { draft: { agent: 'claude' } }, { logins: { logins: [], sessions: {} } });
  assert.match(c.validate(el, { draft: { agent: 'claude' } }), /no longer exists/);
  c.open(el); assert.equal(select.value, ''); assert.deepEqual(c.ext(el), { login: null });
});

test('api.dispatchFields.mount hosts the real Login field independently and returns the same validation and bag', () => {
  const { document, api, make } = setup(); const errors = [];
  const slots = createSlots({ document, storage: null, onError: (e) => errors.push(e) });
  extension.register(slots.forExtension('logins', api));
  const board = make(); slots.syncHosts('dispatch.field', [{ host: board, at: 'model' }], api);
  slots.update('dispatch.field', ctx, graph);
  const root = make(); const jobCtx = { mode: 'job', draft: { agent: 'codex' } };
  const handle = slots.forExtension('launcher', api).api.dispatchFields.mount(root, jobCtx);
  handle.update(jobCtx, graph);
  walk(root, (e) => e.tagName === 'SELECT').value = 'personal';
  assert.equal(handle.validate(), '"Personal" has no Codex login');
  assert.deepEqual(handle.read(), { ext: { logins: { login: 'personal' } } });
  assert.equal(walk(board, (e) => e.tagName === 'SELECT').value, '');
  handle.unmount(); assert.equal(root.children.length, 0);
  assert.deepEqual(errors, []);
});

test('pill draws mapped and removed labels; panel offers management and expiry with no token text', () => {
  const { make, api, sent, contributions } = setup(); const pill = make();
  contributions['card.pill'].mount(pill, api);
  contributions['card.pill'].update(pill, { sessionId: 'mapped' }, graph);
  assert.equal(pill.textContent, 'Personal');
  contributions['card.pill'].update(pill, { sessionId: 'default' }, graph);
  assert.equal(pill.textContent, '');
  const panel = make(); contributions['settings.panel'].mount(panel, api); contributions['settings.panel'].update(panel, null, graph);
  assert.ok(panel.textContent.includes('expires soon'));
  const input = walk(panel, (e) => e.placeholder === 'Login name'); input.value = 'Another';
  walk(panel, (e) => e.tagName === 'BUTTON' && e.textContent === 'Add login').listeners.click();
  assert.deepEqual(sent.at(-1), { type: 'logins-add', label: 'Another' });
});
