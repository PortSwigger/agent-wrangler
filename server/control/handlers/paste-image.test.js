import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pasteImageHandler } from './paste-image.js';
import { MemoryStore, MEMORY_DIR, addDirFor, resolvedMemoryBindingFor } from '../../memory-store.js';

const memoryStore = new MemoryStore(MEMORY_DIR);

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
  memoryStore.bindSession(sid, 'task-A');
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
  const { memoryDir } = resolvedMemoryBindingFor(sid);
  assert.deepEqual(fs.readFileSync(path.join(memoryDir, 'pastes', r.name)), PNG);
});

test('paste-image: a codex session gets the REAL path — it rejects a symlinked writable root', async () => {
  const sid = 'sess-paste-codex';
  memoryStore.bindSession(sid, 'task-B');
  const c = ctx({ agent: 'codex' });
  await pasteImageHandler.handler({ sessionId: sid, mime: 'image/png', dataBase64: b64 }, c);
  const r = c.sent[0];
  assert.equal(r.ok, true);
  const { memoryDir } = resolvedMemoryBindingFor(sid);
  assert.equal(r.path, path.join(memoryDir, 'pastes', r.name));
  assert.ok(!r.path.includes('by-session'), 'no symlinked component for codex');
});

test('paste-image: falls back to the real path when the session was never bound (no by-session link)', async () => {
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
