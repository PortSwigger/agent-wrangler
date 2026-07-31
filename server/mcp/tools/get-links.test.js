import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getLinksTool } from './get-links.js';

function deps() {
  return {
    taskStore: {
      taskFor: (sid) => (sid === 'CARD1' ? { id: 'T1', name: 'Login' } : null),
      getLinks: (id) => (id === 'T1' ? [{ type: 'jira', key: 'ENT-1', url: 'https://x/ENT-1' }] : []),
    },
    sessionManager: {
      getLinks: (sid) => (sid === 'CARD1' ? [{ type: 'jira', key: 'ENT-9' }] : []),
    },
  };
}

test('get_links returns both scopes by default', async () => {
  const out = await getLinksTool.handler({ deps: deps(), caller: 'CARD1' });
  assert.deepEqual(out.structuredContent.task, { id: 'T1', name: 'Login', links: [{ type: 'jira', key: 'ENT-1', url: 'https://x/ENT-1' }] });
  assert.deepEqual(out.structuredContent.session, { sessionId: 'CARD1', links: [{ type: 'jira', key: 'ENT-9' }] });
});

test('get_links scope=task omits the session block', async () => {
  const out = await getLinksTool.handler({ deps: deps(), caller: 'CARD1' }, { scope: 'task' });
  assert.ok(out.structuredContent.task);
  assert.equal(out.structuredContent.session, undefined);
});

test('get_links with no task yields task:null', async () => {
  const out = await getLinksTool.handler({ deps: deps(), caller: 'NONE' }, { scope: 'task' });
  assert.equal(out.structuredContent.task, null);
});

test('get_links with no caller yields a null session id', async () => {
  const out = await getLinksTool.handler({ deps: deps(), caller: null }, { scope: 'session' });
  assert.deepEqual(out.structuredContent.session, { sessionId: null, links: [] });
});
