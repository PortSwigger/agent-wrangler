import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { watchCloudLaunch, pruneCloudLaunchLogs } from './cloud-launch-watch.js';

// The real interactive-create block, as the CLI prints it into the pane.
const CREATED_LOG = [
  'Creating cloud session…',
  'Created cloud session',
  '  View: https://claude.ai/code/session_AbC123',
  '  Resume with: claude --cloud session_AbC123',
].join('\n');

const noSleep = async () => {};

function fakeManager() {
  const noted = [];
  return { noted, noteCloudSession: (sessionId, payload) => noted.push({ sessionId, ...payload }) };
}

test('watchCloudLaunch records the scraped id and URL from the piped log', async () => {
  const sm = fakeManager();
  const res = await watchCloudLaunch({
    sessionManager: sm, sessionId: 'card', tmux: 'cl_1', logPath: '/log',
    readLog: async () => CREATED_LOG,
    capture: async () => { throw new Error('capture-pane must not be reached while the pipe has bytes'); },
    sleep: noSleep,
  });
  assert.equal(res.cloudSessionId, 'session_AbC123');
  assert.equal(res.url, 'https://claude.ai/code/session_AbC123');
  assert.deepEqual(sm.noted, [{ sessionId: 'card', cloudSessionId: 'session_AbC123', url: 'https://claude.ai/code/session_AbC123' }]);
});

test('watchCloudLaunch falls back to capture-pane while the pipe is still empty', async () => {
  const sm = fakeManager();
  let reads = 0;
  const res = await watchCloudLaunch({
    sessionManager: sm, sessionId: 'card', tmux: 'cl_1', logPath: '/log',
    readLog: async () => { reads += 1; return ''; },
    capture: async () => CREATED_LOG,
    sleep: noSleep,
  });
  assert.equal(res.cloudSessionId, 'session_AbC123');
  assert.ok(reads >= 1);
});

test('watchCloudLaunch reads the self-hosted single JSON line', async () => {
  const sm = fakeManager();
  const res = await watchCloudLaunch({
    sessionManager: sm, sessionId: 'card', tmux: 'cl_1', logPath: '/log',
    readLog: async () => '{"session_id":"session_json1","url":"https://claude.ai/code/session_json1"}',
    sleep: noSleep,
  });
  assert.equal(res.cloudSessionId, 'session_json1');
  assert.equal(sm.noted.length, 1);
});

test('watchCloudLaunch records an attach refusal exactly once and notes no session', async () => {
  const sm = fakeManager();
  let refusals = 0;
  const res = await watchCloudLaunch({
    sessionManager: sm, sessionId: 'card', tmux: 'cl_1', logPath: '/log',
    readLog: async () => 'Attaching to an existing cloud session is not enabled',
    onAttachRefusal: () => { refusals += 1; },
    sleep: noSleep,
  });
  assert.equal(res.attachRefused, true);
  assert.equal(refusals, 1);
  assert.deepEqual(sm.noted, []);
});

test('watchCloudLaunch gives up at its deadline without noting anything', async () => {
  const sm = fakeManager();
  let t = 0;
  const res = await watchCloudLaunch({
    sessionManager: sm, sessionId: 'card', tmux: 'cl_1', logPath: '/log',
    readLog: async () => 'still booting…',
    now: () => { t += 500; return t; },
    deadlineMs: 1500,
    sleep: noSleep,
  });
  assert.equal(res.cloudSessionId, null);
  assert.equal(res.sawCreated, false);
  assert.deepEqual(sm.noted, []);
});

test('watchCloudLaunch swallows a noteCloudSession failure (a scrape must never break a launch)', async () => {
  const res = await watchCloudLaunch({
    sessionManager: { noteCloudSession: () => { throw new Error('boom'); } },
    sessionId: 'card', tmux: 'cl_1', logPath: '/log',
    readLog: async () => CREATED_LOG,
    sleep: noSleep,
  });
  assert.equal(res.cloudSessionId, 'session_AbC123');
});

// An ATTACH is the only launch that can print the refusal line, so it is the only
// one that can move the gate in either direction.
test("mode 'attach' records the refusal and never notes a session id", async () => {
  const sm = fakeManager();
  let refusals = 0;
  let successes = 0;
  const res = await watchCloudLaunch({
    sessionManager: sm, sessionId: 'card', tmux: 'cl_1', logPath: '/log', mode: 'attach',
    readLog: async () => `${CREATED_LOG}\nAttaching to an existing cloud session is not enabled`,
    onAttachRefusal: () => { refusals += 1; },
    onAttachSuccess: () => { successes += 1; },
    sleep: noSleep,
  });
  assert.equal(res.attachRefused, true);
  assert.equal(refusals, 1);
  assert.equal(successes, 0);
  assert.deepEqual(sm.noted, []); // the card already knows its id; nothing to scrape
});

test("mode 'attach' running its whole window without the refusal line clears the flag", async () => {
  const sm = fakeManager();
  let successes = 0;
  let t = 0;
  await watchCloudLaunch({
    sessionManager: sm, sessionId: 'card', tmux: 'cl_1', logPath: '/log', mode: 'attach',
    // The attach echoes a session id — which must NOT end the watch early, or the
    // refusal line (which can follow it) would never be seen.
    readLog: async () => 'Resuming session_AbC123…',
    onAttachSuccess: () => { successes += 1; },
    now: () => { t += 500; return t; },
    deadlineMs: 1500,
    sleep: noSleep,
  });
  assert.equal(successes, 1);
  assert.deepEqual(sm.noted, []);
});

test('pruneCloudLaunchLogs drops only logs past the age cap, and tolerates a missing dir', () => {
  assert.equal(pruneCloudLaunchLogs(path.join(os.tmpdir(), 'aw-no-such-dir-ever')), 0);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-cl-logs-'));
  const old = path.join(dir, 'old.log');
  const fresh = path.join(dir, 'fresh.log');
  fs.writeFileSync(old, 'x');
  fs.writeFileSync(fresh, 'y');
  const weekAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
  fs.utimesSync(old, weekAgo / 1000, weekAgo / 1000);
  assert.equal(pruneCloudLaunchLogs(dir), 1);
  assert.equal(fs.existsSync(old), false);
  assert.equal(fs.existsSync(fresh), true);
  fs.rmSync(dir, { recursive: true, force: true });
});
