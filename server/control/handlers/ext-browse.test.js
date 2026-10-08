import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extBrowseHandler, _setBrowseFetchForTests, EXTENSION_TOPIC } from './ext-browse.js';

function run(fetchImpl) {
  _setBrowseFetchForTests(fetchImpl);
  const replies = [];
  return extBrowseHandler.handler({}, { reply: (o) => replies.push(o) })
    .then(() => replies)
    .finally(() => _setBrowseFetchForTests(null));
}

const ITEM = {
  full_name: 'someone/thing', name: 'thing', owner: { login: 'someone', avatar_url: 'https://avatars.githubusercontent.com/u/1?v=4' },
  description: 'Does a thing', clone_url: 'https://github.com/someone/thing.git', html_url: 'https://github.com/someone/thing',
  stargazers_count: 3, language: 'JavaScript', pushed_at: '2026-10-01T00:00:00Z', private: false,
};

test('searches the topic and passes on only the whitelisted fields', async () => {
  let asked = '';
  const replies = await run(async (url) => { asked = url; return { ok: true, json: async () => ({ items: [ITEM] }) }; });
  assert.ok(asked.includes(encodeURIComponent(`topic:${EXTENSION_TOPIC}`)));
  assert.deepEqual(replies, [{
    type: 'ext-browse-results', topic: EXTENSION_TOPIC,
    repos: [{
      fullName: 'someone/thing', name: 'thing', owner: 'someone', avatarUrl: ITEM.owner.avatar_url,
      description: 'Does a thing', cloneUrl: ITEM.clone_url, htmlUrl: ITEM.html_url, stars: 3, language: 'JavaScript', pushedAt: ITEM.pushed_at,
    }],
  }]);
});

test('drops repos with an unexpected URL and avatars off GitHub\'s host', async () => {
  const odd = { ...ITEM, clone_url: 'ext::sh -c id' };
  const offHost = { ...ITEM, owner: { login: 'x', avatar_url: 'https://evil.invalid/a.png' } };
  const [reply] = await run(async () => ({ ok: true, json: async () => ({ items: [odd, offHost] }) }));
  assert.equal(reply.repos.length, 1);
  assert.equal(reply.repos[0].avatarUrl, '');
});

test('a failure is replied as results with an error, never thrown', async () => {
  const [limited] = await run(async () => ({ ok: false, status: 403 }));
  assert.match(limited.error, /rate limit/);
  assert.deepEqual(limited.repos, []);
  const [down] = await run(async () => { throw new Error('getaddrinfo ENOTFOUND'); });
  assert.match(down.error, /ENOTFOUND/);
});
