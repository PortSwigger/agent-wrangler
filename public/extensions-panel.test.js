import { test } from 'node:test';
import assert from 'node:assert/strict';
import { externalRowEl, installedPanelEl, consentBodyEl, updateStatusText, progressText, TRUST_STATEMENT } from './extensions-panel.js';

// A DOM stub rather than jsdom, matching how the rest of public/ stays DOM-free
// (checklist-dom.test.js's). It records innerHTML writes so the "third-party
// strings never reach innerHTML" rule is asserted rather than merely commented.
function stubDocument() {
  const make = (tag) => {
    const el = {
      tagName: tag.toUpperCase(),
      children: [],
      className: '',
      dataset: {},
      attrs: {},
      listeners: {},
      disabled: false,
      value: '',
      _text: null,
      _html: null,
      get childNodes() { return this.children; },
      append(...nodes) { for (const n of nodes) { this.children.push(n); n.parent = el; } },
      appendChild(c) { this.children.push(c); c.parent = el; return c; },
      setAttribute(k, v) { this.attrs[k] = v; },
      getAttribute(k) { return this.attrs[k]; },
      addEventListener(name, fn) { (this.listeners[name] ||= []).push(fn); },
      fire(name, ev = {}) { for (const fn of this.listeners[name] || []) fn(ev); },
      querySelector(sel) {
        const cls = sel.replace('.', '');
        for (const n of walk(el)) if (n !== el && String(n.className).split(' ').includes(cls)) return n;
        return null;
      },
      set textContent(v) { this._text = v; this.children.length = 0; },
      get textContent() { return this._text; },
      set innerHTML(v) { this._html = v; },
      get innerHTML() { return this._html; },
    };
    return el;
  };
  return { createElement: make, createTextNode: (t) => ({ tagName: '#text', children: [], className: '', _text: t, _html: null }) };
}

const walk = (node, out = []) => {
  out.push(node);
  for (const c of node.children || []) walk(c, out);
  return out;
};

const texts = (node) => walk(node).map((n) => n._text).filter((t) => t != null);
const byClass = (node, cls) => walk(node).filter((n) => String(n.className).split(' ').includes(cls));

function withDom(fn) {
  const prior = globalThis.document;
  globalThis.document = stubDocument();
  try { return fn(); } finally { globalThis.document = prior; }
}

const INSTALLED = {
  id: 'notes', label: 'Session notes', external: true,
  description: 'Keeps notes beside a card.', author: 'A Colleague',
  origin: 'https://example.invalid/notes.git', sha: 'abcdef0123456789',
};

test('a settings row renders origin, short SHA, author and description', () => {
  withDom(() => {
    const row = externalRowEl(INSTALLED);
    const all = texts(row);
    assert.ok(all.includes('Session notes'));
    assert.ok(all.includes('A Colleague'));
    assert.ok(all.includes('https://example.invalid/notes.git'));
    assert.ok(all.includes('abcdef01'), 'the SHA is shortened');
    assert.ok(!all.includes('abcdef0123456789'));
    assert.ok(all.includes('Keeps notes beside a card.'));
  });
});

test('a settings row renders the quarantine reason plainly, and only via textContent', () => {
  withDom(() => {
    const row = externalRowEl({ ...INSTALLED, quarantine: 'tool name "list_sessions" is already registered' });
    assert.ok(texts(row).includes('tool name "list_sessions" is already registered'));
    assert.equal(byClass(row, 'ext-row-quarantine')[0].getAttribute('role'), 'status');
    // Every third-party string on this row came off a git URL, so nothing in the
    // rendered subtree may take an innerHTML write.
    for (const node of walk(row)) assert.equal(node._html, null, `${node.className} must not use innerHTML`);
  });
});

test('hostile third-party strings are inert text, not markup', () => {
  withDom(() => {
    const evil = '<img src=x onerror=alert(1)>';
    const row = externalRowEl({ id: 'x', label: evil, description: evil, author: evil, quarantine: evil });
    assert.ok(texts(row).includes(evil));
    for (const node of walk(row)) assert.equal(node._html, null);
  });
});

