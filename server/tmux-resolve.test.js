import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTmuxBin, TmuxNotFoundError } from './tmux-resolve.js';

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

test('tmux absent (exec failure, e.g. command -v itself errors): throws TmuxNotFoundError', async () => {
  const run = async () => ({ err: new Error('exit 1'), stdout: '' });
  await assert.rejects(resolveTmuxBin(run), TmuxNotFoundError);
});

test('error message includes an OS-specific install hint', async () => {
  const run = async () => ({ err: null, stdout: '' });
  await assert.rejects(resolveTmuxBin(run), (err) => {
    const expected = process.platform === 'darwin' ? 'brew install tmux' : 'apt-get install tmux';
    assert.ok(err.message.includes(expected));
    return true;
  });
});
