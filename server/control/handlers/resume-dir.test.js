import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureLaunchDir } from './resume-dir.js';

test('ensureLaunchDir passes through when the dir exists', () => {
  const sent = [];
  const ok = ensureLaunchDir({ dir: os.tmpdir(), recreateDir: false, reply: (o) => sent.push(o), sessionId: 'S1' });
  assert.equal(ok, true);
  assert.deepEqual(sent, []);
});

test('ensureLaunchDir passes through when no dir is given', () => {
  const sent = [];
  const ok = ensureLaunchDir({ dir: null, recreateDir: false, reply: (o) => sent.push(o), sessionId: 'S1' });
  assert.equal(ok, true);
  assert.deepEqual(sent, []);
});

test('ensureLaunchDir blocks with resume-needs-dir for a missing dir without opt-in', () => {
  const sent = [];
  const missing = path.join(os.tmpdir(), 'aw-no-such-dir-xyz');
  const ok = ensureLaunchDir({ dir: missing, recreateDir: false, reply: (o) => sent.push(o), sessionId: 'S1' });
  assert.equal(ok, false);
  assert.deepEqual(sent, [{ type: 'resume-needs-dir', sessionId: 'S1', dir: missing }]);
});

test('ensureLaunchDir echoes fork params onto the prompt via extra', () => {
  const sent = [];
  const missing = path.join(os.tmpdir(), 'aw-no-such-dir-fork');
  ensureLaunchDir({
    dir: missing, recreateDir: false, reply: (o) => sent.push(o), sessionId: 'S1',
    extra: { action: 'fork', prompt: 'go', name: 'kid' },
  });
  assert.deepEqual(sent, [{ type: 'resume-needs-dir', sessionId: 'S1', dir: missing, action: 'fork', prompt: 'go', name: 'kid' }]);
});

test('ensureLaunchDir recreates a missing dir on explicit opt-in', () => {
  const missing = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-recreate-')) + '/sub';
  const sent = [];
  const ok = ensureLaunchDir({ dir: missing, recreateDir: true, reply: (o) => sent.push(o), sessionId: 'S1' });
  assert.equal(ok, true);
  assert.equal(fs.existsSync(missing), true);
  assert.deepEqual(sent, []);
  fs.rmSync(path.dirname(missing), { recursive: true, force: true });
});
