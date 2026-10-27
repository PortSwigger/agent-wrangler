import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { refreshMirror, excluded, EXCLUDED } from './codex-mirror.js';

test('mirror links shared entries, refreshes additions, keeps real state and never touches auth or IPC', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-mirror-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'default'); const mirror = path.join(root, 'mirror');
  fs.mkdirSync(source); fs.mkdirSync(mirror);
  for (const name of ['sessions', ...EXCLUDED.filter((n) => n !== 'auth.json'), 'thread-writer-locks']) fs.mkdirSync(path.join(source, name));
  for (const name of ['config.toml', 'state.sqlite', 'auth.json']) fs.writeFileSync(path.join(source, name), 'default');
  fs.writeFileSync(path.join(mirror, 'state.sqlite'), 'local');
  fs.writeFileSync(path.join(mirror, 'auth.json'), 'personal');
  assert.deepEqual(refreshMirror(mirror, source), { linked: ['config.toml', 'sessions'], kept: ['state.sqlite'] });
  for (const name of ['config.toml', 'sessions']) assert.equal(fs.readlinkSync(path.join(mirror, name)), path.join(source, name));
  for (const name of [...EXCLUDED.filter((n) => n !== 'auth.json'), 'thread-writer-locks']) {
    assert.equal(excluded(name), true);
    assert.equal(fs.existsSync(path.join(mirror, name)), false);
  }
  fs.writeFileSync(path.join(source, 'new-file'), 'new');
  assert.deepEqual(refreshMirror(mirror, source).linked, ['new-file']);
  assert.equal(fs.readFileSync(path.join(mirror, 'state.sqlite'), 'utf8'), 'local');
  assert.equal(fs.readFileSync(path.join(mirror, 'auth.json'), 'utf8'), 'personal');
});

test('creates a missing mirror and refuses a missing source', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-mirror-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(refreshMirror(path.join(root, 'new'), process.env.CODEX_HOME), { linked: [], kept: [] });
  assert.throws(() => refreshMirror(path.join(root, 'other'), path.join(root, 'absent')));
});
