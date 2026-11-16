import { test } from 'node:test';
import assert from 'node:assert/strict';
import { browserTestSkipReason } from './browser-test-policy.js';

test('browser tests skip by default with a local opt-in command', () => {
  for (const env of [{}, { CI: '' }, ...['false', 'FALSE', '0', 'no', 'yes'].map((CI) => ({ CI })), { AW_BROWSER_TESTS: 'true' }, { CODEX_SANDBOX: '', CODEX_SANDBOX_NETWORK_DISABLED: '' }]) {
    assert.match(browserTestSkipReason(env), /AW_BROWSER_TESTS=1 npm test/);
  }
});

test('CI runs browser tests unless explicitly disabled', () => {
  for (const CI of ['true', 'TRUE', 'True', '1']) {
    assert.equal(browserTestSkipReason({ CI }), false);
    assert.match(browserTestSkipReason({ CI, AW_BROWSER_TESTS: '0' }), /AW_BROWSER_TESTS=0/);
    assert.equal(browserTestSkipReason({ CI, CODEX_SANDBOX: 'seatbelt', CODEX_SANDBOX_NETWORK_DISABLED: '1' }), false);
  }
});

test('either Codex sandbox marker skips browser tests with an opt-in explanation', () => {
  for (const env of [{ CODEX_SANDBOX: 'seatbelt' }, { CODEX_SANDBOX_NETWORK_DISABLED: '1' }]) {
    assert.match(browserTestSkipReason(env), /Codex sandbox.*AW_BROWSER_TESTS=1/);
  }
});

test('explicit browser opt-in overrides sandbox detection', () => {
  assert.equal(browserTestSkipReason({ AW_BROWSER_TESTS: '1' }), false);
  assert.equal(browserTestSkipReason({ AW_BROWSER_TESTS: '1', CODEX_SANDBOX: 'seatbelt', CODEX_SANDBOX_NETWORK_DISABLED: '1' }), false);
});

test('explicit browser opt-out skips even outside a sandbox', () => {
  for (const env of [{}, { CODEX_SANDBOX: 'seatbelt' }]) {
    assert.match(browserTestSkipReason({ ...env, AW_BROWSER_TESTS: '0' }), /AW_BROWSER_TESTS=0/);
  }
});

test('browser discovery respects policy even with an explicitly configured executable', async () => {
  const { findChrome } = await import('./browser-harness.js');
  const keys = ['CI', 'AW_BROWSER_TESTS', 'CODEX_SANDBOX', 'CODEX_SANDBOX_NETWORK_DISABLED', 'CHROME_BIN'];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    delete process.env.CI;
    delete process.env.AW_BROWSER_TESTS;
    delete process.env.CODEX_SANDBOX_NETWORK_DISABLED;
    process.env.CODEX_SANDBOX = 'seatbelt';
    process.env.CHROME_BIN = process.execPath;
    assert.equal(findChrome(), null);
    process.env.AW_BROWSER_TESTS = '1';
    assert.equal(findChrome(), process.execPath);
    delete process.env.AW_BROWSER_TESTS;
    delete process.env.CODEX_SANDBOX;
    assert.equal(findChrome(), null);
    process.env.CI = 'true';
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
