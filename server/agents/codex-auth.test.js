import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readCodexAuthMode, withCodexAuthLaunch, codexAuthAt } from './codex-auth.js';

test('readCodexAuthMode reads only auth_mode and normalises it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cxa-'));
  assert.equal(readCodexAuthMode(dir), null);
  fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: { secret: 'x' } }));
  assert.equal(readCodexAuthMode(dir), 'chatgpt');
  fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'sk-x' }));
  assert.equal(readCodexAuthMode(dir), 'apikey');
});

test('withCodexAuthLaunch appends only when the route changes', () => {
  let l = withCodexAuthLaunch(undefined, 'chatgpt', 1);
  l = withCodexAuthLaunch(l, 'chatgpt', 2);
  l = withCodexAuthLaunch(l, 'apikey', 3);
  assert.deepEqual(l, [{ at: 1, mode: 'chatgpt' }, { at: 3, mode: 'apikey' }]);
});

test('codexAuthAt uses the launch in force at the time, never a later re-login', () => {
  const launches = [{ at: 100, mode: 'chatgpt' }, { at: 200, mode: 'apikey' }];
  assert.equal(codexAuthAt(launches, 150, null), 'chatgpt');
  assert.equal(codexAuthAt(launches, 250, 'business'), 'apikey', 'a launch record outranks checkpoint plan evidence');
  assert.equal(codexAuthAt([], 250, 'business'), 'chatgpt', 'plan evidence covers usage with no launch record');
  assert.equal(codexAuthAt([], 250, null), 'unknown');
});
