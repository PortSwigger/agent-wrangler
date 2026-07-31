import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withCleanClaudeEnv } from './session-manager.js';

// A wrangler tmux server first started from inside a Claude session keeps
// CLAUDECODE / CLAUDE_CODE_* in its global env; every spawned pane inherits
// them, so the launched claude looks nested and (CLI 2.1.169+) drops its
// transcript — the session then can't be resumed. withCleanClaudeEnv must
// prefix the launch command with `env -u` for each marker so the child is
// seen as top-level and persists its conversation.
test('withCleanClaudeEnv strips CLAUDECODE and the CLAUDE_CODE_* markers', () => {
  const cmd = withCleanClaudeEnv("claude '--session-id' 'abc' 'do the thing'");
  for (const v of [
    'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID',
    'CLAUDE_CODE_EXECPATH', 'CLAUDE_CODE_TMPDIR', 'CLAUDE_JOB_DIR',
  ]) {
    assert.match(cmd, new RegExp(`-u ${v}(\\s|$)`));
  }
});

// The static allowlist goes stale as the CLI adds env vars — CLAUDE_CODE_CHILD_SESSION
// (a newer marker) also suppresses transcript persistence. Strip every inherited
// CLAUDE_CODE_* so a wrangler launched inside a Claude session can't leak any of them.
test('withCleanClaudeEnv strips inherited CLAUDE_CODE_* beyond the static list', () => {
  process.env.CLAUDE_CODE_CHILD_SESSION = '1';
  process.env.CLAUDE_CODE_FUTURE_FLAG = '1';
  try {
    const cmd = withCleanClaudeEnv('claude --foo');
    assert.match(cmd, /-u CLAUDE_CODE_CHILD_SESSION(\s|$)/);
    assert.match(cmd, /-u CLAUDE_CODE_FUTURE_FLAG(\s|$)/);
  } finally {
    delete process.env.CLAUDE_CODE_CHILD_SESSION;
    delete process.env.CLAUDE_CODE_FUTURE_FLAG;
  }
});

test('withCleanClaudeEnv puts env first and leaves the claude command intact', () => {
  const inner = "claude '--resume' 'abc' '--fork-session'";
  const cmd = withCleanClaudeEnv(inner);
  assert.ok(cmd.startsWith('env '), 'must start with the env wrapper');
  assert.ok(cmd.endsWith(inner), 'original command must be preserved verbatim at the end');
});
