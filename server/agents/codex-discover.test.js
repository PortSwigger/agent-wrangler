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

test('matches a symlinked cwd against the rollout\'s already-resolved cwd (macOS /tmp -> /private/tmp)', async () => {
  const { root, day } = tmpSessions();
  const realTarget = fs.mkdtempSync(path.join(os.tmpdir(), 'cxs-real-'));
  const linkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cxs-link-'));
  const link = path.join(linkDir, 'proj');
  fs.symlinkSync(realTarget, link);
  // Codex resolves the cwd it actually launched in before recording it — the
  // wrangler's stored entry.cwd (what's queried here) is the raw, unresolved path.
  writeRollout(day, '66666666-6666-6666-6666-666666666666', fs.realpathSync(realTarget), 5000);
  const id = await discoverCodexLiveId({ cwd: link, launchedAt: 900, sessionsDir: root });
  assert.equal(id, '66666666-6666-6666-6666-666666666666');
});

// The failure mode a floor with no slop produces: Codex's rollout filename is
// truncated to the whole SECOND it was minted in (local time), so a session
// that actually launches partway through a second gets a filename timestamp
// that reads as earlier than its own launchedAt. Measured against real
// rollouts, that skew is consistently a few hundred ms, never zero. Without
// slop this excludes the session's own rollout outright — the real failure is
// not "picks the wrong session", it's no live id at all: a blank chat view and
// `_doResume` later refusing with "Could not locate a codex session to resume".
test('a 2s mintedAfter slop tolerates the filename\'s whole-second truncation against the real launch instant', async () => {
  const { root, day } = tmpSessions();
  const uuid = '77777777-7777-7777-7777-777777777777';
  const mintedInstant = new Date(2026, 5, 10, 9, 0, 0).getTime(); // matches writeRollout's fixed 09-00-00 filename
  const launchedAt = mintedInstant + 900; // codex actually launched 900ms into that second
  writeRollout(day, uuid, '/work/proj', launchedAt + 50);

  const withoutSlop = await discoverCodexLiveId({ cwd: '/work/proj', launchedAt, mintedAfter: launchedAt, sessionsDir: root });
  assert.equal(withoutSlop, null, 'no slop wrongly excludes the session\'s own just-minted rollout');

  const withSlop = await discoverCodexLiveId({ cwd: '/work/proj', launchedAt, mintedAfter: launchedAt - 2000, sessionsDir: root });
  assert.equal(withSlop, uuid);
});

test('excludeIds skips a rollout another card already owns, even when it is the best cwd/time match', async () => {
  const { root, day } = tmpSessions();
  const owned = '88888888-8888-8888-8888-888888888888';
  const mine = '99999999-9999-9999-9999-999999999999';
  writeRollout(day, owned, '/work/proj', 6000); // newer mtime — would win without the exclusion
  writeRollout(day, mine, '/work/proj', 5000);
  const id = await discoverCodexLiveId({ cwd: '/work/proj', launchedAt: 900, excludeIds: new Set([owned]), sessionsDir: root });
  assert.equal(id, mine);
});
