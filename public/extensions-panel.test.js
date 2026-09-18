import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extensionRowEl, extensionSettingRowsEl, extensionsPanelEl, consentBodyEl, updateStatusText, progressText,
  uninstallBodyText, TRANSIENT_PROGRESS_PHASES, TRUST_STATEMENT,
} from './extensions-panel.js';

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
      // Backed by `className` rather than a second list, so byClass() below
      // keeps seeing whatever a toggle has just flipped on itself.
      classList: {
        contains: (c) => String(el.className).split(' ').includes(c),
        add(c) { if (!this.contains(c)) el.className = `${el.className} ${c}`.trim(); },
        remove(c) { el.className = String(el.className).split(' ').filter((x) => x && x !== c).join(' '); },
        toggle(c, on) { if (on ?? !this.contains(c)) this.add(c); else this.remove(c); },
      },
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

test('a settings row renders name, description and origin — and nothing else machine-facing', () => {
  withDom(() => {
    const row = extensionRowEl(INSTALLED);
    const all = texts(row);
    assert.ok(all.includes('Session notes'));
    assert.ok(all.includes('Keeps notes beside a card.'));
    assert.ok(all.includes('https://example.invalid/notes.git'));
    // The commit, the author and any local path were unactionable clutter on a
    // row; the commit survives on the consent modal, where it is a decision.
    assert.equal(all.includes('abcdef01'), false, 'no SHA on the row');
    assert.equal(all.includes('abcdef0123456789'), false);
    assert.equal(all.includes('A Colleague'), false, 'no author on the row');
  });
});

test('every extension is ONE row: the toggle lives with the origin and the actions', () => {
  withDom(() => {
    const row = extensionRowEl({ ...INSTALLED, enabled: true });
    assert.equal(row.dataset.id, 'ext:notes', 'settings.js\'s delegated flip handler finds the def by this id');
    const toggle = byClass(row, 'setting-toggle')[0];
    assert.ok(toggle, 'the row carries the same toggle markup rowHtml builds');
    assert.equal(toggle.getAttribute('aria-checked'), 'true');
    assert.equal(byClass(extensionRowEl({ ...INSTALLED, enabled: false }), 'setting-toggle')[0].getAttribute('aria-checked'), 'false');
  });
});

test('a settings row renders the quarantine reason plainly, and only via textContent', () => {
  withDom(() => {
    const row = extensionRowEl({ ...INSTALLED, quarantine: 'tool name "list_sessions" is already registered' });
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
    const row = extensionRowEl({ id: 'x', label: evil, description: evil, origin: evil, quarantine: evil });
    assert.ok(texts(row).includes(evil));
    for (const node of walk(row)) assert.equal(node._html, null);
  });
});

test('an origin is a link only when it is https://, otherwise plain text', () => {
  withDom(() => {
    const secure = byClass(extensionRowEl({ id: 'x', label: 'X', external: true, origin: 'https://example.invalid/x.git' }), 'ext-row-origin');
    assert.ok(secure.some((n) => n.tagName === 'A' && n.href === 'https://example.invalid/x.git'));
    for (const bad of ['http://example.invalid', 'ssh://git@example.invalid/x.git', 'javascript:alert(1)']) {
      const nodes = byClass(extensionRowEl({ id: 'x', label: 'X', external: true, origin: bad }), 'ext-row-origin');
      assert.equal(nodes.some((n) => n.tagName === 'A'), false, bad);
      assert.ok(nodes.some((n) => n._text === bad), bad);
    }
  });
});

test('Update appears only once a check found a newer commit; Uninstall is external-only', () => {
  withDom(() => {
    const seen = [];
    const opts = { onUninstall: (e) => seen.push(['uninstall', e.id]), onUpdate: (e) => seen.push(['update', e.id]) };
    // No check yet: a standing "Update…" would claim there is one to take.
    assert.deepEqual(byClass(extensionRowEl(INSTALLED, opts), 'ext-btn').map((b) => b._text), ['Uninstall']);
    assert.deepEqual(byClass(extensionRowEl(INSTALLED, { ...opts, status: { updatable: true, sha: 'a', remoteSha: 'b', behind: false } }), 'ext-btn').map((b) => b._text), ['Uninstall']);
    const behind = extensionRowEl(INSTALLED, { ...opts, status: { updatable: true, sha: 'a'.repeat(40), remoteSha: 'b'.repeat(40), behind: true } });
    const buttons = byClass(behind, 'ext-btn');
    assert.deepEqual(buttons.map((b) => b._text), ['Update…', 'Uninstall']);
    buttons[0].fire('click');
    buttons[1].fire('click');
    assert.deepEqual(seen, [['update', 'notes'], ['uninstall', 'notes']]);
    // A builtin cannot be uninstalled or updated — only turned off.
    const builtin = extensionRowEl({ id: 'core', label: 'Core', external: false }, opts);
    assert.deepEqual(byClass(builtin, 'ext-btn').map((b) => b._text), []);
    assert.ok(byClass(builtin, 'setting-toggle')[0]);
  });
});

