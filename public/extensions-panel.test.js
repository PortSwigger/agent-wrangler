import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extensionSettingRowsEl, extensionsPanelEl, consentBodyEl, updateStatusText, progressText,
  uninstallBodyText, TRANSIENT_PROGRESS_PHASES, TRUST_STATEMENT,
  commitFocusedField, MAX_TEXTAREA_LENGTH, BROWSE_NOTICE, normalizeRepoUrl, updatedAgoText,
} from './extensions-panel.js';
import { MAX_TEXTAREA_LENGTH as SERVER_MAX_TEXTAREA_LENGTH } from '../server/extensions/setting-constraints.js';

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
      // Native validation, stubbed: the gate's LOGIC is what these tests are
      // about, not the browser's own rule engine. Valid by default; a test sets
      // `_valid` false and reads `validationMessage` back off the error span.
      _valid: true,
      validationMessage: '',
      checkValidity() { return this._valid; },
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

const BUILTIN_A = { id: 'a', label: 'Alpha', external: false, enabled: true };
const BUILTIN_B = { id: 'b', label: 'Beta' };
const EXT1 = { ...INSTALLED, id: 'ext1', label: 'One', enabled: true };
const EXT2 = { ...INSTALLED, id: 'ext2', label: 'Two' };
const BEHIND = { updatable: true, sha: 'a'.repeat(40), remoteSha: 'b'.repeat(40), behind: true };
const listIds = (node) => byClass(node, 'ext-list-row').map((r) => r.dataset.extId);
const groupTitles = (node) => byClass(node, 'ext-group-title').map((n) => n._text);
const detailOf = (node) => byClass(node, 'ext-detail')[0];
const buttonTexts = (node) => byClass(node, 'ext-btn').map((b) => b._text || texts(b).join(''));
// The only innerHTML the panel writes is a static icon from icons.js.
const assertNoThirdPartyHtml = (node) => {
  for (const n of walk(node)) assert.ok(n._html == null || n._html.startsWith('<svg'), `${n.className} must not take markup`);
};

test('the list pane: filter, Core then Installed groups, Add extension at the bottom', () => {
  withDom(() => {
    const panel = extensionsPanelEl({ entries: [BUILTIN_A, EXT1, BUILTIN_B, EXT2] });
    const list = byClass(panel, 'ext-list')[0];
    assert.equal(list.children[0].className, 'ext-filter');
    assert.equal(list.children[list.children.length - 1]._text, '+ Add extension');
    assert.deepEqual(groupTitles(panel), ['Core', 'Installed']);
    assert.deepEqual(listIds(panel), ['a', 'b', 'ext1', 'ext2'], 'grouped by external, order kept within each');
  });
});

test('an empty Core group is omitted; an empty Installed group says so', () => {
  withDom(() => {
    assert.deepEqual(groupTitles(extensionsPanelEl({ entries: [INSTALLED] })), ['Installed']);
    const none = extensionsPanelEl({ entries: [BUILTIN_A] });
    assert.ok(texts(none).includes('No extensions installed yet.'));
    assert.equal(texts(extensionsPanelEl({ entries: [BUILTIN_A, INSTALLED] })).includes('No extensions installed yet.'), false);
  });
});

test('a list item shows a filled dot when enabled, hollow and muted when not', () => {
  withDom(() => {
    const [on, off] = byClass(extensionsPanelEl({ entries: [EXT1, EXT2] }), 'ext-list-row');
    assert.ok(byClass(on, 'ext-dot')[0].classList.contains('on'));
    assert.equal(on.classList.contains('off'), false);
    assert.equal(byClass(off, 'ext-dot')[0].classList.contains('on'), false);
    assert.ok(off.classList.contains('off'));
    // A quarantined one is not running, whatever its flag says.
    const q = byClass(extensionsPanelEl({ entries: [{ ...EXT1, quarantine: 'broken' }] }), 'ext-list-row')[0];
    assert.ok(q.classList.contains('off'));
  });
});

