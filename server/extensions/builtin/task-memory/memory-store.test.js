import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MemoryStore } from './memory-store.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aw-memory-'));
}

test('bindSession creates the task folder and links to it (relative dir symlink)', () => {
  const dir = tmpDir();
  const store = new MemoryStore(dir);
  const binding = store.bindSession('s1', 't_a');
  const link = store.linkPath('s1');
  assert.equal(fs.readlinkSync(link), path.join('..', 'tasks', 't_a'));
  assert.ok(fs.existsSync(store.taskPath('t_a'))); // memory.md touched
  // The link resolves to the task's real folder, and writes through it land in
  // the canonical task file.
  assert.equal(fs.realpathSync(link), fs.realpathSync(store.taskDir('t_a')));
  assert.deepEqual(binding, {
    memoryDir: fs.realpathSync(store.taskDir('t_a')),
    memoryPath: path.join(fs.realpathSync(store.taskDir('t_a')), 'memory.md'),
  });
  fs.writeFileSync(path.join(link, 'memory.md'), 'via link');
  assert.equal(store.read('t_a'), 'via link');
});

test('rebinding to a new task repoints the link; idempotent rebind is a no-op', () => {
  const dir = tmpDir();
  const store = new MemoryStore(dir);
  store.bindSession('s1', 't_a');
  store.bindSession('s1', 't_b');
  assert.equal(fs.readlinkSync(store.linkPath('s1')), path.join('..', 'tasks', 't_b'));
  // Idempotent: same target leaves the same link in place (no throw, still valid).
  store.bindSession('s1', 't_b');
  assert.equal(fs.readlinkSync(store.linkPath('s1')), path.join('..', 'tasks', 't_b'));
});

test('bindSession(null) links to the session scratch folder (a real dir)', () => {
  const dir = tmpDir();
  const store = new MemoryStore(dir);
  store.bindSession('s1', null);
  assert.equal(fs.readlinkSync(store.linkPath('s1')), path.join('..', 'scratch', 's1'));
  assert.ok(fs.existsSync(store.scratchPath('s1')));
  fs.writeFileSync(path.join(store.linkPath('s1'), 'memory.md'), 'via link');
  assert.equal(fs.readFileSync(store.scratchPath('s1'), 'utf8'), 'via link');
});

test('read/write round-trip; read of an absent task is empty', () => {
  const dir = tmpDir();
  const store = new MemoryStore(dir);
  assert.equal(store.read('t_a'), '');
  store.write('t_a', '# hello\n');
  assert.equal(store.read('t_a'), '# hello\n');
});

test('hasMemory is false for empty/whitespace, true for content', () => {
  const dir = tmpDir();
  const store = new MemoryStore(dir);
  assert.equal(store.hasMemory('t_a'), false);
  store.write('t_a', '   \n\t ');
  assert.equal(store.hasMemory('t_a'), false);
  store.write('t_a', 'real');
  assert.equal(store.hasMemory('t_a'), true);
});

test('forget removes the symlink and scratch folder', () => {
  const dir = tmpDir();
  const store = new MemoryStore(dir);
  store.bindSession('s1', null);
  assert.ok(fs.existsSync(store.scratchPath('s1')));
  store.forget('s1');
  assert.equal(fs.existsSync(store.scratchDir('s1')), false);
  assert.throws(() => fs.readlinkSync(store.linkPath('s1')));
});

test('taskIdForFile maps tasks/<taskId>/memory.md only, not by-session/ or scratch/', () => {
  const dir = tmpDir();
  const store = new MemoryStore(dir);
  assert.equal(store.taskIdForFile(store.taskPath('t_a')), 't_a');
  assert.equal(store.taskIdForFile(store.linkPath('s1')), null); // by-session symlink dir
  assert.equal(store.taskIdForFile(store.scratchPath('s1')), null);
  assert.equal(store.taskIdForFile(path.join(store.taskDir('t_a'), 'extra.md')), null); // not memory.md
  assert.equal(store.taskIdForFile(path.join(dir, 'memory.json')), null);
  assert.equal(store.taskIdForFile('/elsewhere/tasks/t_a/memory.md'), null);
});

test('watchIgnored watches only tasks/<taskId>/memory.md — scratch/, by-session/ and task subfiles are skipped', () => {
  const dir = tmpDir();
  const store = new MemoryStore(dir);
  // Watched (must NOT be ignored, or new tasks/memory go undetected):
  assert.equal(store.watchIgnored(dir), false);                     // the watched root
  assert.equal(store.watchIgnored(path.join(dir, 'tasks')), false); // tasks/ (to see new task dirs)
  assert.equal(store.watchIgnored(store.taskDir('t_a')), false);    // tasks/<id>/ (to see memory.md appear)
  assert.equal(store.watchIgnored(store.taskPath('t_a')), false);   // tasks/<id>/memory.md
  // Ignored — these are the fd-leak sources (one chokidar fd each, growing forever):
  assert.equal(store.watchIgnored(store.scratchDir('s1')), true);
  assert.equal(store.watchIgnored(store.scratchPath('s1')), true);  // 74 scratch memory.md were watched for nothing
  assert.equal(store.watchIgnored(store.linkPath('s1')), true);     // by-session/<id> symlink
  assert.equal(store.watchIgnored(path.join(store.taskDir('t_a'), 'brief.md')), true);      // non-memory.md file
  assert.equal(store.watchIgnored(path.join(store.taskDir('t_a'), 'sdd')), true);           // task subdir
  assert.equal(store.watchIgnored(path.join(store.taskDir('t_a'), 'sdd', 'x.md')), true);   // deeper
});

test('rejects path-traversal ids — nothing escapes the memory dir', () => {
  const dir = tmpDir();
  const store = new MemoryStore(dir);
  const evil = path.join('..', '..', 'evil'); // e.g. "../../evil"
  // read/write/hasMemory are no-ops for an unsafe id and never touch disk outside.
  store.write(evil, 'pwned');
  assert.equal(store.read(evil), '');
  assert.equal(store.hasMemory(evil), false);
  assert.equal(fs.existsSync(path.join(dir, '..', '..', 'evil', 'memory.md')), false);
  // An unsafe taskId binds to scratch rather than a traversed folder.
  store.bindSession('s1', evil);
  assert.equal(fs.readlinkSync(store.linkPath('s1')), path.join('..', 'scratch', 's1'));
  // An unsafe sessionId is refused outright (no symlink, no recursive remove).
  store.bindSession(evil, 't_a');
  assert.throws(() => fs.readlinkSync(store.linkPath(evil)));
  store.forget(evil); // no throw, no-op
});
