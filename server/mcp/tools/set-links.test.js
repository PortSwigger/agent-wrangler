import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setLinksTool } from './set-links.js';

function deps(captured) {
  return {
    config: { jiraBaseUrl: () => 'https://co/browse/' },
    taskStore: {
      taskFor: (sid) => (sid === 'CARD1' ? { id: 'T1', name: 'Login' } : null),
      setLinks: (id, links) => { captured.task = { id, links }; return true; },
    },
    sessionManager: {
      setLinks: (sid, links) => { captured.session = { sid, links }; return true; },
    },
  };
}

test('set_links task scope resolves the caller task, fills url from base, returns canonical', async () => {
  const captured = {};
  const out = await setLinksTool.handler({ deps: deps(captured), caller: 'CARD1' }, { scope: 'task', links: [{ type: 'jira', key: 'ENT-1' }] });
  assert.deepEqual(captured.task, { id: 'T1', links: [{ type: 'jira', key: 'ENT-1', url: 'https://co/browse/ENT-1' }] });
  assert.deepEqual(out.structuredContent.links, [{ type: 'jira', key: 'ENT-1', url: 'https://co/browse/ENT-1' }]);
});

test('set_links session scope writes by card id', async () => {
  const captured = {};
  await setLinksTool.handler({ deps: deps(captured), caller: 'CARD1' }, { scope: 'session', links: [{ type: 'jira', key: 'ENT-2' }] });
  assert.equal(captured.session.sid, 'CARD1');
  assert.equal(captured.session.links[0].key, 'ENT-2');
});

test('set_links task scope with no task is an error', async () => {
  const out = await setLinksTool.handler({ deps: deps({}), caller: 'NONE' }, { scope: 'task', links: [] });
  assert.equal(out.isError, true);
  assert.match(out.content[0].text, /no task/i);
});

test('set_links rejects an unknown link type', async () => {
  const out = await setLinksTool.handler({ deps: deps({}), caller: 'CARD1' }, { scope: 'task', links: [{ type: 'github', url: 'https://x' }] });
  assert.equal(out.isError, true);
  assert.match(out.content[0].text, /unknown link type/i);
});

test('set_links accepts a pr link and fires the onPrLinksChanged hook', async () => {
  const captured = {};
  const deps = {
    config: { jiraBaseUrl: () => 'https://co/browse/' },
    taskStore: { taskFor: (sid) => (sid === 'CARD1' ? { id: 'T1', name: 'L' } : null), setLinks: (id, links) => { captured.task = { id, links }; return true; } },
    sessionManager: { setLinks: () => true },
    onPrLinksChanged: (scope, ownerId) => { captured.hook = { scope, ownerId }; },
  };
  const out = await setLinksTool.handler({ deps, caller: 'CARD1' }, { scope: 'task', links: [{ type: 'pr', url: 'https://github.com/a/b/pull/5' }] });
  assert.deepEqual(captured.task.links, [{ type: 'pr', url: 'https://github.com/a/b/pull/5', repo: 'a/b', number: 5 }]);
  assert.deepEqual(captured.hook, { scope: 'task', ownerId: 'T1' });
  assert.deepEqual(out.structuredContent.links[0], { type: 'pr', url: 'https://github.com/a/b/pull/5', repo: 'a/b', number: 5 });
});

test('set_links rejects a non-github pr url with an actionable message', async () => {
  const deps = { config: { jiraBaseUrl: () => '' }, taskStore: { taskFor: () => ({ id: 'T1' }), setLinks: () => true }, sessionManager: { setLinks: () => true } };
  const out = await setLinksTool.handler({ deps, caller: 'CARD1' }, { scope: 'task', links: [{ type: 'pr', url: 'https://example.com/x' }] });
  assert.equal(out.isError, true);
  assert.match(out.content[0].text, /github pull-request url/i);
});

test('set_links does not fire the hook when no pr link is present', async () => {
  const captured = {};
  const deps = {
    config: { jiraBaseUrl: () => 'https://co/browse/' },
    taskStore: { taskFor: () => ({ id: 'T1' }), setLinks: () => true },
    sessionManager: { setLinks: () => true },
    onPrLinksChanged: () => { captured.fired = true; },
  };
  await setLinksTool.handler({ deps, caller: 'CARD1' }, { scope: 'task', links: [{ type: 'jira', key: 'ENT-1' }] });
  assert.equal(captured.fired, undefined);
});