test('a homepage is a link only when it is https://, otherwise plain text', () => {
  withDom(() => {
    const secure = byClass(externalRowEl({ ...INSTALLED, homepage: 'https://example.invalid/docs' }), 'ext-row-origin');
    assert.ok(secure.some((n) => n.tagName === 'A' && n.href === 'https://example.invalid/docs'));
    for (const bad of ['http://example.invalid', 'javascript:alert(1)', 'data:text/html,x']) {
      const nodes = byClass(externalRowEl({ id: 'x', label: 'X', homepage: bad }), 'ext-row-origin');
      assert.equal(nodes.some((n) => n.tagName === 'A'), false, bad);
      assert.ok(nodes.some((n) => n._text === bad), bad);
    }
  });
});

test('Uninstall and Update are wired per row; Update is offered only with a recorded origin', () => {
  withDom(() => {
    const seen = [];
    const withOrigin = externalRowEl(INSTALLED, { onUninstall: (e) => seen.push(['uninstall', e.id]), onUpdate: (e) => seen.push(['update', e.id]) });
    const buttons = byClass(withOrigin, 'ext-btn');
    assert.deepEqual(buttons.map((b) => b._text), ['Update…', 'Uninstall']);
    buttons[0].fire('click');
    buttons[1].fire('click');
    assert.deepEqual(seen, [['update', 'notes'], ['uninstall', 'notes']]);
    // A hand-dropped extension has no origin to re-clone from, so no Update.
    const handDropped = externalRowEl({ id: 'hand', label: 'Hand dropped' });
    assert.deepEqual(byClass(handDropped, 'ext-btn').map((b) => b._text), ['Uninstall']);
  });
});

test('the panel lists only installed extensions and explains an empty list', () => {
  withDom(() => {
    const empty = installedPanelEl({ entries: [] });
    assert.ok(texts(empty).some((t) => /None yet/.test(t)));
    assert.equal(byClass(empty, 'ext-row').length, 1, 'just the install field');
    // No "Check for updates" with nothing to check.
    assert.equal(texts(empty).includes('Check for updates'), false);
    const full = installedPanelEl({ entries: [INSTALLED] });
    assert.ok(texts(full).includes('Check for updates'));
    assert.equal(byClass(full, 'ext-row').length, 2, 'one row plus the install field');
  });
});

test('the install field submits a trimmed URL on click and on Enter, and never an empty one', () => {
  withDom(() => {
    const urls = [];
    const panel = installedPanelEl({ entries: [], onInstall: (u) => urls.push(u) });
    const input = byClass(panel, 'ext-install-url')[0];
    const go = byClass(panel, 'ext-btn-primary')[0];
    go.fire('click');
    input.value = '  ';
    go.fire('click');
    assert.deepEqual(urls, [], 'an empty URL is not sent');
    input.value = '  https://example.invalid/x.git  ';
    go.fire('click');
    let prevented = 0;
    input.fire('keydown', { key: 'Enter', preventDefault: () => { prevented += 1; } });
    input.fire('keydown', { key: 'a', preventDefault: () => { prevented += 1; } });
    assert.deepEqual(urls, ['https://example.invalid/x.git', 'https://example.invalid/x.git']);
    assert.equal(prevented, 1, 'only Enter is intercepted');
  });
});

test('the install button is disabled while an install is running', () => {
  withDom(() => {
    assert.equal(byClass(installedPanelEl({ busy: true }), 'ext-btn-primary')[0].disabled, true);
    assert.equal(byClass(installedPanelEl({ busy: false }), 'ext-btn-primary')[0].disabled, false);
  });
});

