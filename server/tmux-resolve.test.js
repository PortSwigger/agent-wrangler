import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { resolveTmuxBin, installHint, TmuxNotFoundError } from './tmux-resolve.js';

test('tmux present: returns the resolved absolute path', async () => {
  const run = async () => ({ err: null, stdout: '/opt/homebrew/bin/tmux\n' });
  assert.equal(await resolveTmuxBin(run), '/opt/homebrew/bin/tmux');
});

test('tmux absent (empty stdout): throws TmuxNotFoundError naming the searched PATH', async () => {
  const savedPath = process.env.PATH;
  process.env.PATH = '/usr/bin:/bin';
  try {
    const run = async () => ({ err: null, stdout: '' });
    await assert.rejects(resolveTmuxBin(run), (err) => {
      assert.ok(err instanceof TmuxNotFoundError);
      assert.match(err.message, /\/usr\/bin:\/bin/);
      return true;
    });
  } finally {
    process.env.PATH = savedPath;
  }
});

test('unset PATH reads as <empty>, not a blank "searched: "', async () => {
  const savedPath = process.env.PATH;
  delete process.env.PATH;
  try {
    const run = async () => ({ err: null, stdout: '' });
    await assert.rejects(resolveTmuxBin(run), (err) => {
      assert.match(err.message, /searched: <empty>/);
      return true;
    });
  } finally {
    process.env.PATH = savedPath;
  }
});

test('tmux absent (exec failure, e.g. command -v itself errors): throws TmuxNotFoundError', async () => {
  const run = async () => ({ err: new Error('exit 1'), stdout: '' });
  await assert.rejects(resolveTmuxBin(run), TmuxNotFoundError);
});

test('a resolved non-absolute name (e.g. a shell function/alias override) is rejected', async () => {
  const run = async () => ({ err: null, stdout: 'tmux\n' });
  await assert.rejects(resolveTmuxBin(run), TmuxNotFoundError);
});

test('installHint: darwin gets the brew command, everything else gets apt-get + a distro aside', () => {
  assert.deepEqual(installHint('darwin'), { cmd: 'brew install tmux', note: '' });
  assert.deepEqual(installHint('linux'), { cmd: 'apt-get install tmux', note: " (or your distro's equivalent)" });
});

test("error message backtick-quotes only the pasteable command, matching the README's phrasing", async () => {
  const run = async () => ({ err: null, stdout: '' });
  await assert.rejects(resolveTmuxBin(run), (err) => {
    const { cmd, note } = installHint();
    assert.ok(err.message.includes(`\`${cmd}\`${note}`));
    return true;
  });
});

test("Linux's aside stays outside the backticks even though darwin's happens to look identical either way", () => {
  const { cmd, note } = installHint('linux');
  const wrongWayRoundMessage = `install it with \`${cmd}${note}\` and try again`;
  const rightWayRoundMessage = `install it with \`${cmd}\`${note} and try again`;
  assert.notEqual(wrongWayRoundMessage, rightWayRoundMessage);
});

// A real (unmocked) round trip against the actual `command -v tmux` — everything
// above mocks the runner, so this is the only test that would catch defaultRun's
// {err, stdout} contract drifting (e.g. a rewrite to promisify(execFile), which
// rejects instead of resolving on a non-zero exit) or tmux itself being absent
// on a given machine. tmux-smoke.test.js already hard-requires real tmux with no
// skip guard; this follows the same precedent.
test('real defaultRun: resolves the actual tmux on PATH to an absolute path', async () => {
  const resolved = await resolveTmuxBin();
  assert.ok(path.isAbsolute(resolved));
});

test('real defaultRun: a PATH with no tmux on it throws TmuxNotFoundError, not a raw ENOENT', async () => {
  const savedPath = process.env.PATH;
  process.env.PATH = '/nonexistent';
  try {
    await assert.rejects(resolveTmuxBin(), TmuxNotFoundError);
  } finally {
    process.env.PATH = savedPath;
  }
});
