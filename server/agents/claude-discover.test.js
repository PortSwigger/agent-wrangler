import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { discoverClaudeLiveIdAfter } from './claude-discover.js';

function tmpProjects() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ccp-'));
}

// A transcript in the project bucket Claude derives from `cwd` (`/` and `.` → `-`).
function writeTranscript(projectsDir, cwd, uuid, mtimeMs) {
  const bucket = path.join(projectsDir, cwd.replace(/[/.]/g, '-'));
  fs.mkdirSync(bucket, { recursive: true });
  const file = path.join(bucket, `${uuid}.jsonl`);
  fs.writeFileSync(file, `${JSON.stringify({ sessionId: uuid, cwd })}\n`);
  if (mtimeMs) fs.utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
  return file;
}

test('returns the newest transcript in the cwd bucket written after launch', async () => {
  const projectsDir = tmpProjects();
  writeTranscript(projectsDir, '/work/proj', '11111111-1111-1111-1111-111111111111', 3000);
  writeTranscript(projectsDir, '/work/proj', '22222222-2222-2222-2222-222222222222', 9000);
  // A newer conversation in a DIFFERENT cwd must not win.
  writeTranscript(projectsDir, '/work/other', '33333333-3333-3333-3333-333333333333', 20000);
  const id = await discoverClaudeLiveIdAfter({ cwd: '/work/proj', launchedAt: 2000, projectsDir });
  assert.equal(id, '22222222-2222-2222-2222-222222222222');
});

test('ignores a transcript older than launch (minus slop)', async () => {
  const projectsDir = tmpProjects();
  writeTranscript(projectsDir, '/work/proj', '44444444-4444-4444-4444-444444444444', 1000);
  const id = await discoverClaudeLiveIdAfter({ cwd: '/work/proj', launchedAt: 60000, projectsDir });
  assert.equal(id, null);
});

test('the 2s slop window accepts a transcript written just before launchedAt', async () => {
  const projectsDir = tmpProjects();
  // mtime 1.5s BEFORE our recorded launch time — clock/rounding skew, not a stale
  // conversation; the same slop codex-discover.js applies.
  writeTranscript(projectsDir, '/work/proj', '55555555-5555-5555-5555-555555555555', 58500);
  const id = await discoverClaudeLiveIdAfter({ cwd: '/work/proj', launchedAt: 60000, projectsDir });
  assert.equal(id, '55555555-5555-5555-5555-555555555555');
});

test('returns null for an empty bucket and for a bucket that does not exist', async () => {
  const projectsDir = tmpProjects();
  fs.mkdirSync(path.join(projectsDir, '-work-proj'));
  assert.equal(await discoverClaudeLiveIdAfter({ cwd: '/work/proj', launchedAt: 0, projectsDir }), null);
  assert.equal(await discoverClaudeLiveIdAfter({ cwd: '/never/launched', launchedAt: 0, projectsDir }), null);
});

test('ignores nested sub-agent artifacts — only a bucket-root transcript is a conversation', async () => {
  const projectsDir = tmpProjects();
  const bucket = path.join(projectsDir, '-work-proj');
  const sub = path.join(bucket, '66666666-6666-6666-6666-666666666666', 'subagents');
  fs.mkdirSync(sub, { recursive: true });
  const subFile = path.join(sub, '77777777-7777-7777-7777-777777777777.jsonl');
  fs.writeFileSync(subFile, '{}\n');
  fs.utimesSync(subFile, 90, 90);
  assert.equal(await discoverClaudeLiveIdAfter({ cwd: '/work/proj', launchedAt: 0, projectsDir }), null);
});

test('a symlinked cwd finds the bucket keyed on its realpath (macOS /tmp -> /private/tmp)', async () => {
  const projectsDir = tmpProjects();
  const realTarget = fs.mkdtempSync(path.join(os.tmpdir(), 'ccp-real-'));
  const linkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccp-link-'));
  const link = path.join(linkDir, 'proj');
  fs.symlinkSync(realTarget, link);
  // Claude buckets under the cwd it resolved; the wrangler stores the raw path.
  writeTranscript(projectsDir, fs.realpathSync(realTarget), '88888888-8888-8888-8888-888888888888', 5000);
  const id = await discoverClaudeLiveIdAfter({ cwd: link, launchedAt: 900, projectsDir });
  assert.equal(id, '88888888-8888-8888-8888-888888888888');
});
