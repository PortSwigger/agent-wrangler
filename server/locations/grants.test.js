import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testLocationRuntime, withRuntime, manager } from '../fixtures/location-runtime.js';
import { buildGraph } from '../state-reader.js';
import { requestRepoTool } from '../mcp/tools/request-repo.js';
import { addReposHandler, repoRequestHandler } from '../control/handlers/repos.js';
import { MAX_REPO_REQUESTS } from '../session-manager.js';

// A runtime that records the repos each `open` was handed, as a credential
// proxy limiting what a card reaches would read them.
function recordingRuntime(calls, over = {}) {
  const rt = testLocationRuntime(calls, over);
  const open = rt.location.open;
  rt.location.open = async (args) => { calls.push(['open-repos', args.phase, [...(args.entry?.repos || [])]]); return open(args); };
  return rt;
}

function board(sm) {
  const mail = [];
  const replies = [];
  let rebuilt = 0;
  const mailStore = { append: (to, m) => { mail.push({ to, ...m }); return { id: `m${mail.length}` }; } };
  const ctx = { sessionManager: sm, mailStore, reply: (m) => replies.push(m), rebuild: async () => { rebuilt += 1; } };
  return { ctx, mail, replies, rebuilt: () => rebuilt, deps: { sessionManager: sm, rebuild: ctx.rebuild } };
}

const graphCard = async (sm, id) => (await buildGraph(sm, null, { discover: async () => [], capture: async () => '' })).sessions.find((s) => s.sessionId === id);

test('the human adding a repo to a running card reaches the runtime before the session is told', async () => {
  const calls = [];
  const sm = manager();
  const b = board(sm);
  await withRuntime(recordingRuntime(calls), async () => {
    const { sessionId } = await sm.dispatch({ intent: 'x', runtime: 'testloc', repos: ['acme/widgets'], branch: 'fix-widget' });
    const { sessionId: fork } = await sm.fork({ sourceId: sm.map.get(sessionId).liveSessionId, parentId: sessionId, parentEntry: sm.map.get(sessionId), cwd: '/tmp' });
    const { sessionId: other } = await sm.dispatch({ intent: 'y', runtime: 'testloc', repos: ['acme/widgets'] });
    calls.length = 0;

    await addReposHandler.handler({ type: 'add-repos', sessionId, repos: ['https://github.com/acme/gadgets', 'ACME/widgets'] }, b.ctx);

    assert.deepEqual(calls, [['open-repos', 'repos', ['acme/widgets', 'acme/gadgets']], ['open', { box: 'box-1' }, 'repos']]);
    assert.deepEqual(b.replies, [{ type: 'repos-added', sessionId, added: ['acme/gadgets'] }]);
    assert.deepEqual(sm.map.get(sessionId).repos, ['acme/widgets', 'acme/gadgets']);
    assert.deepEqual(sm.map.get(fork).repos, ['acme/widgets', 'acme/gadgets'], 'a fork shares the location');
    assert.deepEqual(sm.map.get(other).repos, ['acme/widgets'], 'another location is untouched');
    assert.equal(b.mail.length, 1);
    assert.deepEqual([b.mail[0].to, b.mail[0].from, b.mail[0].fromLabel], [sessionId, null, 'Agent Wrangler']);
    assert.match(b.mail[0].body, /^The human added acme\/gadgets to this session/);
    assert.match(b.mail[0].body, /git clone --filter=blob:none https:\/\/github\.com\/acme\/gadgets\.git \/srv\/location-only\/work\/box-1\/gadgets/);
    assert.match(b.mail[0].body, /git switch -c fix-widget/);
    assert.deepEqual((await graphCard(sm, sessionId)).repos, ['acme/widgets', 'acme/gadgets']);
    assert.equal(b.rebuilt(), 1);
  });
});

