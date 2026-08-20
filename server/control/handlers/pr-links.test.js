import { test } from 'node:test';
import assert from 'node:assert/strict';
import { linkedPrs, linkedPrForUrl } from './pr-links.js';

function ctx({ sessionLinks = [], taskLinks = [] } = {}) {
  return {
    sessionManager: { getLinks: (sessionId) => (sessionId === 'S1' ? sessionLinks : []) },
    taskStore: {
      taskFor: (sessionId) => (sessionId === 'S1' ? { id: 'T1' } : null),
      getLinks: (taskId) => (taskId === 'T1' ? taskLinks : []),
    },
  };
}

test('linkedPrs: returns PR links from both session and task links', () => {
  const links = linkedPrs('S1', ctx({
    sessionLinks: [{ type: 'pr', url: 'https://github.com/acme/widgets/pull/42' }, { type: 'doc', url: 'x' }],
    taskLinks: [{ type: 'pr', url: 'https://github.com/acme/api/pull/7' }],
  }));
  assert.deepEqual(links, [
    { type: 'pr', url: 'https://github.com/acme/widgets/pull/42' },
    { type: 'pr', url: 'https://github.com/acme/api/pull/7' },
  ]);
});

test('linkedPrForUrl: matches only linked PR URLs', () => {
  const context = ctx({ sessionLinks: [{ type: 'pr', url: 'https://github.com/acme/widgets/pull/42' }] });
  assert.deepEqual(linkedPrForUrl('S1', 'https://github.com/acme/widgets/pull/42', context), {
    type: 'pr',
    url: 'https://github.com/acme/widgets/pull/42',
  });
  assert.equal(linkedPrForUrl('S1', 'https://github.com/acme/widgets/pull/99', context), null);
});

test('linkedPrForUrl: normalizes GitHub PR URLs by repo and number', () => {
  const context = ctx({ sessionLinks: [{ type: 'pr', url: 'https://github.com/acme/widgets/pull/42?notification=1' }] });
  assert.deepEqual(linkedPrForUrl('S1', 'https://github.com/acme/widgets/pull/42/', context), {
    type: 'pr',
    url: 'https://github.com/acme/widgets/pull/42?notification=1',
  });
});
