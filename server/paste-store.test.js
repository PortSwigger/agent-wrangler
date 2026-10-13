import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pasteDirs, resolvePasteNames } from './paste-store.js';
import { collectLaunchContext, _resetLaunchContextForTests } from './launch-context.js';
import { DATA_DIR } from './data-dir.js';
import { MemoryStore, MEMORY_DIR, addDirFor } from './extensions/builtin/task-memory/memory-store.js';
import { launchContext } from './extensions/builtin/task-memory/index.js';

// test-setup.js redirects AW_DATA_DIR, so MEMORY_DIR is a throwaway temp tree.
const memoryStore = new MemoryStore(MEMORY_DIR);
const GOOD = 'paste-1787651576634-375ec978.png';

// What the real board does at launch/adopt: the task-memory extension's
// session.launchContext hook binds the session and the grant is REMEMBERED by
// launch-context.js, which is where paste-store learns the agent-readable dir.
const memoryExt = {
  hooks: { 'session.launchContext': [{ extId: 'task-memory', fn: launchContext }] },
};
const hostApiFor = () => ({ stores: { taskMemory: memoryStore } });
function grant(sid, taskId, agent = 'claude') {
  return collectLaunchContext({ sid, task: taskId ? { id: taskId } : null, agent, reason: 'adopt' }, { ext: memoryExt, hostApiFor });
}

function seed(sid, taskId, names = [GOOD]) {
  memoryStore.bindSession(sid, taskId);
  return grant(sid, taskId).then(() => {
    const { realDir } = pasteDirs(sid, 'claude');
    fs.mkdirSync(realDir, { recursive: true });
    for (const n of names) fs.writeFileSync(path.join(realDir, n), 'x');
    return realDir;
  });
}

test('pasteDirs: lives under the extension-granted dir; the agent gets the grant as given, writes use the real path', async () => {
  const sid = 'ps-dirs';
  await grant(sid, 'task-dirs');
  const real = fs.realpathSync(addDirFor(sid));
  assert.equal(pasteDirs(sid, 'claude').agentDir, path.join(addDirFor(sid), 'pastes'));
  // Writing always targets the real dir, so nothing depends on the link existing.
  assert.equal(pasteDirs(sid, 'claude').realDir, path.join(real, 'pastes'));
});

test('pasteDirs: a codex grant is already the real path, so the agent is handed that', async () => {
  const sid = 'ps-dirs-codex';
  await grant(sid, 'task-dirs-codex', 'codex');
  const { memoryDir } = memoryStore.bindSession(sid, 'task-dirs-codex');
  assert.equal(pasteDirs(sid, 'codex').agentDir, path.join(memoryDir, 'pastes'));
  assert.ok(!pasteDirs(sid, 'codex').agentDir.includes('by-session'));
});

test('pasteDirs: with no extension granting a dir, pastes go in a core-owned folder', () => {
  _resetLaunchContextForTests();
  const own = path.join(DATA_DIR, 'pastes', 'ps-ungranted');
  assert.deepEqual(pasteDirs('ps-ungranted', 'claude'), { realDir: own, agentDir: own });
});

test('pasteDirs: an unsafe session id never escapes the pastes folder', () => {
  for (const evil of ['../../etc', 'a/b', '..', '']) {
    const { realDir } = pasteDirs(evil, 'claude');
    assert.ok(realDir.startsWith(path.join(DATA_DIR, 'pastes') + path.sep), `${JSON.stringify(evil)} -> ${realDir}`);
    assert.ok(!realDir.includes('..'));
  }
});

test('resolvePasteNames: turns a real name into the agent-facing absolute path', async () => {
  const sid = 'ps-ok';
  await seed(sid, 'task-ok');
  assert.deepEqual(resolvePasteNames(sid, 'claude', [GOOD]), [path.join(addDirFor(sid), 'pastes', GOOD)]);
});

