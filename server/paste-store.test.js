import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pasteDirs, resolvePasteNames } from './paste-store.js';
import { MemoryStore, MEMORY_DIR, addDirFor, resolvedMemoryBindingFor } from './memory-store.js';

// test-setup.js redirects AW_DATA_DIR, so MEMORY_DIR is a throwaway temp tree.
const memoryStore = new MemoryStore(MEMORY_DIR);
const GOOD = 'paste-1787651576634-375ec978.png';

function seed(sid, taskId, names = [GOOD]) {
  memoryStore.bindSession(sid, taskId);
  const { realDir } = pasteDirs(sid, 'claude');
  fs.mkdirSync(realDir, { recursive: true });
  for (const n of names) fs.writeFileSync(path.join(realDir, n), 'x');
  return realDir;
}

test('pasteDirs: claude gets the by-session symlink form, codex the resolved real path', () => {
  const sid = 'ps-dirs';
  memoryStore.bindSession(sid, 'task-dirs');
  const { memoryDir } = resolvedMemoryBindingFor(sid);
  assert.equal(pasteDirs(sid, 'claude').agentDir, path.join(addDirFor(sid), 'pastes'));
  assert.equal(pasteDirs(sid, 'codex').agentDir, path.join(memoryDir, 'pastes'));
  // Writing always targets the real dir, so nothing depends on the link existing.
  assert.equal(pasteDirs(sid, 'claude').realDir, path.join(memoryDir, 'pastes'));
});

test('resolvePasteNames: turns a real name into the agent-facing absolute path', () => {
  const sid = 'ps-ok';
  seed(sid, 'task-ok');
  assert.deepEqual(resolvePasteNames(sid, 'claude', [GOOD]), [path.join(addDirFor(sid), 'pastes', GOOD)]);
});

test('resolvePasteNames: a traversal attempt is dropped, never joined into a path', () => {
  const sid = 'ps-trav';
  seed(sid, 'task-trav');
  // Every one of these is a value a frame could send. None may reach a pane.
  const up = '..';
  const evil = [
    [up, up, up, 'etc', 'passwd'].join('/'),
    [up, 'memory.md'].join('/'),
    '/etc/passwd',
    ['paste-1-aa.png', up, up, 'etc', 'passwd'].join('/'),
    `./${GOOD}`,
    `${GOOD} .txt`,
    `${GOOD}\n${GOOD}`,
  ];
  assert.deepEqual(resolvePasteNames(sid, 'claude', evil), []);
});

test('resolvePasteNames: refuses a well-shaped name that is not actually on disk', () => {
  const sid = 'ps-missing';
  seed(sid, 'task-missing', []);
  assert.deepEqual(resolvePasteNames(sid, 'claude', ['paste-1-abcd.png']), []);
});

test('resolvePasteNames: cannot reach ANOTHER session paste, even with the right name', () => {
  seed('ps-owner', 'task-a');
  memoryStore.bindSession('ps-thief', 'task-b');
  assert.deepEqual(resolvePasteNames('ps-thief', 'claude', [GOOD]), []);
});

test('resolvePasteNames: caps the batch and tolerates a non-array', () => {
  const sid = 'ps-cap';
  const many = Array.from({ length: 20 }, (_, i) => `paste-${1000 + i}-abcdef01.png`);
  seed(sid, 'task-cap', many);
  assert.equal(resolvePasteNames(sid, 'claude', many).length, 8);
  assert.deepEqual(resolvePasteNames(sid, 'claude', 'not-an-array'), []);
  assert.deepEqual(resolvePasteNames(sid, 'claude', undefined), []);
});
