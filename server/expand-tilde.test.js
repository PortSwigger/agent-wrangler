import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { expandTilde } from './session-manager.js';

// tmux's `-c` start-directory doesn't expand `~`; an unexpanded path doesn't
// exist, so tmux silently falls back to $HOME — a user-typed `~/vcs/foo` would
// launch in the home dir. dispatch must expand the tilde before it reaches tmux.
test('expandTilde turns ~/vcs/foo into an absolute home-relative path', () => {
  assert.equal(expandTilde('~/vcs/enterprise'), path.join(os.homedir(), 'vcs/enterprise'));
});

test('expandTilde maps a bare ~ to the home dir', () => {
  assert.equal(expandTilde('~'), os.homedir());
});

test('expandTilde leaves absolute paths untouched', () => {
  assert.equal(expandTilde('/Users/you/vcs/project'), '/Users/you/vcs/project');
});

test('expandTilde leaves a mid-path tilde alone (only a leading ~ is a home ref)', () => {
  assert.equal(expandTilde('/tmp/~backup'), '/tmp/~backup');
});
