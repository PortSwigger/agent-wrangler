import { test } from 'node:test';
import assert from 'node:assert/strict';
import { removeLinksTool } from './remove-links.js';

// Each store seeds getLinks from `seed` and records the written list on `captured`.
function deps(captured, seed = {}) {
  return {
    taskStore: {
      taskFor: (sid) => (sid === 'CARD1' ? { id: 'T1', name: 'Login' } : null),
      getLinks: () => seed.task ?? [],
      setLinks: (id, links) => { captured.task = { id, links }; return true; },
    },
    sessionManager: {
      getLinks: () => seed.session ?? [],
      setLinks: (sid, links) => { captured.session = { sid, links }; return true; },
    },
  };
}

test('remove_links task scope removes a jira link by key and writes the reduced list', async () => {
  const captured = {};
  const seed = { task: [{ type: 'jira', key: 'ENT-1', url: 'https://co/ENT-1' }, { type: 'jira', key: 'ENT-2', url: 'https://co/ENT-2' }] };
  const out = await removeLinksTool.handler({ deps: deps(captured, seed), caller: 'CARD1' }, { scope: 'task', links: [{ type: 'jira', key: 'ENT-1' }] });
  assert.deepEqual(captured.task, { id: 'T1', links: [{ type: 'jira', key: 'ENT-2', url: 'https://co/ENT-2' }] });
  assert.deepEqual(out.structuredContent.removed, [{ type: 'jira', key: 'ENT-1', url: 'https://co/ENT-1' }]);
  assert.deepEqual(out.structuredContent.links, [{ type: 'jira', key: 'ENT-2', url: 'https://co/ENT-2' }]);
  assert.deepEqual(out.structuredContent.notFound, []);
});

test('remove_links session scope removes by card id', async () => {
  const captured = {};
  const seed = { session: [{ type: 'jira', key: 'ENT-9' }] };
  const out = await removeLinksTool.handler({ deps: deps(captured, seed), caller: 'CARD1' }, { scope: 'session', links: [{ type: 'jira', key: 'ENT-9' }] });
  assert.equal(captured.session.sid, 'CARD1');
  assert.deepEqual(captured.session.links, []);
  assert.deepEqual(out.structuredContent.removed, [{ type: 'jira', key: 'ENT-9' }]);
});

test('remove_links matches a pr by url despite a trailing slash and query', async () => {
  const captured = {};
  const seed = { task: [{ type: 'pr', url: 'https://github.com/a/b/pull/5', repo: 'a/b', number: 5 }] };
  const out = await removeLinksTool.handler({ deps: deps(captured, seed), caller: 'CARD1' }, { scope: 'task', links: [{ type: 'pr', url: 'https://github.com/a/b/pull/5/?foo=1' }] });
  assert.deepEqual(captured.task.links, []);
  assert.deepEqual(out.structuredContent.removed, [{ type: 'pr', url: 'https://github.com/a/b/pull/5', repo: 'a/b', number: 5 }]);
});

test('remove_links partial: one selector matches, the other lands in notFound', async () => {
  const captured = {};
  const seed = { task: [{ type: 'jira', key: 'ENT-1' }, { type: 'jira', key: 'ENT-2' }] };
  const out = await removeLinksTool.handler({ deps: deps(captured, seed), caller: 'CARD1' }, { scope: 'task', links: [{ type: 'jira', key: 'ENT-1' }, { type: 'jira', key: 'NOPE-9' }] });
  assert.deepEqual(out.structuredContent.removed, [{ type: 'jira', key: 'ENT-1' }]);
  assert.deepEqual(out.structuredContent.links, [{ type: 'jira', key: 'ENT-2' }]);
  assert.deepEqual(out.structuredContent.notFound, [{ type: 'jira', key: 'NOPE-9' }]);
});

test('remove_links with no match is not an error and leaves the list unchanged', async () => {
  const captured = {};
  const seed = { task: [{ type: 'jira', key: 'ENT-1' }] };
  const out = await removeLinksTool.handler({ deps: deps(captured, seed), caller: 'CARD1' }, { scope: 'task', links: [{ type: 'jira', key: 'NOPE-9' }] });
  assert.equal(out.isError, undefined);
  assert.deepEqual(out.structuredContent.removed, []);
  assert.deepEqual(out.structuredContent.notFound, [{ type: 'jira', key: 'NOPE-9' }]);
  assert.deepEqual(captured.task.links, [{ type: 'jira', key: 'ENT-1' }]);
});

test('remove_links rejects a selector with neither key nor url', async () => {
  const out = await removeLinksTool.handler({ deps: deps({}), caller: 'CARD1' }, { scope: 'task', links: [{ type: 'jira' }] });
  assert.equal(out.isError, true);
  assert.match(out.content[0].text, /key or url/i);
});

test('remove_links task scope with no task is an error', async () => {
  const out = await removeLinksTool.handler({ deps: deps({}), caller: 'NONE' }, { scope: 'task', links: [{ type: 'jira', key: 'ENT-1' }] });
  assert.equal(out.isError, true);
  assert.match(out.content[0].text, /no task/i);
});

test('remove_links session scope with a null caller is an error', async () => {
  const out = await removeLinksTool.handler({ deps: deps({}), caller: null }, { scope: 'session', links: [{ type: 'jira', key: 'ENT-1' }] });
  assert.equal(out.isError, true);
});

test('remove_links never fires onPrLinksChanged when removing a pr link', async () => {
  const captured = {};
  const seed = { task: [{ type: 'pr', url: 'https://github.com/a/b/pull/5', repo: 'a/b', number: 5 }] };
  const d = deps(captured, seed);
  d.onPrLinksChanged = () => { captured.fired = true; };
  await removeLinksTool.handler({ deps: d, caller: 'CARD1' }, { scope: 'task', links: [{ type: 'pr', url: 'https://github.com/a/b/pull/5' }] });
  assert.equal(captured.fired, undefined);
});