test('the selected extension is highlighted and shown; clicking another selects it', () => {
  withDom(() => {
    const picked = [];
    const panel = extensionsPanelEl({ entries: [BUILTIN_A, EXT1], selectedId: 'ext1', onSelect: (id) => picked.push(id) });
    const rows = byClass(panel, 'ext-list-row');
    assert.deepEqual(rows.map((r) => r.classList.contains('selected')), [false, true]);
    assert.ok(texts(detailOf(panel)).includes('One'));
    byClass(rows[0], 'ext-list-item')[0].fire('click');
    assert.deepEqual(picked, ['a']);
    // Nothing (or something gone) selected falls back to the first entry.
    const fallback = extensionsPanelEl({ entries: [BUILTIN_A, EXT1], selectedId: 'gone' });
    assert.ok(byClass(fallback, 'ext-list-row')[0].classList.contains('selected'));
  });
});

test('the filter hides non-matching items in place and reports the text', () => {
  withDom(() => {
    const seen = [];
    const panel = extensionsPanelEl({ entries: [BUILTIN_A, EXT1, EXT2], filter: 'tw', onFilter: (t) => seen.push(t) });
    const visible = () => byClass(panel, 'ext-list-row').filter((r) => !r.hidden).map((r) => r.dataset.extId);
    assert.deepEqual(visible(), ['ext2'], 'the filter survives a remount');
    const input = byClass(panel, 'ext-filter')[0];
    input.value = 'ALP';
    input.fire('input');
    assert.deepEqual(visible(), ['a'], 'case-insensitive');
    assert.deepEqual(seen, ['ALP']);
  });
});

test('Check all is in the Installed head, only with an origin to check, and says so while it runs', () => {
  withDom(() => {
    let checks = 0;
    assert.equal(byClass(extensionsPanelEl({ entries: [BUILTIN_A] }), 'ext-group-head').some((h) => byClass(h, 'ext-btn').length), false);
    const panel = extensionsPanelEl({ entries: [BUILTIN_A, INSTALLED], onCheckUpdates: () => { checks += 1; } });
    const [coreHead, installedHead] = byClass(panel, 'ext-group-head');
    assert.equal(byClass(coreHead, 'ext-btn').length, 0);
    assert.deepEqual(buttonTexts(installedHead), ['Check all']);
    byClass(installedHead, 'ext-btn')[0].fire('click');
    assert.equal(checks, 1);
    const check = byClass(byClass(extensionsPanelEl({ entries: [INSTALLED], checking: true }), 'ext-group-head')[0], 'ext-btn')[0];
    assert.ok(texts(check).includes('Checking…'));
    assert.equal(check.disabled, true);
  });
});

test('Update all and a per-item update button appear only once a check found a newer commit', () => {
  withDom(() => {
    const seen = [];
    const opts = { entries: [BUILTIN_A, EXT1, EXT2], onUpdate: (e) => seen.push(['one', e.id]), onUpdateAll: (es) => seen.push(['all', es.map((e) => e.id)]) };
    const before = extensionsPanelEl(opts);
    assert.deepEqual(buttonTexts(byClass(before, 'ext-group-head')[1]), ['Check all']);
    assert.equal(byClass(before, 'ext-btn-square').length, 0);
    const after = extensionsPanelEl({ ...opts, statuses: { ext2: BEHIND, ext1: { ...BEHIND, behind: false } } });
    const head = byClass(after, 'ext-group-head')[1];
    assert.deepEqual(buttonTexts(head), ['Update all', 'Check all'], 'Update all comes first');
    const [square] = byClass(after, 'ext-btn-square');
    assert.equal(square.getAttribute('aria-label'), 'Update Two');
    assert.equal(byClass(after, 'ext-list-row').find((r) => r.dataset.extId === 'ext2').children.includes(square), true);
    square.fire('click');
    byClass(head, 'ext-btn')[0].fire('click');
    assert.deepEqual(seen, [['one', 'ext2'], ['all', ['ext2']]]);
    // A pending removal is past updating.
    assert.equal(byClass(extensionsPanelEl({ ...opts, statuses: { ext2: BEHIND }, pendingRemoval: ['ext2'] }), 'ext-btn-square').length, 0);
  });
});