test('an uninstalled extension says so on its own row, and draws no button of its own', () => {
  withDom(() => {
    const row = extensionRowEl(INSTALLED, { pendingRemoval: true });
    assert.ok(texts(row).some((t) => /Uninstalled/.test(t)));
    assert.ok(texts(row).some((t) => /stays in memory until the wrangler restarts/.test(t)));
    // The restart itself is one button in the panel head — a whole-wrangler
    // action, not a per-extension one, and several pending rows would otherwise
    // each draw the same button.
    assert.equal(byClass(row, 'ext-btn').length, 0);
    // Nothing to toggle, update or uninstall on a row that is already gone.
    assert.equal(byClass(row, 'setting-toggle').length, 0);
  });
});

test('the restart button sits beside Check for updates, and only while something waits on it', () => {
  withDom(() => {
    let restarts = 0;
    const opts = { entries: [INSTALLED], canRestart: true, onRestart: () => { restarts += 1; } };
    // Nothing pending: no button, however restartable the server is.
    assert.equal(byClass(extensionsPanelEl(opts), 'ext-btn-warn').length, 0);
    for (const pending of [{ pendingRemoval: ['notes'] }, { pendingInstall: 'other' }]) {
      const panel = extensionsPanelEl({ ...opts, ...pending });
      const head = byClass(panel, 'ext-installed-head')[0];
      const btn = byClass(head, 'ext-btn-warn')[0];
      assert.ok(btn, `${JSON.stringify(pending)} draws the button in the head`);
      assert.equal(btn._text, 'Restart now');
      btn.fire('click');
    }
    assert.equal(restarts, 2);
    // While it is going down the button says so rather than inviting a second press.
    const going = byClass(extensionsPanelEl({ ...opts, pendingRemoval: ['notes'], restarting: true }), 'ext-btn-warn')[0];
    assert.equal(going._text, 'Restarting…');
    assert.equal(going.disabled, true);
  });
});

test('no restart button where the server cannot restart itself — just the row\'s sentence', () => {
  withDom(() => {
    const panel = extensionsPanelEl({ entries: [INSTALLED], pendingRemoval: ['notes'], canRestart: false });
    assert.ok(texts(panel).some((t) => /stays in memory until the wrangler restarts/.test(t)));
    assert.equal(byClass(panel, 'ext-btn-warn').length, 0);
  });
});

test('the panel is ONE list of builtins and installed extensions alike', () => {
  withDom(() => {
    const empty = extensionsPanelEl({ entries: [] });
    assert.equal(byClass(empty, 'ext-row').length, 1, 'just the install field');
    // Nothing to check against with no recorded origin anywhere.
    assert.equal(texts(empty).includes('Check for updates'), false);
    const full = extensionsPanelEl({ entries: [{ id: 'core', label: 'Core', external: false }, INSTALLED] });
    assert.ok(texts(full).includes('Check for updates'));
    assert.equal(byClass(full, 'ext-row').length, 3, 'a builtin, an installed one, and the install field');
    assert.equal(byClass(full, 'setting-toggle').length, 2, 'both halves of the list carry their own toggle');
  });
});

// -- setting rows ----------------------------------------------------------
const WITH_SETTINGS = {
  ...INSTALLED,
  settings: [
    { key: 'registryUrl', type: 'text', label: 'Registry URL', help: 'Where handles are published.', placeholder: 'https://…' },
    { key: 'pollMs', type: 'number', label: 'Poll interval' },
    { key: 'auto', type: 'toggle', label: 'Auto-deliver' },
  ],
  settingValues: { registryUrl: 'https://reg.invalid', pollMs: 30, auto: true },
};

test('an extension\'s settings are drawn beneath its own row, one row per declared setting', () => {
  withDom(() => {
    const panel = extensionsPanelEl({ entries: [{ id: 'core', label: 'Core' }, WITH_SETTINGS] });
    const rows = byClass(panel, 'ext-setting-row');
    assert.deepEqual(rows.map((r) => r.dataset.key), ['registryUrl', 'pollMs', 'auto']);
    const all = texts(panel);
    assert.ok(all.includes('Registry URL'));
    assert.ok(all.includes('Where handles are published.'));
    // An extension with none draws no wrapper at all.
    assert.equal(byClass(extensionsPanelEl({ entries: [{ id: 'core', label: 'Core' }] }), 'ext-settings').length, 0);
  });
});

