import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deckSettingValue, deckSettingFrame, startupChoices, settingsDeckChoices } from './deck-settings.js';
import { nextUpdateState } from './deck-settings-panels.js';
import { SETTINGS, SETTINGS_TABS, BOARD_TABS, DECK_TABS, isDeckSetting, setExtensionDefs } from './settings.js';
import { CORE_ACTIONS } from '../server/deck/actions.js';

test('the two-deck layout puts every setting in exactly one Board or Deck tab', () => {
  setExtensionDefs([]);
  const ids = [...BOARD_TABS, ...DECK_TABS].flatMap((t) => t.settingIds);
  assert.equal(ids.length, new Set(ids).size);
  assert.deepEqual(new Set(ids), new Set(SETTINGS_TABS.flatMap((t) => t.settingIds)));
  assert.deepEqual(new Set(ids), new Set(SETTINGS.map((s) => s.id)));
});

test('deck tabs hold only settings the deck stores; board tabs hold per-browser rows and the toast filter', () => {
  const byId = new Map(SETTINGS.map((s) => [s.id, s]));
  for (const id of DECK_TABS.flatMap((t) => t.settingIds)) {
    assert.equal(byId.get(id).scope, 'server', `${id} is stored by a deck`);
    assert.ok(isDeckSetting(id));
  }
  const boardServer = BOARD_TABS.flatMap((t) => t.settingIds).filter((id) => byId.get(id).scope === 'server');
  assert.deepEqual(boardServer, ['suppressNudgedPrToasts']);
  assert.ok(isDeckSetting('ext:jira'), 'an extension toggle belongs to its deck');
  assert.ok(!isDeckSetting('suppressNudgedPrToasts'));
});

test('every deck setting is written by an admin action every deck offers', () => {
  for (const id of [...DECK_TABS.flatMap((t) => t.settingIds), 'suppressNudgedPrToasts', 'ext:jira']) {
    const sample = id === 'backgroundModel' ? 'claude:haiku' : 'x';
    const frame = deckSettingFrame(id, sample);
    assert.ok(frame, `${id} has a frame`);
    assert.match(CORE_ACTIONS[frame.type] || '', /^admin\./, `${id} → ${frame.type}`);
  }
  assert.equal(deckSettingFrame('terminalSide', 'left'), null, 'a per-browser setting is never sent to a deck');
  assert.deepEqual(deckSettingFrame('defaultRuntime', 'devcontainer'), { type: 'set-default-runtime', runtime: 'devcontainer' });
  assert.deepEqual(deckSettingFrame('codexDefaultSandbox', 'read-only'), { type: 'set-codex-policy-default', key: 'sandbox', value: 'read-only' });
  assert.deepEqual(deckSettingFrame('backgroundModel', 'claude:sonnet[1m]'), { type: 'set-background-model', agent: 'claude', model: 'sonnet[1m]' });
  assert.deepEqual(deckSettingFrame('ext:jira', false), { type: 'extension-enabled', id: 'jira', enabled: false });
});

test('a deck setting reads off that deck\'s graph with the board\'s fallbacks', () => {
  assert.equal(deckSettingValue({}, 'autoFixPrChecksDefault'), true);
  assert.equal(deckSettingValue({ autoFixPrChecksDefault: false }, 'autoFixPrChecksDefault'), false);
  assert.equal(deckSettingValue({}, 'mailWakesDormant'), false);
  assert.equal(deckSettingValue({}, 'defaultRuntime'), 'local');
  assert.equal(deckSettingValue({ defaultRuntime: 'devcontainer' }, 'defaultRuntime'), 'devcontainer');
  assert.equal(deckSettingValue({}, 'autoUpdate'), 'notify');
  assert.equal(deckSettingValue({ backgroundModel: { agent: 'claude', model: 'haiku' } }, 'backgroundModel'), 'claude:haiku');
  assert.equal(deckSettingValue({ codexPolicyDefaults: { bypass: true } }, 'codexDefaultBypass'), true);
  assert.equal(deckSettingValue({ codexPolicyDefaults: { bypass: true } }, 'codexDefaultApproval'), 'on-request');
  assert.equal(deckSettingValue({ extensions: [{ id: 'jira', enabled: false }] }, 'ext:jira'), false);
  assert.equal(deckSettingValue({ extensions: [] }, 'ext:jira'), undefined);
  assert.equal(deckSettingValue(null, 'terminalSide'), undefined);
});

test('startup choices are every non-protocol descriptor field, read-only text', () => {
  const base = { deckId: 'd', name: 'n', api: '1.0', runtimes: [{ id: 'local' }], actions: ['a'], extensions: [] };
  assert.deepEqual(startupChoices(base), []);
  assert.deepEqual(startupChoices({ ...base, offeredRuntimes: null }), [{ key: 'offeredRuntimes', label: 'Offered runtimes', value: 'Not set: the deck\'s default' }]);
  assert.deepEqual(startupChoices({ ...base, offeredRuntimes: ['testloc', 'local'] })[0].value, 'testloc, local');
  assert.deepEqual(startupChoices({ ...base, startup: { readOnly: true, max_sessions: 4 } }).map((c) => [c.label, c.value]), [['Read only', 'On'], ['Max sessions', '4']]);
  assert.deepEqual(startupChoices(null), []);
});

test('the Settings deck picker lists every deck; only a connected one with live state is available', () => {
  const choices = settingsDeckChoices([
    { id: 'own', own: true, name: 'Laptop', status: 'ready', live: true },
    { id: 'b', name: 'Build box', status: 'ready', live: true },
    { id: 'c', name: 'Old', status: 'unreachable', live: false },
    { id: 'd', name: 'Waking', status: 'ready', live: false },
    { id: 'e', name: 'Twice', status: 'ready', live: false, duplicate: 'own' },
  ]);
  assert.deepEqual(choices.map((c) => [c.key, c.available, c.why]), [
    ['own', true, ''], ['b', true, ''], ['c', false, 'unreachable'], ['d', false, 'unreachable'], ['e', false, 'already on this board'],
  ]);
  assert.equal(choices[0].own, true);
});

test('a deck\'s update news builds its own update state', () => {
  let s = nextUpdateState(undefined, { type: 'config', canRestart: true, update: null, updateUnavailable: { reason: 'brew' } });
  assert.equal(s.canRestart, true);
  assert.deepEqual(s.unavailable, { reason: 'brew' });
  s = nextUpdateState({ ...s, phase: 'checking' }, { type: 'update-status', behind: 2, commits: [] });
  assert.equal(s.phase, 'status');
  assert.equal(s.status.behind, 2);
  assert.equal(s.status.type, undefined);
  assert.equal(nextUpdateState(s, { type: 'update-error', message: 'no git' }).error, 'no git');
  assert.equal(nextUpdateState(s, { type: 'restart-ack' }).restarting, true);
});
