import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SETTINGS_TABS, isOpenSettingsKey, tabIndexAfterKey, setExtensionDefs, getSetting, EXT_SETTING_PREFIX } from './settings.js';

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
// server-scoped toggle per extension, carrying the restart note, replaced
// wholesale on each call so a re-sent list can't accumulate stale rows.
test('setExtensionDefs builds one server toggle per extension with the restart note, and replaces the previous set', () => {
  const defs = setExtensionDefs([
    { id: 'checklist', label: 'Per-session checklist', help: 'A list.', defaultEnabled: true },
    { id: 'other', label: 'Other', help: 'Something. Turning it on or off takes effect after the wrangler restarts.', defaultEnabled: false },
    { id: 'bare' },
  ]);
  assert.deepEqual(defs.map((d) => [d.id, d.type, d.scope, d.label, d.default]), [
    [`${EXT_SETTING_PREFIX}checklist`, 'toggle', 'server', 'Per-session checklist', true],
    [`${EXT_SETTING_PREFIX}other`, 'toggle', 'server', 'Other', false],
    [`${EXT_SETTING_PREFIX}bare`, 'toggle', 'server', 'bare', true],
  ]);
  assert.equal(defs[0].help, 'A list. Takes effect after the wrangler restarts.');
  assert.equal(defs[1].help, 'Something. Turning it on or off takes effect after the wrangler restarts.', 'a help text that already says so is not doubled');
  assert.equal(defs[2].help, 'Takes effect after the wrangler restarts.');
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
