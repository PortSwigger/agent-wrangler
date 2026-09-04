import test from 'node:test';
import assert from 'node:assert/strict';
import { supportsChatView, viewForSession } from './session-view.js';

test('Codex sessions do not offer chat view controls', () => {
  assert.equal(supportsChatView({ sessionId: 'codex-1', agent: 'codex' }), false);
  assert.equal(supportsChatView({ sessionId: 'claude-1', agent: 'claude' }), true);
});

test('Codex sessions always use the terminal despite a saved chat choice', () => {
  assert.equal(viewForSession({ sessionId: 'codex-1', agent: 'codex' }, 'chat', true), 'terminal');
});

test('Claude sessions retain their saved and default view choices', () => {
  assert.equal(viewForSession({ sessionId: 'claude-1', agent: 'claude' }, 'chat', false), 'chat');
  assert.equal(viewForSession({ sessionId: 'claude-2', agent: 'claude' }, null, true), 'chat');
});
