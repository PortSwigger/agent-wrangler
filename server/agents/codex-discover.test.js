import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { discoverCodexLiveId } from './codex-discover.js';

function tmpSessions() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cxs-'));
  const day = path.join(root, '2026', '06', '10');
  fs.mkdirSync(day, { recursive: true });
  return { root, day };
}

function writeRollout(day, uuid, cwd, mtimeMs) {
  const file = path.join(day, `rollout-2026-06-10T09-00-00-${uuid}.jsonl`);
  fs.writeFileSync(file, JSON.stringify({ type: 'session_meta', payload: { id: uuid, cwd } }) + '\n');
  if (mtimeMs) fs.utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
  return file;
}

test('finds the newest rollout matching cwd after launch time', async () => {
  const { root, day } = tmpSessions();
  writeRollout(day, '11111111-1111-1111-1111-111111111111', '/work/proj', 1000);
  writeRollout(day, '22222222-2222-2222-2222-222222222222', '/work/proj', 5000);
  writeRollout(day, '33333333-3333-3333-3333-333333333333', '/work/other', 6000);
  const id = await discoverCodexLiveId({ cwd: '/work/proj', launchedAt: 900, sessionsDir: root });
  assert.equal(id, '22222222-2222-2222-2222-222222222222');
});

test('returns null when no rollout matches the cwd', async () => {
  const { root, day } = tmpSessions();
  writeRollout(day, '44444444-4444-4444-4444-444444444444', '/somewhere/else', 5000);
  const id = await discoverCodexLiveId({ cwd: '/work/proj', launchedAt: 900, sessionsDir: root });
  assert.equal(id, null);
});

test('ignores rollouts older than launch time (minus slop)', async () => {
  const { root, day } = tmpSessions();
  writeRollout(day, '55555555-5555-5555-5555-555555555555', '/work/proj', 100);
  const id = await discoverCodexLiveId({ cwd: '/work/proj', launchedAt: 60000, sessionsDir: root });
  assert.equal(id, null);
});
