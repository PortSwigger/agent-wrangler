import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pasteImageHandler } from './paste-image.js';
import { MemoryStore, MEMORY_DIR, addDirFor } from '../../extensions/builtin/task-memory/memory-store.js';
import { launchContext } from '../../extensions/builtin/task-memory/index.js';
import { collectLaunchContext } from '../../launch-context.js';

const memoryStore = new MemoryStore(MEMORY_DIR);
// The launch context the board remembers per session (see paste-store.js): what
// the task-memory extension's hook granted this launch.
const memoryExt = { hooks: { 'session.launchContext': [{ extId: 'task-memory', fn: launchContext }] } };
const grant = (sid, taskId, agent) => collectLaunchContext(
  { sid, task: { id: taskId }, agent, reason: 'adopt' },
  { ext: memoryExt, hostApiFor: () => ({ stores: { taskMemory: memoryStore } }) },
);

// Safe to touch the real filesystem: test-setup.js redirects AW_DATA_DIR (and so
// MEMORY_DIR) to a throwaway per-process temp dir.
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const b64 = PNG.toString('base64');

function ctx(entry) {
  const sent = [];
  return { sent, reply: (o) => sent.push(o), sessionManager: { entryFor: () => entry } };
}

test('paste-image: writes the bytes under the session memory dir and hands back the granted path', async () => {
  const sid = 'sess-paste-1';
  await grant(sid, 'task-A', 'claude');
  const c = ctx({ agent: 'claude' });
  await pasteImageHandler.handler({ type: 'paste-image', sessionId: sid, token: 'g0#1', mime: 'image/png', dataBase64: b64 }, c);

  assert.equal(c.sent.length, 1);
  const r = c.sent[0];
  assert.equal(r.type, 'paste-image-result');
  assert.equal(r.ok, true);
  assert.equal(r.token, 'g0#1', 'the token is echoed so a stale reply can be dropped');
  assert.equal(r.bytes, PNG.length);
  // The path handed to a Claude session is the by-session SYMLINK form, because
  // that is the string --add-dir was given.
  assert.equal(r.path, path.join(addDirFor(sid), 'pastes', r.name));
  // …and it resolves to real bytes on disk through that link.
  assert.deepEqual(fs.readFileSync(r.path), PNG);
  // The write itself landed in the resolved task dir, not beside the symlink.
  const memoryDir = fs.realpathSync(addDirFor(sid));
  assert.deepEqual(fs.readFileSync(path.join(memoryDir, 'pastes', r.name)), PNG);
});

test('paste-image: a codex session gets the REAL path — it rejects a symlinked writable root', async () => {
  const sid = 'sess-paste-codex';
  const { addDirs: [memoryDir] } = await grant(sid, 'task-B', 'codex'); // codex's grant is the resolved real path
  const c = ctx({ agent: 'codex' });
  await pasteImageHandler.handler({ sessionId: sid, mime: 'image/png', dataBase64: b64 }, c);
  const r = c.sent[0];
  assert.equal(r.ok, true);
  assert.equal(r.path, path.join(memoryDir, 'pastes', r.name));
  assert.ok(!r.path.includes('by-session'), 'no symlinked component for codex');
});

test('paste-image: with no extension grant it falls back to a core-owned folder and still writes the bytes', async () => {
  const sid = 'sess-paste-unbound';
  const c = ctx({ agent: 'claude' });
  await pasteImageHandler.handler({ sessionId: sid, mime: 'image/png', dataBase64: b64 }, c);
  const r = c.sent[0];
  assert.equal(r.ok, true);
  assert.deepEqual(fs.readFileSync(r.path), PNG);
});

test('paste-image: refuses an unknown session and an archived one, and writes nothing', async () => {
  const missing = ctx(undefined);
  await pasteImageHandler.handler({ sessionId: 'nope', mime: 'image/png', dataBase64: b64 }, missing);
  assert.equal(missing.sent[0].ok, false);
  assert.match(missing.sent[0].error, /no longer on the board/);

  const archived = ctx({ agent: 'claude', archivedAt: Date.now() });
  await pasteImageHandler.handler({ sessionId: 'gone', mime: 'image/png', dataBase64: b64 }, archived);
  assert.equal(archived.sent[0].ok, false);
  assert.match(archived.sent[0].error, /archived/);
});

test('paste-image: a rejected payload replies with the failure and still echoes the token', async () => {
  const c = ctx({ agent: 'claude' });
  await pasteImageHandler.handler({ sessionId: 'sess-paste-bad', token: 'g3#7', mime: 'text/plain', dataBase64: b64 }, c);
  assert.deepEqual(
    { ok: c.sent[0].ok, token: c.sent[0].token },
    { ok: false, token: 'g3#7' },
  );
});