test('a runtime that refuses the new repos leaves the card as it was and tells the human', async () => {
  const calls = [];
  const sm = manager();
  const b = board(sm);
  let refuse = false;
  const rt = recordingRuntime(calls);
  const open = rt.location.open;
  rt.location.open = async (args) => { if (refuse) throw new Error('proxy is down'); return open(args); };
  await withRuntime(rt, async () => {
    const { sessionId } = await sm.dispatch({ intent: 'x', runtime: 'testloc', repos: ['acme/widgets'] });
    const { sessionId: fork } = await sm.fork({ sourceId: sm.map.get(sessionId).liveSessionId, parentId: sessionId, parentEntry: sm.map.get(sessionId), cwd: '/tmp' });
    refuse = true;
    await addReposHandler.handler({ type: 'add-repos', sessionId, repos: ['acme/gadgets'] }, b.ctx);
    assert.equal(b.replies[0].type, 'error');
    assert.match(b.replies[0].message, /Could not give this session acme\/gadgets: .*proxy is down/);
    assert.deepEqual(sm.map.get(sessionId).repos, ['acme/widgets']);
    assert.deepEqual(sm.map.get(fork).repos, ['acme/widgets']);
    assert.equal(b.mail.length, 0, 'the session is told nothing');
  });
});

test('a suspended card takes the repo at once, and its runtime hears at resume', async () => {
  const calls = [];
  const sm = manager();
  await withRuntime(recordingRuntime(calls), async () => {
    const { sessionId } = await sm.dispatch({ intent: 'x', runtime: 'testloc', repos: ['acme/widgets'] });
    sm.map.get(sessionId).suspendedAt = Date.now();
    calls.length = 0;
    await sm.addLocationRepos(sessionId, ['acme/gadgets']);
    assert.deepEqual(calls, [], 'a suspended location is not started to hear it');
    delete sm.map.get(sessionId).suspendedAt;
    await sm.resume(sessionId, null, {});
    assert.deepEqual(calls.find(([k]) => k === 'open-repos'), ['open-repos', 'resume', ['acme/widgets', 'acme/gadgets']]);
  });
});

test('adding repos is refused on this machine, for an archived card, and for a name clash', async () => {
  const sm = manager();
  await withRuntime(testLocationRuntime(), async () => {
    const { sessionId } = await sm.dispatch({ intent: 'x', runtime: 'testloc', repos: ['acme/widgets'] });
    sm.map.set('HOST', { short: 'h', tmux: 'cc_h', createdAt: 1, cwd: '/a' });
    await assert.rejects(sm.addLocationRepos(sessionId, ['other/widgets']), /already has a repo named "widgets" \(acme\/widgets\)/);
    await assert.rejects(sm.addLocationRepos(sessionId, ['not a repo']), /not a GitHub repo/);
    await assert.rejects(sm.addLocationRepos('HOST', ['acme/x']), /runs on this machine/);
    await assert.rejects(sm.addLocationRepos('NOPE', ['acme/x']), /Unknown session/);
    sm.map.get(sessionId).archivedAt = 1;
    await assert.rejects(sm.addLocationRepos(sessionId, ['acme/x']), /archived/);
  });
});