test('a setting row carries data-ext/data-key and NO data-id — the collision guard', () => {
  withDom(() => {
    for (const row of byClass(extensionSettingRowsEl(WITH_SETTINGS), 'ext-setting-row')) {
      assert.equal(row.dataset.ext, 'notes');
      // settings.js's delegated handler looks a row up by `byId.get(dataset.id)`
      // and bails on a miss. `ext:notes` here would make a toggle-type SETTING
      // flip the EXTENSION's enable flag instead.
      assert.equal(row.dataset.id, undefined);
    }
  });
});

test('every third-party string on a setting row is text, never markup', () => {
  withDom(() => {
    const evil = '<img src=x onerror=alert(1)>';
    const wrap = extensionSettingRowsEl({
      id: 'x', settings: [{ key: 'k', type: 'text', label: evil, help: evil, placeholder: evil }], settingValues: {},
    });
    assert.ok(texts(wrap).includes(evil));
    const input = byClass(wrap, 'ext-setting-input')[0];
    assert.equal(input.placeholder, evil, 'a property assignment, not markup');
    for (const node of walk(wrap)) assert.equal(node._html, null, `${node.className} must not use innerHTML`);
  });
});

test('a value is shown in its own control, and a quarantined extension\'s controls are disabled', () => {
  withDom(() => {
    const live = extensionSettingRowsEl(WITH_SETTINGS);
    const inputs = byClass(live, 'ext-setting-input');
    assert.deepEqual(inputs.map((i) => [i.type, i.value, i.disabled]), [['text', 'https://reg.invalid', false], ['number', '30', false]]);
    assert.equal(byClass(live, 'setting-toggle')[0].getAttribute('aria-checked'), 'true');
    assert.equal(byClass(live, 'setting-toggle')[0].disabled, false);
    // An unset value is an empty field, not the string "undefined".
    assert.equal(byClass(extensionSettingRowsEl({ ...WITH_SETTINGS, settingValues: {} }), 'ext-setting-input')[0].value, '');

    // Quarantined: it is contributing nothing and could not read the value
    // back, so there is nothing to store a choice against. Merely toggled OFF
    // is deliberately NOT disabled — a value is config and persists.
    const dead = extensionSettingRowsEl({ ...WITH_SETTINGS, quarantine: 'store factory threw' });
    assert.deepEqual(byClass(dead, 'ext-setting-input').map((i) => i.disabled), [true, true]);
    assert.equal(byClass(dead, 'setting-toggle')[0].disabled, true);
    const off = extensionSettingRowsEl({ ...WITH_SETTINGS, enabled: false });
    assert.deepEqual(byClass(off, 'ext-setting-input').map((i) => i.disabled), [false, false]);
  });
});

test('a text field commits on change and on Enter, once, and never per keystroke', () => {
  withDom(() => {
    const seen = [];
    const wrap = extensionSettingRowsEl(WITH_SETTINGS, { onSettingChange: (c) => seen.push(c) });
    const [url, poll] = byClass(wrap, 'ext-setting-input');
    // Typing alone writes nothing: a control frame and a config.json write per
    // character is not a thing to ship.
    url.fire('keydown', { key: 'a' });
    assert.deepEqual(seen, []);
    url.value = 'https://other.invalid';
    url.fire('change');
    assert.deepEqual(seen, [{ id: 'notes', key: 'registryUrl', value: 'https://other.invalid' }]);
    // The browser fires `change` for Enter as well, so a re-commit of the same
    // value — and a blur that changed nothing — must not send a second frame.
    url.fire('keydown', { key: 'Enter' });
    url.fire('change');
    assert.equal(seen.length, 1);
    poll.value = '';
    poll.fire('keydown', { key: 'Enter' });
    assert.deepEqual(seen.at(-1), { id: 'notes', key: 'pollMs', value: null }, 'an empty number field clears the value');
    poll.value = '90';
    poll.fire('change');
    assert.deepEqual(seen.at(-1), { id: 'notes', key: 'pollMs', value: 90 });
    byClass(wrap, 'setting-toggle')[0].fire('click');
    assert.deepEqual(seen.at(-1), { id: 'notes', key: 'auto', value: false }, 'the toggle sends the opposite of what it shows');
  });
});