test('resolvePasteNames: a traversal attempt is dropped, never joined into a path', async () => {
  const sid = 'ps-trav';
  await seed(sid, 'task-trav');
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

test('resolvePasteNames: refuses a well-shaped name that is not actually on disk', async () => {
  const sid = 'ps-missing';
  await seed(sid, 'task-missing', []);
  assert.deepEqual(resolvePasteNames(sid, 'claude', ['paste-1-abcd.png']), []);
});

test('resolvePasteNames: cannot reach ANOTHER session paste, even with the right name', async () => {
  await seed('ps-owner', 'task-a');
  await grant('ps-thief', 'task-b');
  assert.deepEqual(resolvePasteNames('ps-thief', 'claude', [GOOD]), []);
});

test('resolvePasteNames: caps the batch and tolerates a non-array', async () => {
  const sid = 'ps-cap';
  const many = Array.from({ length: 20 }, (_, i) => `paste-${1000 + i}-abcdef01.png`);
  await seed(sid, 'task-cap', many);
  assert.equal(resolvePasteNames(sid, 'claude', many).length, 8);
  assert.deepEqual(resolvePasteNames(sid, 'claude', 'not-an-array'), []);
  assert.deepEqual(resolvePasteNames(sid, 'claude', undefined), []);
});

// -- extension-kept images --------------------------------------------------
import { STAGED_PASTES_DIR, keepStagedPaste, readKeptPaste, removeKeptPaste, imageAvailable, claimExtImages } from './paste-store.js';

const stage = (name, body = 'png-bytes') => {
  fs.mkdirSync(STAGED_PASTES_DIR, { recursive: true });
  fs.writeFileSync(path.join(STAGED_PASTES_DIR, name), body);
};

test('keepStagedPaste copies a staged image into the extension\'s own store and leaves the staged file', () => {
  const name = 'paste-1787651576001-aaaa1111.png';
  stage(name);
  assert.equal(keepStagedPaste('ext-a', name), true);
  assert.deepEqual(readKeptPaste('ext-a', name), { mime: 'image/png', bytes: Buffer.from('png-bytes') });
  assert.ok(fs.existsSync(path.join(STAGED_PASTES_DIR, name)));
  assert.equal(readKeptPaste('ext-b', name), null, 'a name only resolves in its owner\'s store');
});

test('keepStagedPaste refuses a name that is not a minted one, or is not staged', () => {
  assert.equal(keepStagedPaste('ext-a', '../../etc/passwd'), false);
  assert.equal(keepStagedPaste('ext-a', 'paste-1-deadbeef.png'), false);
  assert.throws(() => keepStagedPaste('../evil', 'paste-1-deadbeef.png'), /invalid extension id/);
});

test('claimExtImages copies a kept name (so it can seed many sessions) and moves a staged one', () => {
  _resetLaunchContextForTests();
  const kept = 'paste-1787651576002-bbbb2222.png';
  const staged = 'paste-1787651576003-cccc3333.png';
  stage(kept);
  keepStagedPaste('ext-c', kept);
  stage(staged);
  const first = claimExtImages('ext-c', 'ps-claim-1', 'claude', [kept, staged]);
  const second = claimExtImages('ext-c', 'ps-claim-2', 'claude', [kept, staged]);
  assert.equal(first.length, 2);
  assert.ok(fs.existsSync(first[0]) && fs.existsSync(first[1]));
  assert.deepEqual(second.map((p) => path.basename(p)), [kept], 'the staged file was consumed, the kept one was not');
  assert.equal(imageAvailable('ext-c', kept), true);
  assert.equal(imageAvailable('ext-c', staged), false);
  assert.equal(removeKeptPaste('ext-c', kept), true);
  assert.equal(imageAvailable('ext-c', kept), true, 'the staged original is still there until it is pruned');
  fs.rmSync(path.join(STAGED_PASTES_DIR, kept));
  assert.equal(imageAvailable('ext-c', kept), false);
});