test('the consent modal leads with the trust statement, then capabilities, then dependencies', () => {
  withDom(() => {
    const body = consentBodyEl({
      id: 'notes', label: 'Session notes', description: 'Keeps notes.', author: 'A Colleague',
      sha: 'abcdef0123456789', capabilities: ['tasks:read', 'memory:append'],
      dependencies: ['left@1.0.0'], dependencyCount: 12, update: false,
    });
    const all = texts(body);
    assert.ok(all.includes(TRUST_STATEMENT));
    assert.match(TRUST_STATEMENT, /full access to this machine/);
    assert.match(TRUST_STATEMENT, /disclosure, not a sandbox/);
    assert.ok(all.includes('Install Session notes?'));
    // Order is load-bearing: the trust statement comes before any list.
    assert.ok(all.indexOf(TRUST_STATEMENT) < all.indexOf('Capabilities requested'));
    assert.ok(all.indexOf('Capabilities requested') < all.indexOf('Dependencies'));
    assert.ok(all.includes('tasks:read'));
    assert.ok(all.some((t) => /1 direct, plus 11 further packages/.test(t)));
    // `--ignore-scripts` is stated as a mitigation, never as a boundary.
    assert.ok(all.some((t) => /install scripts disabled/.test(t) && /still runs inside the wrangler/.test(t)));
    for (const node of walk(body)) assert.equal(node._html, null);
  });
});

test('an UPDATE renders capability and dependency DIFFS, not full lists', () => {
  withDom(() => {
    const body = consentBodyEl({
      id: 'notes', label: 'Session notes', update: true, reconsentNeeded: true,
      sha: 'bbbbbbbbbb', priorSha: 'aaaaaaaaaa',
      addedCapabilities: ['sessions:kill'], removedCapabilities: ['memory:read'],
      addedDependencies: ['left@1.0.0'], removedDependencies: ['gone@0.1.0'],
      addedCount: 9, removedCount: 3,
      // Present but irrelevant to an update: the full lists must not be drawn.
      capabilities: ['tasks:read', 'sessions:kill'], dependencies: ['left@1.0.0', 'deep@2.0.0'],
    });
    const all = texts(body);
    assert.ok(all.includes('Update Session notes?'));
    assert.ok(all.includes('Capabilities changed'));
    assert.ok(all.includes('+ sessions:kill'));
    assert.ok(all.includes('− memory:read'));
    assert.equal(all.includes('Capabilities requested'), false, 'the full capability list is not drawn for an update');
    assert.ok(all.includes('Dependencies changed'));
    assert.ok(all.includes('+ left@1.0.0'));
    assert.ok(all.includes('− gone@0.1.0'));
    assert.equal(all.includes('deep@2.0.0'), false, 'an unchanged dependency is not drawn');
    // 9 added and 3 removed, 1 of each listed ⇒ 10 transitive entries hidden.
    assert.ok(all.some((t) => /the 10 not listed are transitive/.test(t)));
    assert.ok(all.includes('was aaaaaaaa'), 'the previous commit is named');
  });
});

test('an update that widens nothing says so rather than showing an empty diff', () => {
  withDom(() => {
    const all = texts(consentBodyEl({ id: 'x', label: 'X', update: true, reconsentNeeded: false, addedCapabilities: [], removedCapabilities: [], addedCount: 0, removedCount: 0 }));
    assert.ok(all.includes('Capabilities unchanged'));
    assert.ok(all.includes('Nothing changed.'));
  });
});

test('updateStatusText distinguishes behind, current, unreachable and provenance-less', () => {
  assert.match(updateStatusText({ updatable: true, sha: 'a'.repeat(40), remoteSha: 'b'.repeat(40), behind: true }), /newer commit is available \(bbbbbbbb\)/);
  assert.equal(updateStatusText({ updatable: true, sha: 'a'.repeat(40), remoteSha: 'a'.repeat(40), behind: false }), 'Up to date.');
  assert.match(updateStatusText({ updatable: true, error: 'host unreachable' }), /Could not reach the origin: host unreachable/);
  assert.match(updateStatusText({ updatable: false }), /placed here by hand/);
  assert.equal(updateStatusText(null), '');
});

test('progress never claims an install happened before consent ran', () => {
  assert.match(progressText('cloning'), /Fetching/);
  assert.match(progressText('resolving'), /manifest and lockfile/);
  for (const phase of ['cloning', 'resolving', 'installing']) {
    assert.doesNotMatch(progressText(phase), /Installed/, phase);
  }
  assert.match(progressText('done', { id: 'notes' }), /Installed notes\. Restart the wrangler to finish\./);
  assert.match(progressText('cancelled'), /Nothing was installed/);
  assert.match(progressText('failed', { message: 'no lockfile' }), /Failed: no lockfile/);
  assert.equal(progressText('disclosed'), '', 'the modal speaks for this phase');
});
