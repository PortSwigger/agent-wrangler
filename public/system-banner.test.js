import { test } from 'node:test';
import assert from 'node:assert/strict';
import { showSystemBanner, hideSystemBanner } from './system-banner.js';

// Minimal DOM + localStorage stubs, matching how the rest of public/ stays
// jsdom-free. Only what the banner touches.
function stubEnv() {
  const banner = {
    className: 'hidden', _text: null, children: [], listeners: {},
    set textContent(v) { this._text = v; this.children.length = 0; },
    get textContent() { return this._text; },
    append(...n) { this.children.push(...n); },
    classList: {
      set: new Set(['hidden']),
      add(c) { this.set.add(c); },
      remove(c) { this.set.delete(c); },
      contains(c) { return this.set.has(c); },
    },
  };
  const body = { classList: { set: new Set(), add(c) { this.set.add(c); }, remove(c) { this.set.delete(c); } } };
  globalThis.document = {
    getElementById: (id) => (id === 'system-banner' ? banner : null),
    createElement: () => ({
      className: '', _text: null, children: [], listeners: {},
      set textContent(v) { this._text = v; }, get textContent() { return this._text; },
      append(...n) { this.children.push(...n); },
      addEventListener(name, fn) { (this.listeners[name] ||= []).push(fn); },
      fire(name) { for (const fn of this.listeners[name] || []) fn(); },
    }),
    body,
  };
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
  };
  return { banner, store, visible: () => !banner.classList.contains('hidden') };
}

function dismiss(banner) {
  const btn = banner.children.find((c) => c.className === 'system-banner-dismiss');
  assert.ok(btn, 'the dismiss control is only offered when a level is given');
  btn.fire('click');
}

test('a dismissal is scoped to its producer — dismissing fd does not suppress heap', () => {
  const env = stubEnv();
  showSystemBanner('fd climbing', { level: 250, kind: 'fd' });
  dismiss(env.banner);
  hideSystemBanner();

  // Same NUMBER, different producer: fd counts descriptors and heap counts
  // percentages, so a shared bare level would silently swallow this.
  showSystemBanner('heap at 250%', { level: 250, kind: 'heap' });
  assert.equal(env.visible(), true);
  hideSystemBanner();
  // And the fd dismissal still holds for fd, at or below the level dismissed.
  showSystemBanner('fd climbing', { level: 200, kind: 'fd' });
  assert.equal(env.visible(), false);
  showSystemBanner('fd worse', { level: 300, kind: 'fd' });
  assert.equal(env.visible(), true, 'a worsening leak always breaks back through');
});

test('a legacy bare dismissal is honoured as the fd one it was, and survives a later write', () => {
  const env = stubEnv();
  env.store.set('aw-system-banner-dismiss', JSON.stringify({ level: 300, until: Date.now() + 60000 }));
  showSystemBanner('fd climbing', { level: 250, kind: 'fd' });
  assert.equal(env.visible(), false, 'the pre-namespace dismissal is not silently discarded');
  showSystemBanner('heap', { level: 75, kind: 'heap' });
  assert.equal(env.visible(), true);
  dismiss(env.banner);
  const stored = JSON.parse(env.store.get('aw-system-banner-dismiss'));
  assert.equal(stored.fd.level, 300, 'the legacy value is carried across under its own kind');
  assert.equal(stored.heap.level, 75);
});

test('an alert with no level offers no dismiss control and is never suppressed', () => {
  const env = stubEnv();
  env.store.set('aw-system-banner-dismiss', JSON.stringify({ fd: { level: 999, until: Date.now() + 60000 } }));
  // The quarantined-builtin banner's case: a repo bug must stay visible.
  showSystemBanner('⚠ Built-in extensions quarantined at startup (notes)');
  assert.equal(env.visible(), true);
  assert.equal(env.banner.children.some((c) => c.className === 'system-banner-dismiss'), false);
});
