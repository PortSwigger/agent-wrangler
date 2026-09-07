import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SETTINGS_TABS, isOpenSettingsKey, tabIndexAfterKey } from './settings.js';

test('settings are grouped into four ordered tabs', () => {
  assert.deepEqual(SETTINGS_TABS.map(({ id, label }) => ({ id, label })), [
    { id: 'appearance', label: 'Appearance' },
    { id: 'sessions', label: 'Sessions' },
    { id: 'automation', label: 'Automation' },
    { id: 'shortcuts', label: 'Shortcuts' },
  ]);
});

test('each registered setting appears in exactly one tab', () => {
  const settingIds = SETTINGS_TABS.flatMap((tab) => tab.settingIds);
  assert.equal(settingIds.length, new Set(settingIds).size);
  assert.deepEqual(new Set(settingIds), new Set([
    'terminalSide',
    'taskMemoryEnabled',
    'subagentsExpandedByDefault',
    'soundOnFinish',
    'childFullViewByDefault',
    'chatViewDefault',
    'checklistEnabled',
    'autoFixPrChecksDefault',
    'trustCodexLaunchCwd',
    'archiveReviewEnabled',
    'flipNavHotkeys',
  ]));
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