test('paste-image: the pastes dir is invisible to the memory watcher, so it cannot leak fds', () => {
  // The whole reason this destination is safe to create. watchIgnored must refuse
  // both the folder and anything inside it; widening it would reintroduce the
  // chokidar fd leak it exists to prevent.
  const dir = memoryStore.dir;
  assert.equal(memoryStore.watchIgnored(path.join(dir, 'tasks', 'task-A', 'pastes')), true);
  assert.equal(memoryStore.watchIgnored(path.join(dir, 'tasks', 'task-A', 'pastes', 'paste-1-aa.png')), true);
  assert.equal(memoryStore.watchIgnored(path.join(dir, 'scratch', 'sess-x', 'pastes', 'paste-1-aa.png')), true);
  // …while the one file it does care about is still watched.
  assert.equal(memoryStore.watchIgnored(path.join(dir, 'tasks', 'task-A', 'memory.md')), false);
});

test('paste-image: intoPane pastes the server-built path into the live pane and nowhere else', async () => {
  const sid = 'sess-paste-pane';
  await grant(sid, 'task-P', 'claude');
  const prefilled = [];
  const c = { ...ctx({ agent: 'claude' }), tmuxFor: () => 'cc_pane', socketFor: () => 'sockP', prefillPane: async (...a) => { prefilled.push(a); } };
  await pasteImageHandler.handler({ sessionId: sid, token: 'term#1', intoPane: true, mime: 'image/png', dataBase64: b64 }, c);
  const r = c.sent[0];
  assert.equal(r.ok, true);
  assert.deepEqual(prefilled, [['cc_pane', r.path, 'sockP']]);
  assert.equal(path.dirname(r.path), path.join(addDirFor(sid), 'pastes'));
});

test('paste-image: intoPane with no live pane fails and writes nothing', async () => {
  const sid = 'sess-paste-nopane';
  const c = { ...ctx({ agent: 'claude' }), tmuxFor: () => null, prefillPane: async () => assert.fail('no pane') };
  await pasteImageHandler.handler({ sessionId: sid, token: 'term#2', intoPane: true, mime: 'image/png', dataBase64: b64 }, c);
  assert.equal(c.sent[0].ok, false);
  assert.match(c.sent[0].error, /no live terminal/);
});

test('paste-image: without intoPane nothing is typed into the pane', async () => {
  const c = { ...ctx({ agent: 'claude' }), tmuxFor: () => 'cc_pane', prefillPane: async () => assert.fail('composer pastes are sent with the prompt, not now') };
  await pasteImageHandler.handler({ sessionId: 'sess-paste-chip', mime: 'image/png', dataBase64: b64 }, c);
  assert.equal(c.sent[0].ok, true);
});

test('paste-image: a HEIC is converted before it is written, and only the PNG lands', async () => {
  const heic = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypheic'), Buffer.alloc(8)]);
  const seen = [];
  const c = { ...ctx({ agent: 'claude' }), convertToPng: async (bytes, ext) => { seen.push(ext); return { bytes: PNG, ext: 'png' }; } };
  await pasteImageHandler.handler({ sessionId: 'sess-paste-heic', mime: 'image/heic', dataBase64: heic.toString('base64') }, c);
  const r = c.sent[0];
  assert.equal(r.ok, true);
  assert.deepEqual(seen, ['heic']);
  assert.match(r.name, /\.png$/);
  assert.deepEqual(fs.readFileSync(r.path), PNG);

  const failing = { ...ctx({ agent: 'claude' }), convertToPng: async () => ({ error: 'HEIC images can only be converted on macOS — convert it to PNG first.' }) };
  await pasteImageHandler.handler({ sessionId: 'sess-paste-heic2', mime: 'image/heic', dataBase64: heic.toString('base64') }, failing);
  assert.match(failing.sent[0].error, /only be converted on macOS/);
});

test('paste-image: a staged paste (dispatch dialog) needs no session and lands in the staging dir', async () => {
  const { STAGED_PASTES_DIR } = await import('../../paste-store.js');
  const c = ctx(undefined);
  await pasteImageHandler.handler({ staged: true, token: 'dispatch#0#1', mime: 'image/png', dataBase64: b64 }, c);
  const r = c.sent[0];
  assert.equal(r.ok, true);
  assert.equal(r.staged, true);
  assert.equal(r.sessionId, null);
  assert.equal(path.dirname(r.path), STAGED_PASTES_DIR);
  assert.deepEqual(fs.readFileSync(r.path), PNG);
});
