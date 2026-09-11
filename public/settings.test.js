import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SETTINGS_TABS, isOpenSettingsKey, tabIndexAfterKey, setExtensionDefs, extensionFlipNote, getSetting, EXT_SETTING_PREFIX } from './settings.js';

test('settings are grouped into five ordered tabs', () => {
  assert.deepEqual(SETTINGS_TABS.map(({ id, label }) => ({ id, label })), [
    { id: 'appearance', label: 'Appearance' },
    { id: 'sessions', label: 'Sessions' },
    { id: 'automation', label: 'Automation' },
    { id: 'extensions', label: 'Extensions' },
    { id: 'shortcuts', label: 'Shortcuts' },
  ]);
});

test('each registered setting appears in exactly one tab', () => {
  setExtensionDefs([]);
  const settingIds = SETTINGS_TABS.flatMap((tab) => tab.settingIds);
  assert.equal(settingIds.length, new Set(settingIds).size);
  assert.deepEqual(new Set(settingIds), new Set([
    'terminalSide',
    'taskMemoryEnabled',
    'subagentsExpandedByDefault',
    'soundOnFinish',
    'childFullViewByDefault',
    'chatViewDefault',
    'autoFixPrChecksDefault',
    'trustCodexLaunchCwd',
    'archiveReviewEnabled',
    'flipNavHotkeys',
  ]));
});

// The Extensions tab is built from the server's list, never hand-listed: one
// server-scoped toggle per extension, replaced wholesale on each call so a
// re-sent list can't accumulate stale rows.
test('setExtensionDefs builds one server toggle per extension and replaces the previous set', () => {
  const defs = setExtensionDefs([
    { id: 'checklist', label: 'Per-session checklist', help: 'A list.', defaultEnabled: true },
    { id: 'other', label: 'Other', help: 'Something.', defaultEnabled: false },
    { id: 'bare' },
  ]);
  assert.deepEqual(defs.map((d) => [d.id, d.type, d.scope, d.label, d.default]), [
    [`${EXT_SETTING_PREFIX}checklist`, 'toggle', 'server', 'Per-session checklist', true],
    [`${EXT_SETTING_PREFIX}other`, 'toggle', 'server', 'Other', false],
    [`${EXT_SETTING_PREFIX}bare`, 'toggle', 'server', 'bare', true],
  ]);
  // Help is the manifest's own words, verbatim — no appended timing sentence.
  // A blanket "takes effect after a restart" is false for the half of a flip
  // that lands on the next tick; timing is extensionFlipNote's job.
  assert.equal(defs[0].help, 'A list.');
  assert.equal(defs[1].help, 'Something.');
  assert.equal(defs[2].help, '');
  assert.deepEqual(SETTINGS_TABS.find((t) => t.id === 'extensions').settingIds, defs.map((d) => d.id));
  // Registered: readable through the ordinary getSetting path, falling back to
  // the manifest default when the server bridge has nothing for it.
  assert.equal(getSetting(`${EXT_SETTING_PREFIX}checklist`), true);
  assert.equal(getSetting(`${EXT_SETTING_PREFIX}other`), false);
  setExtensionDefs([{ id: 'solo', label: 'Solo' }]);
  assert.deepEqual(SETTINGS_TABS.find((t) => t.id === 'extensions').settingIds, [`${EXT_SETTING_PREFIX}solo`]);
  assert.equal(getSetting(`${EXT_SETTING_PREFIX}checklist`), undefined, 'a dropped extension is unregistered');
  setExtensionDefs([]);
});

test('tab arrow navigation wraps in both directions', () => {
  assert.equal(tabIndexAfterKey(0, 'ArrowRight', 4), 1);
  assert.equal(tabIndexAfterKey(3, 'ArrowRight', 4), 0);
  assert.equal(tabIndexAfterKey(0, 'ArrowLeft', 4), 3);
  assert.equal(tabIndexAfterKey(2, 'Home', 4), 0);
  assert.equal(tabIndexAfterKey(1, 'End', 4), 3);
  assert.equal(tabIndexAfterKey(1, 'Enter', 4), 1);
});

test('settings shortcut requires exactly Ctrl+Cmd+comma', () => {
  assert.equal(isOpenSettingsKey({ key: ',', metaKey: true, ctrlKey: true }), true);
  assert.equal(isOpenSettingsKey({ key: ',', metaKey: true }), false);
  assert.equal(isOpenSettingsKey({ key: ',', ctrlKey: true }), false);
  assert.equal(isOpenSettingsKey({ key: ',', metaKey: true, ctrlKey: true, shiftKey: true }), false);
  assert.equal(isOpenSettingsKey({ key: ',', metaKey: true, ctrlKey: true, altKey: true }), false);
  assert.equal(isOpenSettingsKey({ key: '.', metaKey: true, ctrlKey: true }), false);
});

test('settings card keeps its chrome fixed around a scrolling pane', () => {
  const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');
  assert.match(css, /\.settings-card \{[^}]*height: 70vh;[^}]*display: flex;[^}]*flex-direction: column;/s);
  assert.match(css, /\.settings-body \{[^}]*flex: 1 1 auto;[^}]*min-height: 0;/s);
  assert.match(css, /\.settings-panels \{[^}]*flex: 1 1 auto;[^}]*min-height: 0;[^}]*overflow-y: auto;/s);
  assert.match(css, /\.settings-tab\.active \{[^}]*background: transparent;[^}]*border-bottom-color: var\(--accent\);/s);
});

// The three outcomes of flipping an extension toggle. Only the third asks for
// an action, but the other two still need saying: without them "the panel went
// but my agent still has the tools" and "nothing happened" look identical.
test('extensionFlipNote names a restart only when the extension was off at boot', () => {
  assert.match(extensionFlipNote({ enabled: true, bootEnabled: false }), /Restart the wrangler/);
  assert.doesNotMatch(extensionFlipNote({ enabled: true, bootEnabled: true }), /Restart/);
  assert.doesNotMatch(extensionFlipNote({ enabled: false, bootEnabled: true }), /Restart/);
});

test('extensionFlipNote tells both directions what is still pending for running sessions', () => {
  assert.match(extensionFlipNote({ enabled: false, bootEnabled: true }), /Gone from the board\./);
  assert.match(extensionFlipNote({ enabled: false, bootEnabled: true }), /keep its tools until their next resume/);
  assert.match(extensionFlipNote({ enabled: true, bootEnabled: true }), /Back on the board\./);
  assert.match(extensionFlipNote({ enabled: true, bootEnabled: true }), /get its tools at their next resume/);
});

test('extensionFlipNote never throws on a missing pair', () => {
  // An extension announced before bootEnabled existed reads as undefined; the
  // off-branch is the safe fallback, since it promises nothing.
  assert.equal(typeof extensionFlipNote(), 'string');
  assert.equal(typeof extensionFlipNote({}), 'string');
});

test('setExtensionDefs snapshots bootEnabled, defaulting to on for a list that omits it', () => {
  const defs = setExtensionDefs([
    { id: 'live', label: 'Live', bootEnabled: true },
    { id: 'pending', label: 'Pending', bootEnabled: false },
    { id: 'legacy', label: 'Legacy' },
  ]);
  assert.deepEqual(defs.map((d) => d.bootEnabled), [true, false, true]);
  setExtensionDefs([]);
});
