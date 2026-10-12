import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unqueueHandler } from './unqueue.js';

const ESC = '\x1b';
const rule = '─'.repeat(60);
const pane = (...composer) => [`${ESC}[0m⏺ output`, rule, ...composer, rule, '  footer'].join('\n');
const HINT = pane(`${ESC}[39m❯ ${ESC}[2mPress up to edit queued messages${ESC}[0m`);
const PULLED = pane(`${ESC}[39m❯ queued one`, '  queued two');

function ctx({ agent = 'claude', panes = [HINT, PULLED], tmux = 'cc_abc' } = {}) {
  const calls = [];
  const replies = [];
  let n = 0;
  return {
    calls,
    replies,
    sessionFromGraph: () => ({ agent }),
    tmuxFor: () => tmux,
    socketFor: () => 'sock',
    sendKeys: (name, keys) => { calls.push(['keys', ...keys]); },
    capturePaneStyled: async () => panes[Math.min(n++, panes.length - 1)],
    clearComposer: async () => { calls.push(['clear']); },
    reply: (o) => replies.push(o),
    sleep: async () => {},
  };
}

test('pulls every queued prompt back with Up, clears the pane, and returns them line by line', async () => {
  const c = ctx();
  await unqueueHandler.handler({ sessionId: 's', token: 't' }, c);
  assert.deepEqual(c.calls, [['keys', 'Up'], ['clear']]);
  assert.deepEqual(c.replies, [{ type: 'unqueue-result', sessionId: 's', token: 't', text: 'queued one\nqueued two', source: 'pane' }]);
});

test('never sends Up without the queued hint — it would walk the prompt history', async () => {
  const c = ctx({ panes: [pane(`${ESC}[39m❯ `)] });
  await unqueueHandler.handler({ sessionId: 's', token: 't' }, c);
  assert.deepEqual(c.calls, []);
  assert.equal(c.replies[0].source, 'drained');
  assert.equal(c.replies[0].text, null);
});

test('Codex cannot give a queued prompt back', async () => {
  const c = ctx({ agent: 'codex' });
  await unqueueHandler.handler({ sessionId: 's', token: 't' }, c);
  assert.deepEqual(c.calls, []);
  assert.equal(c.replies[0].source, 'unsupported');
});

test('a dormant session has nothing queued', async () => {
  const c = ctx({ tmux: null });
  await unqueueHandler.handler({ sessionId: 's', token: 't' }, c);
  assert.equal(c.replies[0].source, 'drained');
});
