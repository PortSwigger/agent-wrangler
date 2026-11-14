import { test } from 'node:test';
import assert from 'node:assert/strict';
import { browserTestSkipReason } from './browser-test-policy.js';

test('browser tests run by default outside a Codex sandbox', () => {
  assert.equal(browserTestSkipReason({}), false);
  assert.equal(browserTestSkipReason({ CODEX_SANDBOX: '', CODEX_SANDBOX_NETWORK_DISABLED: '' }), false);
});

test('either Codex sandbox marker skips browser tests with an opt-in explanation', () => {
  for (const env of [{ CODEX_SANDBOX: 'seatbelt' }, { CODEX_SANDBOX_NETWORK_DISABLED: '1' }]) {
    assert.match(browserTestSkipReason(env), /Codex sandbox.*AW_BROWSER_TESTS=1/);
  }
});

test('explicit browser opt-in overrides sandbox detection', () => {
  assert.equal(browserTestSkipReason({ AW_BROWSER_TESTS: '1', CODEX_SANDBOX: 'seatbelt', CODEX_SANDBOX_NETWORK_DISABLED: '1' }), false);
});

test('explicit browser opt-out skips even outside a sandbox', () => {
  for (const env of [{}, { CODEX_SANDBOX: 'seatbelt' }]) {
    assert.match(browserTestSkipReason({ ...env, AW_BROWSER_TESTS: '0' }), /AW_BROWSER_TESTS=0/);
  }
});

test('sandbox browser discovery refuses even an explicitly configured executable', async () => {
  const { findChrome } = await import('./browser-harness.js');
  const keys = ['AW_BROWSER_TESTS', 'CODEX_SANDBOX', 'CODEX_SANDBOX_NETWORK_DISABLED', 'CHROME_BIN'];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    delete process.env.AW_BROWSER_TESTS;
    delete process.env.CODEX_SANDBOX_NETWORK_DISABLED;
    process.env.CODEX_SANDBOX = 'seatbelt';
    process.env.CHROME_BIN = process.execPath;
    assert.equal(findChrome(), null);
    process.env.AW_BROWSER_TESTS = '1';
    assert.equal(findChrome(), process.execPath);
    delete process.env.AW_BROWSER_TESTS;
    delete process.env.CODEX_SANDBOX;
    assert.equal(findChrome(), process.execPath);
    process.env.AW_BROWSER_TESTS = '0';
    assert.equal(findChrome(), null);
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});
