import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requestRepoTool } from './request-repo.js';

function deps(impl) {
  const seen = { calls: [], rebuilt: 0 };
  return {
    seen,
    sessionManager: {
      requestLocationRepos: (sid, repos, why) => { seen.calls.push({ sid, repos, why }); return impl(sid, repos, why); },
    },
    rebuild: async () => { seen.rebuilt += 1; },
  };
}

test('request_repo asks for the caller card and rebuilds so the human sees it', async () => {
  const d = deps(() => ({ request: { id: 'rr_1', repos: ['acme/a'], why: 'x', at: 1 } }));
  const out = await requestRepoTool.handler({ deps: d, caller: 'CARD1' }, { repos: ['acme/a'], why: 'The API lives there' });
  assert.deepEqual(d.seen.calls, [{ sid: 'CARD1', repos: ['acme/a'], why: 'The API lives there' }]);
  assert.equal(d.seen.rebuilt, 1);
  assert.deepEqual(out.structuredContent.request, { id: 'rr_1', repos: ['acme/a'] });
  assert.match(out.structuredContent.note, /You will get mail when they answer/);
});

test('request_repo says so when nothing was left to ask for, without rebuilding', async () => {
  const d = deps(() => ({ request: null }));
  const out = await requestRepoTool.handler({ deps: d, caller: 'CARD1' }, { repos: ['acme/a'], why: 'x' });
  assert.equal(out.structuredContent.request, null);
  assert.equal(d.seen.rebuilt, 0);
});

test('request_repo passes a refusal back, and needs a caller', async () => {
  const d = deps(() => { throw new Error('This session runs on this machine'); });
  const refused = await requestRepoTool.handler({ deps: d, caller: 'CARD1' }, { repos: ['acme/a'], why: 'x' });
  assert.deepEqual([refused.isError, refused.content[0].text], [true, 'This session runs on this machine']);
  const anonymous = await requestRepoTool.handler({ deps: d, caller: null }, { repos: ['acme/a'], why: 'x' });
  assert.equal(anonymous.isError, true);
  assert.equal(d.seen.calls.length, 1);
});