test('the detail header: name, description, the enable toggle settings.js drives, and Uninstall for external only', () => {
  withDom(() => {
    const removed = [];
    const panel = extensionsPanelEl({ entries: [EXT1], onUninstall: (e) => removed.push(e.id) });
    const head = byClass(panel, 'ext-detail-head')[0];
    assert.equal(head.dataset.id, 'ext:ext1', 'settings.js\'s delegated flip handler finds the def by this id');
    assert.ok(head.classList.contains('setting-row'));
    assert.ok(texts(head).includes('Keeps notes beside a card.'));
    assert.equal(byClass(head, 'setting-toggle')[0].getAttribute('aria-checked'), 'true');
    const uninstall = byClass(head, 'ext-btn-danger')[0];
    assert.equal(uninstall._text, 'Uninstall…');
    uninstall.fire('click');
    assert.deepEqual(removed, ['ext1']);
    const core = byClass(extensionsPanelEl({ entries: [BUILTIN_A] }), 'ext-detail-head')[0];
    assert.equal(byClass(core, 'ext-btn-danger').length, 0);
    assert.ok(byClass(core, 'setting-toggle')[0]);
  });
});

test('the Source section: type, repository with an https-only Open link, and short commit', () => {
  withDom(() => {
    const detail = detailOf(extensionsPanelEl({ entries: [INSTALLED] }));
    const all = texts(detail);
    for (const t of ['Source', 'Type', 'Installed from git', 'Repository', 'https://example.invalid/notes.git', 'Commit', 'abcdef01']) assert.ok(all.includes(t), t);
    assert.equal(all.includes('A Colleague'), false, 'no author');
    const open = byClass(detail, 'ext-kv-open')[0];
    assert.equal(open.href, 'https://example.invalid/notes.git');
    for (const bad of ['http://example.invalid', 'ssh://git@example.invalid/x.git', 'javascript:alert(1)']) {
      const d = detailOf(extensionsPanelEl({ entries: [{ ...INSTALLED, origin: bad }] }));
      assert.equal(byClass(d, 'ext-kv-open').length, 0, bad);
      assert.ok(texts(d).includes(bad));
    }
    const core = texts(detailOf(extensionsPanelEl({ entries: [BUILTIN_A] })));
    assert.ok(core.includes('Core'));
    assert.equal(core.includes('Repository'), false);
    assert.equal(core.includes('Commit'), false);
  });
});

test('quarantine is stated plainly in the detail pane, and only via textContent', () => {
  withDom(() => {
    const panel = extensionsPanelEl({ entries: [{ ...INSTALLED, quarantine: 'tool name "list_sessions" is already registered' }] });
    assert.ok(texts(panel).includes('tool name "list_sessions" is already registered'));
    assert.equal(byClass(panel, 'ext-row-quarantine')[0].getAttribute('role'), 'status');
  });
});

test('hostile third-party strings are inert text, not markup', () => {
  withDom(() => {
    const evil = '<img src=x onerror=alert(1)>';
    const panel = extensionsPanelEl({ entries: [{ id: 'x', label: evil, description: evil, origin: evil, quarantine: evil, external: true }], statuses: { x: BEHIND } });
    assert.ok(texts(panel).includes(evil));
    assertNoThirdPartyHtml(panel);
  });
});

test('an uninstalled extension says so in its detail, with nothing left to toggle or uninstall', () => {
  withDom(() => {
    const detail = detailOf(extensionsPanelEl({ entries: [WITH_SETTINGS], pendingRemoval: ['notes'] }));
    assert.ok(texts(detail).some((t) => /Uninstalled\. .*stays in memory until the wrangler restarts/.test(t)));
    assert.equal(byClass(detail, 'setting-toggle').length, 0);
    assert.equal(byClass(detail, 'ext-btn-danger').length, 0);
    assert.equal(byClass(detail, 'ext-setting-row').length, 0, 'nothing left to configure');
  });
});

