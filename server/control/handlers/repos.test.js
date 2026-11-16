import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addReposHandler, repoRequestHandler } from './repos.js';

function ctx(sessionManager) {
  const calls = { replies: [], mail: [], rebuild: 0 };
  return {
    calls,
    sessionManager: { entryFor: () => ({ cwd: '/w', repos: ['acme/a', 'acme/b'] }), ...sessionManager },
    mailStore: { append: (to, m) => { calls.mail.push({ to, ...m }); return { id: 'm' }; } },
    reply: (m) => calls.replies.push(m),
    rebuild: async () => { calls.rebuild += 1; },
  };
}

test('add-repos adds, tells the session and replies with what was added', async () => {
  const c = ctx({ addLocationRepos: (sid, repos) => ({ added: repos, repos: ['acme/a', ...repos] }) });
  await addReposHandler.handler({ type: 'add-repos', sessionId: 'S1', repos: ['acme/b'] }, c);
  assert.deepEqual(c.calls.replies, [{ type: 'repos-added', sessionId: 'S1', added: ['acme/b'] }]);
  assert.equal(c.calls.mail[0].to, 'S1');
  assert.equal(c.calls.rebuild, 1);
});

test('add-repos and repo-request reply with the refusal as an error', async () => {
  const c = ctx({
    addLocationRepos: () => { throw new Error('This session runs on this machine'); },
    answerRepoRequest: () => { throw new Error('That request has already been answered.'); },
  });
  await addReposHandler.handler({ type: 'add-repos', sessionId: 'S1', repos: 'acme/b' }, c);
  await repoRequestHandler.handler({ type: 'repo-request', sessionId: 'S1', requestId: 'rr_1', allow: true }, c);
  assert.deepEqual(c.calls.replies, [
    { type: 'error', message: 'This session runs on this machine' },
    { type: 'error', message: 'That request has already been answered.' },
  ]);
  assert.equal(c.calls.rebuild, 2);
});

test('repo-request allows only on an explicit true', async () => {
  const seen = [];
  const c = ctx({ answerRepoRequest: (sid, id, allow) => { seen.push(allow); return { request: { id, repos: ['acme/b'] }, added: allow ? ['acme/b'] : [] }; } });
  await repoRequestHandler.handler({ type: 'repo-request', sessionId: 'S1', requestId: 'rr_1', allow: 'yes' }, c);
  await repoRequestHandler.handler({ type: 'repo-request', sessionId: 'S1', requestId: 'rr_1', allow: true }, c);
  assert.deepEqual(seen, [false, true]);
});
