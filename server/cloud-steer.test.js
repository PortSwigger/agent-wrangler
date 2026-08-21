import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sendCloudMessage, cloudSteerWins } from './cloud-steer.js';

// A `run` double standing in for the promisified execFile: records the argv it
// was handed and replays a canned result (or throws an execFile-shaped error,
// which carries the captured streams alongside the message).
function runner({ stdout = '{"is_error":false}', stderr = '', fail = null } = {}) {
  const calls = [];
  const run = async (file, args) => {
    calls.push({ file, args });
    if (fail) {
      const err = new Error(fail.message || 'Command failed');
      err.stdout = fail.stdout ?? '';
      err.stderr = fail.stderr ?? '';
      throw err;
    }
    return { stdout, stderr };
  };
  return { run, calls };
}

test('sendCloudMessage runs the steer form through a shell, env-stripped and quoted', async () => {
  const r = runner();
  const res = await sendCloudMessage({ cloudSessionId: 'session_abc123', text: "don't stop", run: r.run });
  assert.deepEqual(res, { ok: true });
  assert.equal(r.calls.length, 1);
  // A shell, because withCleanClaudeEnv's `env -u …` prefix is part of the
  // command STRING and execFile would otherwise look for a binary of that name.
  assert.equal(r.calls[0].file, 'sh');
  assert.equal(r.calls[0].args[0], '-lc');
  const cmd = r.calls[0].args[1];
  assert.match(cmd, /^env -u CLAUDECODE /);
  assert.match(cmd, /claude -p 'don'\\''t stop' --cloud 'session_abc123' --output-format json$/);
});

test('sendCloudMessage refuses before shelling out when the cloud id was never scraped', async () => {
  const r = runner();
  const res = await sendCloudMessage({ cloudSessionId: null, text: 'hi', run: r.run });
  assert.equal(res.ok, false);
  assert.equal(res.archived, false);
  assert.match(res.error, /no session id/i);
  assert.equal(r.calls.length, 0);
});

test('sendCloudMessage reports a non-zero exit using the CLI streams, not the spawn message', async () => {
  const r = runner({ fail: { message: 'Command failed: sh -lc …', stderr: 'Error: session not found' } });
  const res = await sendCloudMessage({ cloudSessionId: 'session_x', text: 'hi', run: r.run });
  assert.equal(res.ok, false);
  assert.equal(res.archived, false);
  assert.match(res.error, /session not found/);
});

test('sendCloudMessage flags an archived cloud session from the CLI text (case-insensitive, either stream)', async () => {
  const viaStderr = await sendCloudMessage({
    cloudSessionId: 'session_x',
    text: 'hi',
    run: runner({ fail: { stderr: 'This session has been ARCHIVED and cannot be resumed' } }).run,
  });
  assert.deepEqual(viaStderr.ok, false);
  assert.equal(viaStderr.archived, true);

  // Same detection when the CLI reports it as a JSON result on a clean exit.
  const viaJson = await sendCloudMessage({
    cloudSessionId: 'session_x',
    text: 'hi',
    run: runner({ stdout: '{"is_error":true,"result":"cloud session is archived"}' }).run,
  });
  assert.equal(viaJson.ok, false);
  assert.equal(viaJson.archived, true);
  assert.match(viaJson.error, /archived/);
});

test('sendCloudMessage treats a non-success JSON result as a failure, a success one as ok', async () => {
  const bad = await sendCloudMessage({
    cloudSessionId: 'session_x', text: 'hi',
    run: runner({ stdout: '{"type":"result","subtype":"error_during_execution"}' }).run,
  });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /error_during_execution/);

  const good = await sendCloudMessage({
    cloudSessionId: 'session_x', text: 'hi',
    run: runner({ stdout: '{"type":"result","subtype":"success","is_error":false,"session_id":"session_x"}' }).run,
  });
  assert.deepEqual(good, { ok: true });
});

test('sendCloudMessage treats an exit-0 non-JSON reply as accepted rather than inventing a failure', async () => {
  const res = await sendCloudMessage({ cloudSessionId: 'session_x', text: 'hi', run: runner({ stdout: 'ok\n' }).run });
  assert.deepEqual(res, { ok: true });
});

// The truth table. The live-create-pane row is the reason this decision is a
// function at all: a cloud card DOES have a live pane for its first seconds.
test('cloudSteerWins: cloud + live create pane while attach is off still steers', () => {
  const entry = { runtime: 'cloud' };
  assert.equal(cloudSteerWins({ entry, tmux: 'cl_abc', attachSupported: false }), true);
});

test('cloudSteerWins truth table', () => {
  const cloud = { runtime: 'cloud' };
  const local = { runtime: undefined };
  const dev = { runtime: 'devcontainer' };

  assert.equal(cloudSteerWins({ entry: cloud, tmux: null, attachSupported: false }), true);
  assert.equal(cloudSteerWins({ entry: cloud, tmux: null, attachSupported: true }), true);
  // Attach on AND a pane: an ordinary live card from here on — paste, don't steer.
  assert.equal(cloudSteerWins({ entry: cloud, tmux: 'cl_abc', attachSupported: true }), false);

  assert.equal(cloudSteerWins({ entry: local, tmux: null, attachSupported: false }), false);
  assert.equal(cloudSteerWins({ entry: local, tmux: 'cc_abc', attachSupported: true }), false);
  assert.equal(cloudSteerWins({ entry: dev, tmux: null, attachSupported: false }), false);
  // A missing entry (archived away mid-flight) must never route to the cloud.
  assert.equal(cloudSteerWins({ entry: null, tmux: null, attachSupported: false }), false);
  assert.equal(cloudSteerWins({ entry: undefined, tmux: null, attachSupported: true }), false);
});