test('Restart now sits above the detail, and only while something waits on it and the server can restart', () => {
  withDom(() => {
    let restarts = 0;
    const opts = { entries: [INSTALLED], canRestart: true, onRestart: () => { restarts += 1; } };
    assert.equal(byClass(extensionsPanelEl(opts), 'ext-btn-warn').length, 0);
    for (const pending of [{ pendingRemoval: ['notes'] }, { pendingInstall: 'other' }]) {
      const notices = byClass(extensionsPanelEl({ ...opts, ...pending }), 'ext-notices')[0];
      const btn = byClass(notices, 'ext-btn-warn')[0];
      assert.equal(btn._text, 'Restart now');
      btn.fire('click');
    }
    assert.equal(restarts, 2);
    const going = byClass(extensionsPanelEl({ ...opts, pendingRemoval: ['notes'], restarting: true }), 'ext-btn-warn')[0];
    assert.equal(going._text, 'Restarting…');
    assert.equal(going.disabled, true);
    assert.equal(byClass(extensionsPanelEl({ ...opts, canRestart: false, pendingRemoval: ['notes'] }), 'ext-btn-warn').length, 0);
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

test('the selected extension\'s settings render inline under Settings; none means no section', () => {
  withDom(() => {
    const seen = [];
    const detail = detailOf(extensionsPanelEl({ entries: [WITH_SETTINGS], onSettingChange: (c) => seen.push(c) }));
    assert.ok(texts(detail).includes('Settings'));
    assert.deepEqual(byClass(detail, 'ext-setting-row').map((r) => r.dataset.key), ['registryUrl', 'pollMs', 'auto']);
    byClass(detail, 'setting-toggle').at(-1).fire('click');
    assert.deepEqual(seen, [{ id: 'notes', key: 'auto', value: false }]);
    assert.equal(texts(detailOf(extensionsPanelEl({ entries: [INSTALLED] }))).includes('Settings'), false);
    // Only hidden defs (a settings.panel manages them) is still nothing to draw.
    const hiddenOnly = { ...INSTALLED, settings: [{ key: 'k', type: 'text', label: 'K', hidden: true }] };
    assert.equal(texts(detailOf(extensionsPanelEl({ entries: [hiddenOnly] }))).includes('Settings'), false);
  });
});

test('a caller-supplied settingsEl replaces the default rows, and null omits the section', () => {
  withDom(() => {
    const custom = document.createElement('div');
    custom.textContent = 'custom';
    const asked = [];
    const panel = extensionsPanelEl({ entries: [INSTALLED], settingsEl: (e) => { asked.push(e.id); return custom; } });
    assert.deepEqual(asked, ['notes']);
    assert.ok(walk(detailOf(panel)).includes(custom));
    assert.equal(texts(detailOf(extensionsPanelEl({ entries: [WITH_SETTINGS], settingsEl: () => null }))).includes('Settings'), false);
  });
});

test('+ Add extension opens the install form in the detail pane', () => {
  withDom(() => {
    let adds = 0;
    const panel = extensionsPanelEl({ entries: [INSTALLED], onAdd: () => { adds += 1; } });
    assert.equal(byClass(panel, 'ext-install-url').length, 0);
    byClass(panel, 'ext-add-btn')[0].fire('click');
    assert.equal(adds, 1);
    const adding = extensionsPanelEl({ entries: [INSTALLED], adding: true });
    assert.equal(byClass(detailOf(adding), 'ext-install-url').length, 1);
    assert.equal(byClass(adding, 'ext-list-row')[0].classList.contains('selected'), false);
  });
});

const REPO = {
  fullName: 'someone/wrangler-thing', name: 'wrangler-thing', owner: 'someone',
  avatarUrl: 'https://avatars.githubusercontent.com/u/1?v=4', description: '<b>Does a thing</b>',
  cloneUrl: 'https://github.com/someone/wrangler-thing.git', htmlUrl: 'https://github.com/someone/wrangler-thing',
  stars: 1234, language: 'JavaScript', pushedAt: '2026-10-05T00:00:00Z',
};
const MINE = { ...REPO, fullName: 'charlie/notes', name: 'notes', owner: 'charlie', cloneUrl: 'https://github.com/charlie/notes.git', htmlUrl: 'https://github.com/charlie/notes' };

test('the add pane lists GitHub repos as cards under the unvetted notice', () => {
  withDom(() => {
    const installs = [];
    const installed = { ...INSTALLED, origin: 'git@github.com:Charlie/notes.git' };
    const panel = extensionsPanelEl({
      entries: [installed], adding: true, browse: { repos: [MINE, REPO] }, onInstall: (u) => installs.push(u),
    });
    const notice = byClass(panel, 'ext-gh-notice')[0];
    assert.ok(texts(notice).includes(` ${BROWSE_NOTICE}`));
    const cards = byClass(panel, 'ext-gh-card');
    // Installed ones sink to the bottom and offer no Install button.
    assert.deepEqual(cards.map((c) => texts(byClass(c, 'ext-gh-name')[0])[0]), ['wrangler-thing', 'notes']);
    assert.equal(cards[1].classList.contains('installed'), true);
    assert.equal(byClass(cards[1], 'ext-btn').length, 0);
    byClass(cards[0], 'ext-btn')[0].fire('click');
    assert.deepEqual(installs, [REPO.cloneUrl]);
    assert.ok(texts(cards[0]).includes('1.2k'));
    assert.equal(walk(cards[0]).find((n) => n.tagName === 'IMG').src, `${REPO.avatarUrl}&s=80`);
    assertNoThirdPartyHtml(panel);
  });
});

test('the GitHub browser shows loading, error and empty states, and Refresh asks again', () => {
  withDom(() => {
    let browses = 0;
    const loading = extensionsPanelEl({ entries: [INSTALLED], adding: true, browse: { loading: true }, onBrowse: () => { browses += 1; } });
    assert.equal(byClass(loading, 'ext-gh-skeleton').length, 3);
    assert.equal(byClass(loading, 'ext-gh-refresh')[0].disabled, true);
    const failed = extensionsPanelEl({ entries: [INSTALLED], adding: true, browse: { error: 'rate limited', repos: [] }, onBrowse: () => { browses += 1; } });
    assert.ok(texts(failed).includes('Could not search GitHub: rate limited'));
    byClass(failed, 'ext-gh-refresh')[0].fire('click');
    assert.equal(browses, 1);
    const empty = extensionsPanelEl({ entries: [INSTALLED], adding: true, browse: { repos: [] } });
    assert.ok(texts(empty).includes('Nothing tagged yet.'));
    assert.equal(byClass(extensionsPanelEl({ entries: [INSTALLED], adding: true }), 'ext-gh').length, 0);
  });
});

test('normalizeRepoUrl and updatedAgoText', () => {
  for (const u of ['https://github.com/A/b.git', 'git@github.com:a/B.git', 'ssh://git@github.com/a/b', 'https://github.com/a/b/']) {
    assert.equal(normalizeRepoUrl(u), 'https://github.com/a/b');
  }
  const now = Date.parse('2026-10-08T00:00:00Z');
  assert.equal(updatedAgoText('2026-10-05T00:00:00Z', now), 'Updated 3 days ago');
  assert.equal(updatedAgoText('2026-10-07T23:00:00Z', now), 'Updated 1 hour ago');
  assert.equal(updatedAgoText('nope', now), '');
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

test('a finished update that waits on a restart says so above the detail pane', () => {
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


// -- declared constraints ---------------------------------------------------
const CONSTRAINED = {
  ...INSTALLED,
  settings: [
    { key: 'pollSeconds', type: 'number', label: 'Poll interval', min: 15, max: 600, step: 15 },
    { key: 'registryUrl', type: 'text', label: 'Registry URL', maxLength: 30, pattern: 'https://.*' },
    { key: 'mode', type: 'select', label: 'Mode', options: [{ value: 'fast', label: 'Fast' }, { value: 'slow', label: 'Slow' }] },
  ],
  settingValues: { mode: 'slow' },
};

test('declared constraints are mirrored onto the native input, and absent when undeclared', () => {
  withDom(() => {
    const [num, text] = byClass(extensionSettingRowsEl(CONSTRAINED), 'ext-setting-input');
    assert.deepEqual([num.attrs.min, num.attrs.max, num.attrs.step], ['15', '600', '15']);
    assert.equal(text.maxLength, 30);
    assert.equal(text.attrs.pattern, 'https://.*');
    // An unconstrained setting's markup is unchanged.
    const [plainText, plainNum] = byClass(extensionSettingRowsEl(WITH_SETTINGS), 'ext-setting-input');
    assert.equal(plainText.attrs.pattern, undefined);
    assert.equal(plainText.maxLength, undefined);
    for (const k of ['min', 'max', 'step']) assert.equal(plainNum.attrs[k], undefined);
  });
});

test('an invalid value is reported and NOT committed, and the corrected one still is', () => {
  withDom(() => {
    const seen = [];
    const wrap = extensionSettingRowsEl(CONSTRAINED, { onSettingChange: (c) => seen.push(c) });
    const num = byClass(wrap, 'ext-setting-input')[0];
    num._valid = false;
    num.validationMessage = 'Please enter a valid value.';
    num.value = '20';
    num.fire('change');
    assert.deepEqual(seen, [], 'nothing is sent for a value the browser refuses');
    assert.equal(byClass(wrap, 'setting-error')[0].textContent, 'Please enter a valid value.');
    // `last` was deliberately not moved by the rejection, so the fix commits
    // rather than looking unchanged.
    num._valid = true;
    num.value = '30';
    num.fire('change');
    assert.deepEqual(seen, [{ id: 'notes', key: 'pollSeconds', value: 30 }]);
    assert.equal(byClass(wrap, 'setting-error')[0].textContent, '', 'a valid commit clears the message');
  });
});

test('a select renders a leading empty option plus the declared ones, and commits on change', () => {
  withDom(() => {
    const seen = [];
    const wrap = extensionSettingRowsEl(CONSTRAINED, { onSettingChange: (c) => seen.push(c) });
    const sel = byClass(wrap, 'ext-setting-input')[2];
    assert.equal(sel.tagName, 'SELECT');
    assert.deepEqual(sel.children.map((o) => [o.value, o.textContent]), [['', ''], ['fast', 'Fast'], ['slow', 'Slow']]);
    assert.equal(sel.value, 'slow');
    sel.value = 'fast';
    sel.fire('change');
    assert.deepEqual(seen, [{ id: 'notes', key: 'mode', value: 'fast' }]);
    // The empty option is the only clearing route a select has.
    sel.value = '';
    sel.fire('change');
    assert.deepEqual(seen.at(-1), { id: 'notes', key: 'mode', value: '' });
  });
});

test('an option label containing markup goes in as text, never innerHTML', () => {
  withDom(() => {
    const evil = '<img src=x onerror=alert(1)>';
    const wrap = extensionSettingRowsEl({
      id: 'x', settingValues: {},
      settings: [{ key: 'mode', type: 'select', label: 'Mode', options: [{ value: 'a', label: evil }] }],
    });
    assert.ok(texts(wrap).includes(evil));
    for (const node of walk(wrap)) assert.equal(node._html, null, `${node.className} must not use innerHTML`);
  });
});

const LIST_ENTRY = {
  id: 'chips', label: 'Chips', enabled: true,
  settings: [
    { key: 'hiddenChips', type: 'list', label: 'Hidden chips', hidden: true },
    { key: 'tags', type: 'list', label: 'Tags', maxItems: 3 },
  ],
  settingValues: { hiddenChips: ['a'], tags: ['x', 'y'] },
};
const listInputs = (wrap) => byClass(wrap, 'ext-setting-input');
const errorText = (wrap) => byClass(wrap, 'setting-error')[0]._text;

test('a hidden def draws no row; a visible list draws one field per item plus an add field', () => {
  withDom(() => {
    const wrap = extensionSettingRowsEl(LIST_ENTRY);
    assert.deepEqual(byClass(wrap, 'ext-setting-row').map((r) => r.dataset.key), ['tags']);
    assert.deepEqual(listInputs(wrap).map((i) => i.value), ['x', 'y', '']);
    assert.equal(byClass(wrap, 'ext-setting-list-remove').length, 2);
  });
});

test('a list editor commits the whole array on add, edit and remove', () => {
  withDom(() => {
    const sent = [];
    const wrap = extensionSettingRowsEl(LIST_ENTRY, { onSettingChange: (c) => sent.push(c.value) });
    const add = listInputs(wrap)[2];
    add.value = '  z  ';
    add.fire('keydown', { key: 'Enter' });
    assert.deepEqual(sent.at(-1), ['x', 'y', 'z']);
    const first = listInputs(wrap)[0];
    first.value = 'w';
    first.fire('change');
    assert.deepEqual(sent.at(-1), ['w', 'y', 'z']);
    byClass(wrap, 'ext-setting-list-remove')[1].fire('click');
    assert.deepEqual(sent.at(-1), ['w', 'z']);
    const blanked = listInputs(wrap)[0];
    blanked.value = ' ';
    blanked.fire('change');
    assert.deepEqual(sent.at(-1), ['z']);
    assert.deepEqual(listInputs(wrap).map((i) => i.value), ['z', '']);
  });
});

test('a list editor refuses duplicates and items past maxItems without committing', () => {
  withDom(() => {
    const sent = [];
    const wrap = extensionSettingRowsEl(
      { ...LIST_ENTRY, settingValues: { tags: ['x', 'y', 'z'] } },
      { onSettingChange: (c) => sent.push(c.value) },
    );
    const add = listInputs(wrap)[3];
    add.value = 'x';
    add.fire('keydown', { key: 'Enter' });
    assert.match(errorText(wrap), /already/);
    add.value = 'q';
    add.fire('keydown', { key: 'Enter' });
    assert.match(errorText(wrap), /At most 3/);
    assert.equal(sent.length, 0);
  });
});

test('a list editor mirrors pattern and maxLength onto every field and refuses an invalid item', () => {
  withDom(() => {
    const sent = [];
    const entry = {
      ...LIST_ENTRY,
      settings: [{ key: 'tags', type: 'list', label: 'Tags', pattern: 'env_\\w+', maxLength: 40 }],
    };
    const wrap = extensionSettingRowsEl(entry, { onSettingChange: (c) => sent.push(c.value) });
    for (const i of listInputs(wrap)) {
      assert.equal(i.attrs.pattern, 'env_\\w+');
      assert.equal(i.maxLength, 40);
    }
    const add = listInputs(wrap)[2];
    add.value = 'nope';
    add._valid = false;
    add.validationMessage = 'Please match the requested format.';
    add.fire('keydown', { key: 'Enter' });
    assert.equal(errorText(wrap), 'Please match the requested format.');
    assert.equal(sent.length, 0);
  });
});

test('a quarantined list editor is disabled', () => {
  withDom(() => {
    const wrap = extensionSettingRowsEl({ ...LIST_ENTRY, quarantine: 'bad' });
    assert.ok(listInputs(wrap).every((i) => i.disabled));
    assert.ok(byClass(wrap, 'ext-btn').every((b) => b.disabled));
  });
});

const WITH_TEXTAREA = {
  id: 'notes', label: 'Session notes', external: true,
  settings: [{ key: 'process', type: 'textarea', label: 'Review process', placeholder: 'Step one\nStep two', maxLength: 500 }],
  settingValues: { process: '1. Gather.\n2. Verify.' },
};

test('a textarea renders a multi-line control, mirrors placeholder and maxLength, and never a pattern', () => {
  withDom(() => {
    const [area] = byClass(extensionSettingRowsEl(WITH_TEXTAREA), 'ext-setting-input');
    assert.equal(area.tagName, 'TEXTAREA');
    assert.equal(area.value, '1. Gather.\n2. Verify.');
    assert.equal(area.placeholder, 'Step one\nStep two');
    assert.equal(area.maxLength, 500);
    assert.equal(area.attrs.pattern, undefined);
    assert.equal(area.type, undefined, 'a textarea has no input type');
  });
});

test('a textarea with a placeholder gets a button that copies the default text', async () => {
  await withDom(async () => {
    let copied;
    Object.defineProperty(globalThis, 'navigator', { value: { clipboard: { writeText: (t) => { copied = t; return Promise.resolve(); } } }, configurable: true });
    const wrap = extensionSettingRowsEl({ ...WITH_TEXTAREA, settingValues: {} });
    const [btn] = byClass(wrap, 'ext-setting-copy');
    btn.fire('click');
    assert.equal(copied, 'Step one\nStep two');
    assert.equal(btn.hidden, false, 'shown while blank');
    const filled = byClass(extensionSettingRowsEl(WITH_TEXTAREA), 'ext-setting-copy')[0];
    assert.equal(filled.hidden, true, 'hidden once there is text');
    assert.equal(byClass(extensionSettingRowsEl({ ...WITH_TEXTAREA, settings: [{ key: 'p', type: 'textarea', label: 'P' }] }), 'ext-setting-copy').length, 0);
  });
});

test('Enter in a textarea is a newline: it neither commits nor is swallowed; blur commits the text verbatim', () => {
  withDom(() => {
    const seen = [];
    const wrap = extensionSettingRowsEl(WITH_TEXTAREA, { onSettingChange: (c) => seen.push(c) });
    const [area] = byClass(wrap, 'ext-setting-input');
    let prevented = 0;
    area.value = '1. Gather.\n2. Verify.\n';
    area.fire('keydown', { key: 'Enter', preventDefault: () => { prevented += 1; } });
    assert.deepEqual(seen, []);
    assert.equal(prevented, 0, 'the newline must reach the textarea');
    area.value = '  1. Gather.\n\n2. Verify.\n';
    area.fire('change');
    assert.deepEqual(seen, [{ id: 'notes', key: 'process', value: '  1. Gather.\n\n2. Verify.\n' }], 'not trimmed');
  });
});

test('a remount first blurs a focused field inside the pane, so a blur-committed edit is not lost', () => {
  const calls = [];
  const area = { blur: () => calls.push('blur') };
  const modal = { contains: (n) => n === area };
  commitFocusedField(modal, { activeElement: area });
  assert.deepEqual(calls, ['blur']);
  const outside = { blur: () => calls.push('outside') };
  commitFocusedField(modal, { activeElement: outside });
  commitFocusedField(modal, { activeElement: null });
  assert.deepEqual(calls, ['blur'], 'focus outside the pane is left alone');
});

test('a textarea with no declared maxLength still gets the server\'s cap natively', () => {
  assert.equal(MAX_TEXTAREA_LENGTH, SERVER_MAX_TEXTAREA_LENGTH, 'the browser mirror must match the server enforcement');
  withDom(() => {
    const entry = { id: 'x', settingValues: {}, settings: [{ key: 'process', type: 'textarea', label: 'Process' }] };
    const [area] = byClass(extensionSettingRowsEl(entry), 'ext-setting-input');
    assert.equal(area.maxLength, MAX_TEXTAREA_LENGTH);
  });
});
