import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { shouldOpenBrowser, jiraBaseUrl, prStatusPollSeconds, taskMemoryEnabled, subagentsExpandedByDefault, trustCodexLaunchCwd, childFullViewByDefault, writeConfig, readConfig } from './config-store.js';
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
// so a test never leaves a stray jiraBaseUrl behind in a real ~/.agent-wrangler.
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

test('jiraBaseUrl is empty when unset and no env override', () => {
  withConfigRestored(() => {
    const { jiraBaseUrl: _unused, ...cleaned } = readConfig();
    writeJsonAtomic(CONFIG_PATH, cleaned, { trailingNewline: true });
    assert.equal(jiraBaseUrl({}), '');
  });
});

test('AW_JIRA_BASE_URL provides an org-wide default when config.json has no override', () => {
  withConfigRestored(() => {
    const { jiraBaseUrl: _unused, ...cleaned } = readConfig();
    writeJsonAtomic(CONFIG_PATH, cleaned, { trailingNewline: true });
    assert.equal(jiraBaseUrl({ AW_JIRA_BASE_URL: 'https://co.atlassian.net/browse/' }), 'https://co.atlassian.net/browse/');
  });
});

test('jiraBaseUrl returns the configured value, overriding the env default', () => {
  withConfigRestored(() => {
    writeConfig({ jiraBaseUrl: 'https://co.atlassian.net/browse/' });
    assert.equal(jiraBaseUrl({ AW_JIRA_BASE_URL: 'https://other.atlassian.net/browse/' }), 'https://co.atlassian.net/browse/');
  });
});

test('an explicit empty string opts out even when AW_JIRA_BASE_URL is set', () => {
  withConfigRestored(() => {
    writeConfig({ jiraBaseUrl: '' });
    assert.equal(jiraBaseUrl({ AW_JIRA_BASE_URL: 'https://co.atlassian.net/browse/' }), '');
  });
});

test('jiraBaseUrl falls back to the env default for a non-string config value', () => {
  withConfigRestored(() => {
    writeConfig({ jiraBaseUrl: 123 });
    assert.equal(jiraBaseUrl({ AW_JIRA_BASE_URL: 'https://co.atlassian.net/browse/' }), 'https://co.atlassian.net/browse/');
  });
});

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

// Tested via cfg injection, never the real file: writing taskMemoryEnabled:false
// here (even transiently) races the claude/codex launch tests, which read the
// live default in parallel `node --test` processes.
test('taskMemoryEnabled defaults to on; only an explicit false disables', () => {
  assert.equal(taskMemoryEnabled({}), true);
  assert.equal(taskMemoryEnabled({ taskMemoryEnabled: true }), true);
  assert.equal(taskMemoryEnabled({ taskMemoryEnabled: false }), false);
});

// Tested via cfg injection, never the real file — same reasoning as taskMemoryEnabled.
test('subagentsExpandedByDefault defaults to off (collapsed); only an explicit true enables', () => {
  assert.equal(subagentsExpandedByDefault({}), false);
  assert.equal(subagentsExpandedByDefault({ subagentsExpandedByDefault: false }), false);
  assert.equal(subagentsExpandedByDefault({ subagentsExpandedByDefault: true }), true);
});

// Tested via cfg injection, never the real file — same reasoning as taskMemoryEnabled.
test('trustCodexLaunchCwd defaults to on; only an explicit false disables', () => {
  assert.equal(trustCodexLaunchCwd({}), true);
  assert.equal(trustCodexLaunchCwd({ trustCodexLaunchCwd: true }), true);
  assert.equal(trustCodexLaunchCwd({ trustCodexLaunchCwd: false }), false);
});

// Tested via cfg injection, never the real file — same reasoning as taskMemoryEnabled.
test('childFullViewByDefault defaults to off (compact); only an explicit true enables', () => {
  assert.equal(childFullViewByDefault({}), false);
  assert.equal(childFullViewByDefault({ childFullViewByDefault: false }), false);
  assert.equal(childFullViewByDefault({ childFullViewByDefault: true }), true);
});
