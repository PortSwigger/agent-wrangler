import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { migrateRetiredFlags, shouldOpenBrowser, prStatusPollSeconds, subagentsExpandedByDefault, trustCodexLaunchCwd, childFullViewByDefault, autoFixPrChecksDefault, archiveReviewEnabled, chatViewDefault, defaultSessionCwd, extensionEnabled, extensionSetting, extensionSettings, setExtensionSetting, writeConfig, readConfig } from './config-store.js';
import { DATA_DIR } from './data-dir.js';
import { writeJsonAtomic } from './atomic-json.js';

test('shouldOpenBrowser: default is OFF (no auto-open)', () => {
  assert.equal(shouldOpenBrowser({}), false);
});

test('shouldOpenBrowser: AW_OPEN_BROWSER is the opt-in', () => {
  assert.equal(shouldOpenBrowser({ AW_OPEN_BROWSER: '1' }), true);
  assert.equal(shouldOpenBrowser({ AW_OPEN_BROWSER: 'true' }), true);
  assert.equal(shouldOpenBrowser({ AW_OPEN_BROWSER: '0' }), false);
  assert.equal(shouldOpenBrowser({ AW_OPEN_BROWSER: 'false' }), false);
});

test('shouldOpenBrowser: legacy AW_NO_OPEN still suppresses, taking precedence', () => {
  assert.equal(shouldOpenBrowser({ AW_NO_OPEN: '1' }), false);
  assert.equal(shouldOpenBrowser({ AW_NO_OPEN: '1', AW_OPEN_BROWSER: '1' }), false);
  // AW_NO_OPEN=0 means "don't suppress", so the new opt-in still applies
  assert.equal(shouldOpenBrowser({ AW_NO_OPEN: '0', AW_OPEN_BROWSER: '1' }), true);
});

// These tests share (and mutate) the install's real config.json — there is no
// path injection in config-store. Snapshot it up front and restore after each,
// so a test never leaves a stray key behind in a real ~/.agent-wrangler.
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
function withConfigRestored(fn) {
  let saved;
  try {
    saved = fs.readFileSync(CONFIG_PATH, 'utf8');
  } catch {
    saved = null;
  }
  try {
    fn();
  } finally {
    if (saved === null) { try { fs.rmSync(CONFIG_PATH); } catch { /* nothing to restore */ } }
    else fs.writeFileSync(CONFIG_PATH, saved);
  }
}

test('prStatusPollSeconds defaults to 60', () => {
  withConfigRestored(() => {
    const { prStatusPollSeconds: _u, ...cleaned } = readConfig();
    writeJsonAtomic(CONFIG_PATH, cleaned, { trailingNewline: true });
    assert.equal(prStatusPollSeconds(), 60);
  });
});

test('prStatusPollSeconds honours a positive override', () => {
  withConfigRestored(() => {
    writeConfig({ prStatusPollSeconds: 30 });
    assert.equal(prStatusPollSeconds(), 30);
  });
});

test('prStatusPollSeconds ignores a non-positive / non-number override', () => {
  withConfigRestored(() => {
    writeConfig({ prStatusPollSeconds: 0 });
    assert.equal(prStatusPollSeconds(), 60);
    writeConfig({ prStatusPollSeconds: 'soon' });
    assert.equal(prStatusPollSeconds(), 60);
  });
});

// Tested via cfg injection, never the real file — same reasoning as archiveReviewEnabled.
test('subagentsExpandedByDefault defaults to off (collapsed); only an explicit true enables', () => {
  assert.equal(subagentsExpandedByDefault({}), false);
  assert.equal(subagentsExpandedByDefault({ subagentsExpandedByDefault: false }), false);
  assert.equal(subagentsExpandedByDefault({ subagentsExpandedByDefault: true }), true);
});

// Tested via cfg injection, never the real file — same reasoning as archiveReviewEnabled.
test('trustCodexLaunchCwd defaults to on; only an explicit false disables', () => {
  assert.equal(trustCodexLaunchCwd({}), true);
  assert.equal(trustCodexLaunchCwd({ trustCodexLaunchCwd: true }), true);
  assert.equal(trustCodexLaunchCwd({ trustCodexLaunchCwd: false }), false);
});

// Tested via cfg injection, never the real file — same reasoning as archiveReviewEnabled.
test('childFullViewByDefault defaults to off (compact); only an explicit true enables', () => {
  assert.equal(childFullViewByDefault({}), false);
  assert.equal(childFullViewByDefault({ childFullViewByDefault: false }), false);
  assert.equal(childFullViewByDefault({ childFullViewByDefault: true }), true);
});

// Tested via cfg injection, never the real file — same reasoning as archiveReviewEnabled.
// Default OFF (unlike most of these): archive review spends real money per
// archive and grows a task's memory.md unbounded, so it must be an explicit opt-in.
test('archiveReviewEnabled defaults to off; only an explicit true enables', () => {
  assert.equal(archiveReviewEnabled({}), false);
  assert.equal(archiveReviewEnabled({ archiveReviewEnabled: false }), false);
  assert.equal(archiveReviewEnabled({ archiveReviewEnabled: true }), true);
});