test('a toggle setting moves its own switch, and a second click sends the other value', () => {
  withDom(() => {
    const seen = [];
    const wrap = extensionSettingRowsEl(WITH_SETTINGS, { onSettingChange: (c) => seen.push(c) });
    const toggle = byClass(wrap, 'setting-toggle')[0];
    // These rows are only rebuilt on a remount, and app.js's remount signature
    // excludes settingValues on purpose — so nothing else is coming to redraw
    // this. An input keeps the typed text because the browser holds it; a
    // switch that does not move itself reads as a click that did nothing.
    assert.equal(toggle.getAttribute('aria-checked'), 'true');
    toggle.fire('click');
    assert.equal(toggle.getAttribute('aria-checked'), 'false');
    assert.ok(!/\bon\b/.test(toggle.className));
    toggle.fire('click');
    assert.equal(toggle.getAttribute('aria-checked'), 'true');
    assert.ok(/\bon\b/.test(toggle.className));
    // Captured once, the second click would have re-sent the first's value.
    assert.deepEqual(seen.map((c) => c.value), [false, true]);
  });
});

test('a quarantined control sends nothing even if something manages to click it', () => {
  withDom(() => {
    const seen = [];
    const wrap = extensionSettingRowsEl({ ...WITH_SETTINGS, quarantine: 'broken' }, { onSettingChange: (c) => seen.push(c) });
    byClass(wrap, 'setting-toggle')[0].fire('click');
    assert.deepEqual(seen, []);
  });
});

test('checking for updates says so while it runs, on the button and on each row', () => {
  withDom(() => {
    const panel = extensionsPanelEl({ entries: [INSTALLED], checking: true });
    const check = byClass(panel, 'ext-btn').find((b) => /Check/.test(b._text));
    assert.equal(check._text, 'Checking…');
    assert.equal(check.disabled, true);
    assert.ok(texts(panel).includes('Checking…'));
  });
});

test('a finished install says so on the install form — it has no row until the restart', () => {
  withDom(() => {
    const panel = extensionsPanelEl({
      entries: [], pendingInstall: 'notes', progress: 'Installed notes. Restart the wrangler to finish.',
      canRestart: true,
    });
    assert.ok(texts(panel).includes('Installed notes. Restart the wrangler to finish.'));
  });
});

test('the install field submits a trimmed URL on click and on Enter, and never an empty one', () => {
  withDom(() => {
    const urls = [];
    const panel = extensionsPanelEl({ entries: [], onInstall: (u) => urls.push(u) });
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
    assert.equal(byClass(extensionsPanelEl({ busy: true }), 'ext-btn-primary')[0].disabled, true);
    assert.equal(byClass(extensionsPanelEl({ busy: false }), 'ext-btn-primary')[0].disabled, false);
  });
});

test('the uninstall confirmation promises no data retention and only claims live code when it is live', () => {
  // On and healthy is running RIGHT NOW — the registry is live, so there is no
  // boot snapshot left to consult.
  const live = uninstallBodyText({ ...INSTALLED, enabled: true });
  assert.match(live, /files are removed/);
  assert.match(live, /keeps running until the wrangler restarts/);
  assert.doesNotMatch(live, /reinstalling picks it back up/);
  // Turned off or quarantined: there is no running code for a restart to clear,
  // and saying there is was simply wrong.
  for (const off of [{ enabled: false }, { enabled: true, quarantine: 'bad manifest' }]) {
    const text = uninstallBodyText({ ...INSTALLED, ...off });
    assert.doesNotMatch(text, /keeps running/, JSON.stringify(off));
    assert.match(text, /not running/);
  }
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
  // A live install is finished; only an update of an already-registered id
  // still waits on a restart, and that is what carries `restartRequired`.
  assert.match(progressText('done', { id: 'notes' }), /Installed notes and live\./);
  assert.match(progressText('done', { id: 'notes' }), /pick up its tools when they next resume/);
  assert.doesNotMatch(progressText('done', { id: 'notes' }), /Restart/);
  assert.match(progressText('done', { id: 'notes', restartRequired: true }), /Installed notes\. Restart the wrangler to finish\./);
  assert.match(progressText('cancelled'), /Nothing was installed/);
  assert.match(progressText('failed', { message: 'no lockfile' }), /Failed: no lockfile/);
  assert.equal(progressText('disclosed'), '', 'the modal speaks for this phase');
});

test('a settled report fades, but anything still awaiting action does not', () => {
  // "Cancelled." and "Failed." describe a moment that has passed — and so now
  // does a finished install, in both paths: the update path's restart affordance
  // rides `pendingInstall`, not this phase, so fading the line loses nothing.
  assert.deepEqual([...TRANSIENT_PROGRESS_PHASES].sort(), ['cancelled', 'done', 'failed']);
  assert.equal(TRANSIENT_PROGRESS_PHASES.has('done'), true);
  assert.equal(updateStatusText({ checking: true }), 'Checking…');
});