test('a child asking for A and C from a parent with A and B gets A, and gets C only once the human allows its request_repo', async () => {
  const calls = [];
  const sm = manager();
  const b = board(sm);
  await withRuntime(recordingRuntime(calls), async () => {
    const { sessionId: parent } = await sm.dispatch({ intent: 'x', runtime: 'testloc', repos: ['acme/a', 'acme/b'] });
    const { sessionId: child, withheldRepos } = await sm.dispatch({ intent: 'y', runtime: 'testloc', spawnedBy: parent, repos: ['acme/a', 'acme/c'] });
    assert.deepEqual(sm.map.get(child).repos, ['acme/a']);
    assert.deepEqual(withheldRepos, ['acme/c']);

    calls.length = 0;
    const asked = await requestRepoTool.handler({ deps: b.deps, caller: child }, { repos: ['acme/c', 'acme/a'], why: 'The client lives in acme/c.' });
    assert.deepEqual(asked.structuredContent.request.repos, ['acme/c'], 'a held repo is not asked for');
    assert.deepEqual(sm.map.get(child).repos, ['acme/a'], 'asking adds nothing');
    assert.deepEqual(calls, [], 'the runtime hears nothing until the human answers');
    const waiting = (await graphCard(sm, child)).repoRequests;
    assert.deepEqual(waiting.map((r) => [r.repos, r.why]), [[['acme/c'], 'The client lives in acme/c.']]);
    const again = await requestRepoTool.handler({ deps: b.deps, caller: child }, { repos: ['acme/c'], why: 'again' });
    assert.equal(again.structuredContent.request, null, 'a waiting repo is not asked twice');

    await repoRequestHandler.handler({ type: 'repo-request', sessionId: child, requestId: waiting[0].id, allow: true }, b.ctx);
    assert.deepEqual(sm.map.get(child).repos, ['acme/a', 'acme/c']);
    assert.deepEqual(sm.map.get(parent).repos, ['acme/a', 'acme/b'], 'the parent, at another location, is untouched');
    assert.deepEqual(calls[0], ['open-repos', 'repos', ['acme/a', 'acme/c']]);
    assert.match(b.mail.at(-1).body, /^The human allowed your request and added acme\/c to this session/);
    assert.deepEqual((await graphCard(sm, child)).repoRequests, []);
    await repoRequestHandler.handler({ type: 'repo-request', sessionId: child, requestId: waiting[0].id, allow: true }, b.ctx);
    assert.match(b.replies.at(-1).message, /already been answered/);
  });
});

test('a declined request adds nothing and tells the session; request_repo is refused on this machine and past the cap', async () => {
  const calls = [];
  const sm = manager();
  const b = board(sm);
  await withRuntime(recordingRuntime(calls), async () => {
    const { sessionId } = await sm.dispatch({ intent: 'x', runtime: 'testloc', repos: ['acme/a'] });
    const { request } = sm.requestLocationRepos(sessionId, ['acme/c'], 'why');
    calls.length = 0;
    await repoRequestHandler.handler({ type: 'repo-request', sessionId, requestId: request.id, allow: 'yes' }, b.ctx);
    assert.deepEqual(sm.map.get(sessionId).repos, ['acme/a']);
    assert.deepEqual(calls, []);
    assert.equal(b.mail.at(-1).body, 'The human declined your request for acme/c. Carry on without it, and report anything you could not do because of it.');
    assert.equal(sm.map.get(sessionId).repoRequests, undefined);

    sm.map.set('HOST', { short: 'h', tmux: 'cc_h', createdAt: 1, cwd: '/a' });
    const host = await requestRepoTool.handler({ deps: b.deps, caller: 'HOST' }, { repos: ['acme/c'], why: 'x' });
    assert.equal(host.isError, true);
    assert.match(host.content[0].text, /runs on this machine/);

    for (let i = 0; i < MAX_REPO_REQUESTS; i++) sm.requestLocationRepos(sessionId, [`acme/r${i}`], 'why');
    assert.throws(() => sm.requestLocationRepos(sessionId, ['acme/one-more'], 'why'), /already has 5 requests waiting/);
  });
});

test('a request whose repos the runtime refuses stays waiting', async () => {
  const sm = manager();
  const b = board(sm);
  let refuse = false;
  const rt = testLocationRuntime();
  const open = rt.location.open;
  rt.location.open = async (args) => { if (refuse) throw new Error('nope'); return open(args); };
  await withRuntime(rt, async () => {
    const { sessionId } = await sm.dispatch({ intent: 'x', runtime: 'testloc', repos: ['acme/a'] });
    const { request } = sm.requestLocationRepos(sessionId, ['acme/c'], 'why');
    refuse = true;
    await repoRequestHandler.handler({ type: 'repo-request', sessionId, requestId: request.id, allow: true }, b.ctx);
    assert.match(b.replies.at(-1).message, /nope/);
    assert.deepEqual(sm.map.get(sessionId).repoRequests.map((r) => r.id), [request.id]);
    refuse = false;
    await repoRequestHandler.handler({ type: 'repo-request', sessionId, requestId: request.id, allow: true }, b.ctx);
    assert.deepEqual(sm.map.get(sessionId).repos, ['acme/a', 'acme/c']);
  });
});