test('autoFixPrChecksDefault defaults to on; only an explicit false disables', () => {
  assert.equal(autoFixPrChecksDefault({}), true);
  assert.equal(autoFixPrChecksDefault({ autoFixPrChecksDefault: true }), true);
  assert.equal(autoFixPrChecksDefault({ autoFixPrChecksDefault: false }), false);
});

test('chatViewDefault defaults to false (terminal) and is opt-in', () => {
  assert.equal(chatViewDefault({}), false);
  assert.equal(chatViewDefault({ chatViewDefault: true }), true);
  assert.equal(chatViewDefault({ chatViewDefault: 'yes' }), false, 'only a real boolean true opts in');
});

test('defaultSessionCwd is blank unless a string is set, and is trimmed', () => {
  assert.equal(defaultSessionCwd({}), '');
  assert.equal(defaultSessionCwd({ defaultSessionCwd: '  ~/repos  ' }), '~/repos');
  assert.equal(defaultSessionCwd({ defaultSessionCwd: 42 }), '');
});

// The retired-flag table: a core `<x>Enabled` flag that became an extension is
// carried over to `extensions.<id>` once, at boot, and the old key is deleted.
test('migrateRetiredFlags: checklistEnabled false disables the extension; the old key is gone', () => {
  const { cfg, changed } = migrateRetiredFlags({ tmuxSocket: 's', checklistEnabled: false });
  assert.equal(changed, true);
  assert.deepEqual(cfg, { tmuxSocket: 's', extensions: { checklist: false } });
});

test('migrateRetiredFlags: checklistEnabled true (or garbage) just drops the key and adds nothing', () => {
  assert.deepEqual(migrateRetiredFlags({ checklistEnabled: true }), { cfg: {}, changed: true });
  assert.deepEqual(migrateRetiredFlags({ checklistEnabled: 'no' }), { cfg: {}, changed: true }, 'only a real boolean false opted out');
});

test('migrateRetiredFlags: an explicit extensions.checklist wins and siblings survive', () => {
  assert.deepEqual(
    migrateRetiredFlags({ checklistEnabled: false, extensions: { checklist: true, other: false } }).cfg,
    { extensions: { checklist: true, other: false } },
  );
  assert.deepEqual(
    migrateRetiredFlags({ checklistEnabled: false, extensions: { other: false } }).cfg,
    { extensions: { other: false, checklist: false } },
  );
});

test('migrateRetiredFlags: taskMemoryEnabled false disables the task-memory extension; true just drops the key', () => {
  assert.deepEqual(migrateRetiredFlags({ taskMemoryEnabled: false }), { cfg: { extensions: { 'task-memory': false } }, changed: true });
  assert.deepEqual(migrateRetiredFlags({ taskMemoryEnabled: true }), { cfg: {}, changed: true });
});

test('migrateRetiredFlags: idempotent, and a missing key is a no-op that reports no change', () => {
  const once = migrateRetiredFlags({ checklistEnabled: false }).cfg;
  const twice = migrateRetiredFlags(once);
  assert.deepEqual(twice, { cfg: once, changed: false });
  assert.deepEqual(migrateRetiredFlags({}), { cfg: {}, changed: false });
});

test('migrateRetiredFlags: any {oldKey, extId} row works, not just the checklist', () => {
  const table = [{ oldKey: 'fooEnabled', extId: 'foo' }];
  assert.deepEqual(migrateRetiredFlags({ fooEnabled: false }, table).cfg, { extensions: { foo: false } });
});

test('extensionEnabled: the manifest default applies until an explicit boolean overrides it', () => {
  assert.equal(extensionEnabled('demo', true, {}), true);
  assert.equal(extensionEnabled('demo', false, {}), false);
  assert.equal(extensionEnabled('demo', true, { extensions: { demo: false } }), false);
  assert.equal(extensionEnabled('demo', false, { extensions: { demo: true } }), true);
  assert.equal(extensionEnabled('demo', true, { extensions: { demo: 'no' } }), true, 'a non-boolean is ignored, not coerced');
  assert.equal(extensionEnabled('demo', true, { extensions: { other: false } }), true, "another extension's value is not this one's");
});

test('extensionSetting: the caller\'s fallback stands until a value is stored', () => {
  assert.equal(extensionSetting('demo', 'registryUrl', undefined, {}), undefined);
  assert.equal(extensionSetting('demo', 'registryUrl', 'https://d', {}), 'https://d');
  assert.equal(extensionSetting('demo', 'registryUrl', 'https://d', { extensionSettings: { demo: { registryUrl: 'https://x' } } }), 'https://x');
  // Only `undefined` means unset — a stored false, 0 or '' is a real choice.
  assert.equal(extensionSetting('demo', 'auto', true, { extensionSettings: { demo: { auto: false } } }), false);
  assert.equal(extensionSetting('demo', 'pollMs', 30, { extensionSettings: { demo: { pollMs: 0 } } }), 0);
  assert.equal(extensionSetting('demo', 'registryUrl', 'https://d', { extensionSettings: { other: { registryUrl: 'https://x' } } }), 'https://d');
});

