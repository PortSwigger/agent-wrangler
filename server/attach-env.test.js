import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attachEnv } from './session-manager.js';

// A tmux `attach` inherits the server's env; if the server was started from
// inside a tmux (TMUX/TMUX_PANE set), tmux refuses with "sessions should be
// nested with care, unset $TMUX to force". attachEnv must strip those so the
// spawned client is never seen as nested, however the server was launched.
test('attachEnv strips TMUX and TMUX_PANE from the inherited env', () => {
  const env = attachEnv(
    { TMUX: '/tmp/tmux-501/default,123,69', TMUX_PANE: '%69', FOO: 'bar', PATH: '/usr/bin' },
    '/opt/homebrew/bin',
  );
  assert.equal(env.TMUX, undefined);
  assert.equal(env.TMUX_PANE, undefined);
  assert.equal(env.FOO, 'bar');
});

test('attachEnv prepends the tmux dir to PATH', () => {
  const env = attachEnv({ PATH: '/usr/bin' }, '/opt/homebrew/bin');
  assert.equal(env.PATH, '/opt/homebrew/bin:/usr/bin');
});

test('attachEnv tolerates a missing PATH', () => {
  const env = attachEnv({}, '/opt/homebrew/bin');
  assert.equal(env.PATH, '/opt/homebrew/bin:');
});