test('extensionSettings: an extension\'s whole block, as a copy, and {} when it has none', () => {
  assert.deepEqual(extensionSettings('demo', {}), {});
  assert.deepEqual(extensionSettings('demo', { extensionSettings: { other: { a: 1 } } }), {});
  assert.deepEqual(extensionSettings('demo', { extensionSettings: { demo: 'nope' } }), {}, 'a hand-edited non-object is ignored, not returned');
  assert.deepEqual(extensionSettings('demo', { extensionSettings: { demo: ['a'] } }), {});
  const cfg = { extensionSettings: { demo: { registryUrl: 'https://x' } } };
  const block = extensionSettings('demo', cfg);
  block.registryUrl = 'mutated';
  assert.equal(cfg.extensionSettings.demo.registryUrl, 'https://x', 'a copy, so a reader cannot write config back through it');
});

test('setExtensionSetting spreads BOTH levels: a sibling key and a sibling extension both survive, and extensions.<id> is untouched', () => {
  withConfigRestored(() => {
    writeJsonAtomic(CONFIG_PATH, {
      tmuxSocket: 'aw-1',
      extensions: { demo: true },
      extensionSettings: { demo: { pollMs: 30 }, other: { keep: 'me' } },
    }, { trailingNewline: true });
    setExtensionSetting('demo', 'registryUrl', 'https://x');
    assert.deepEqual(readConfig(), {
      tmuxSocket: 'aw-1',
      extensions: { demo: true },
      extensionSettings: { demo: { pollMs: 30, registryUrl: 'https://x' }, other: { keep: 'me' } },
    });
    // The whole reason the values live in their own block: a setting can never
    // collide with the enable flag, whatever a manifest calls its keys.
    setExtensionSetting('demo', 'enabled', false);
    assert.equal(readConfig().extensions.demo, true);
    assert.equal(readConfig().extensionSettings.demo.enabled, false);
  });
});

test('setExtensionSetting creates the block for an extension that has never had one', () => {
  withConfigRestored(() => {
    writeJsonAtomic(CONFIG_PATH, { tmuxSocket: 'aw-1' }, { trailingNewline: true });
    setExtensionSetting('demo', 'auto', true);
    assert.deepEqual(readConfig(), { tmuxSocket: 'aw-1', extensionSettings: { demo: { auto: true } } });
  });
});


const JIRA_ROW = [{ oldKey: 'jiraBaseUrl', extId: 'jira', key: 'baseUrl', envKey: 'AW_JIRA_BASE_URL' }];
const migrateJira = (cfg, env = {}) => migrateRetiredFlags(cfg, [], JIRA_ROW, env);

test('migrateRetiredFlags: jiraBaseUrl moves to the jira extension setting and the old key is dropped', () => {
  const { cfg, changed } = migrateJira({ tmuxSocket: 's', jiraBaseUrl: ' https://co.atlassian.net/browse/ ' });
  assert.equal(changed, true);
  assert.deepEqual(cfg, { tmuxSocket: 's', extensionSettings: { jira: { baseUrl: 'https://co.atlassian.net/browse/' } } });
});

test('migrateRetiredFlags: an existing jira setting wins over the old key; siblings survive', () => {
  const { cfg } = migrateJira({ jiraBaseUrl: 'https://old/', extensionSettings: { jira: { baseUrl: 'https://new/' }, other: { a: 1 } } });
  assert.deepEqual(cfg, { extensionSettings: { jira: { baseUrl: 'https://new/' }, other: { a: 1 } } });
});

test('migrateRetiredFlags: with no config value, AW_JIRA_BASE_URL seeds the setting so the variable can be dropped', () => {
  const env = { AW_JIRA_BASE_URL: 'https://co.atlassian.net/browse/' };
  const first = migrateJira({}, env);
  assert.equal(first.changed, true);
  assert.equal(first.cfg.extensionSettings.jira.baseUrl, 'https://co.atlassian.net/browse/');
  assert.equal(migrateJira(first.cfg, env).changed, false, 'idempotent once seeded');
  assert.equal(migrateJira({ jiraBaseUrl: 'https://mine/' }, env).cfg.extensionSettings.jira.baseUrl, 'https://mine/', 'the config value beats the env');
});

test('migrateRetiredFlags: a blank or non-string old value just drops the key; no env means nothing is added', () => {
  assert.deepEqual(migrateJira({ jiraBaseUrl: '' }), { cfg: {}, changed: true });
  assert.deepEqual(migrateJira({ jiraBaseUrl: 123 }), { cfg: {}, changed: true });
  assert.deepEqual(migrateJira({ tmuxSocket: 's' }), { cfg: { tmuxSocket: 's' }, changed: false });
});
