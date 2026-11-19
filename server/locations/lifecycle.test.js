import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { WORK, testLocationRuntime, withRuntime, manager } from '../fixtures/location-runtime.js';
import { buildGraph } from '../state-reader.js';
import { findUnpushed } from './repos.js';
import { wakeDir } from '../wake-dir.js';
import { locationCodexId } from './index.js';

const settle = () => new Promise((r) => setTimeout(r, 10));
const kinds = (calls) => calls.map(([k]) => k);

test('a remote session is provisioned, launched, suspended when idle, resumed and deleted on archive', async () => {
  const calls = [];
  const sm = manager();
  let hostDir;
  sm._newSession = async (_tmux, dir) => { hostDir = dir; };
  await withRuntime(testLocationRuntime(calls, { suspendIdleHours: 1 }), async () => {
    const { sessionId } = await sm.dispatch({ intent: 'Fix the widget', runtime: 'testloc', branch: 'fix-widget', base: 'main' });
    const entry = sm.map.get(sessionId);
    assert.deepEqual(kinds(calls), ['provision', 'open', 'wrap']);
    assert.equal(calls[0][1].branch, 'fix-widget');
    assert.deepEqual(entry.location, { box: 'box-1' });
    assert.equal(entry.cwd, `${WORK}/box-1`);
    assert.equal(entry.branch, 'fix-widget');
    assert.equal(hostDir, os.homedir(), 'the host pane starts in home');
    assert.equal(fs.existsSync(WORK), false, 'nothing is made on this machine');
    const wrap = calls[2][1];
    assert.deepEqual(wrap.location, { box: 'box-1' });
    assert.match(wrap.inner, /fix-widget.*origin\/main/);

    sm.alive = new Set([entry.tmux]);
    const hour = 60 * 60 * 1000;
    const idle = { sessionId, tmux: entry.tmux, status: 'idle', lastActivity: Date.now() - 2 * hour, label: 'Fix the widget' };
    entry.createdAt = Date.now() - 2 * hour;
    const suspended = await sm.reconcileSuspend([idle], { suspendIdleHours: 8 });
    assert.deepEqual(suspended, [sessionId], 'the location\'s 1h threshold applies, not the install\'s 8h');
    assert.deepEqual(calls.at(-1), ['suspend', { box: 'box-1' }]);
    assert.ok(entry.suspendedAt);
    assert.equal(entry.suspendedCard.aiTitle, 'Fix the widget', 'card values read from the transcript hook before it stopped');
    assert.ok(entry.suspendedCard.usd > 0);

    sm.alive = new Set();
    calls.length = 0;
    await sm.resume(sessionId, '/Users/someone/elsewhere', {});
    assert.deepEqual(kinds(calls), ['resume', 'open', 'wrap']);
    assert.equal(calls[1][2], 'resume');
    assert.equal(sm.map.get(sessionId).cwd, `${WORK}/box-1`, 'a host dir handed to resume is ignored');
    assert.equal(sm.map.get(sessionId).suspendedCard, undefined);

    calls.length = 0;
    sm.archive(sessionId, { reason: 'manual' });
    await settle();
    assert.deepEqual(calls, [['delete', { box: 'box-1' }]]);
    assert.equal(sm.map.get(sessionId).locationDeleted, true);
    await assert.rejects(sm.resume(sessionId, null, {}), /location was deleted when it was archived/);
  });
});

test('a fork shares its parent\'s location, which is never suspended or deleted under it', async () => {
  const calls = [];
  const sm = manager();
  await withRuntime(testLocationRuntime(calls), async () => {
    const { sessionId: parent } = await sm.dispatch({ intent: 'x', runtime: 'testloc' });
    const { sessionId: fork } = await sm.fork({ sourceId: sm.map.get(parent).liveSessionId, parentId: parent, parentEntry: sm.map.get(parent), cwd: '/tmp' });
    assert.deepEqual(sm.map.get(fork).location, sm.map.get(parent).location);
    assert.equal(sm.map.get(fork).cwd, `${WORK}/box-1`);
    assert.deepEqual(calls.filter(([k]) => k === 'resume' || k === 'open').map(([k, , p]) => [k, p]), [['open', 'dispatch'], ['resume', undefined], ['open', 'fork']]);

    calls.length = 0;
    sm.alive = new Set([sm.map.get(fork).tmux]);
    await sm.suspend(parent, { label: 'p' });
    assert.equal(calls.some(([k]) => k === 'suspend'), false, 'the fork\'s pane is alive');

    sm.archive(parent, { reason: 'manual' });
    await settle();
    assert.equal(calls.some(([k]) => k === 'delete'), false, 'the fork still holds the location');

    sm.alive = new Set();
    sm.archive(fork, { reason: 'manual' });
    await settle();
    assert.deepEqual(calls.filter(([k]) => k === 'delete'), [['delete', { box: 'box-1' }]]);
    assert.equal(sm.map.get(parent).locationDeleted, true, 'every card on the deleted location knows');
  });
});

test('a clean exit only suspends the location; forget deletes it; a failed dispatch deletes what it provisioned', async () => {
  const calls = [];
  const sm = manager();
  await withRuntime(testLocationRuntime(calls), async () => {
    const { sessionId } = await sm.dispatch({ intent: 'x', runtime: 'testloc' });
    calls.length = 0;
    sm.archive(sessionId, { reason: 'clean-exit' });
    await settle();
    assert.deepEqual(calls, [['suspend', { box: 'box-1' }]]);
    sm.forget(sessionId);
    await settle();
    assert.deepEqual(calls.at(-1), ['delete', { box: 'box-1' }]);

    calls.length = 0;
    sm._newSession = async () => { throw new Error('tmux refused'); };
    await assert.rejects(sm.dispatch({ intent: 'x', runtime: 'testloc' }), /tmux refused/);
    await settle();
    assert.deepEqual(kinds(calls), ['provision', 'open', 'wrap', 'delete']);
    assert.equal(sm.map.size, 0);
  });
});

test('add_dirs, worktree and a host folder grant are refused at a location before anything is provisioned', async () => {
  const calls = [];
  const sm = manager();
  await withRuntime(testLocationRuntime(calls), async () => {
    await assert.rejects(sm.dispatch({ intent: 'x', runtime: 'testloc', addDirs: [os.tmpdir()] }), /this machine's folders can't be granted/);
    await assert.rejects(sm.dispatch({ intent: 'x', runtime: 'testloc', worktree: true, cwd: '/srv/repo' }), /cannot create a worktree/);
    await assert.rejects(sm.dispatch({ intent: 'x', runtime: 'testloc', cwd: 'relative/dir' }), /absolute path there/);
  });
  assert.deepEqual(calls, []);
  assert.equal(sm.map.size, 0);
});

test('a location session can attach and poll a PR without selecting a repository', async () => {
  const sm = manager();
  await withRuntime(testLocationRuntime(), async () => {
    const { sessionId } = await sm.dispatch({ intent: 'x', runtime: 'testloc' });
    const link = { type: 'pr', url: 'https://github.com/acme/widgets/pull/7' };
    sm.setLinks(sessionId, [link]);
    assert.deepEqual(sm.getLinks(sessionId), [link]);
    assert.deepEqual(sm.prLinks().map((l) => l.url), [link.url]);
  });
});

test('waking a suspended location card creates no directory on the deck', async () => {
  const calls = [];
  const sm = manager();
  await withRuntime(testLocationRuntime(calls), async () => {
    const { sessionId } = await sm.dispatch({ intent: 'x', runtime: 'testloc' });
    await sm.suspend(sessionId, { label: 'x' });
    const entry = sm.map.get(sessionId);
    const dir = await wakeDir(entry, sessionId, () => { throw new Error('host transcript lookup must not run'); });
    assert.equal(dir, `${WORK}/box-1`);
    await sm.resume(sessionId, dir, { reason: 'mail', automatic: true });
    assert.equal(fs.existsSync(WORK), false);
    assert.equal(fs.existsSync('/srv/location-only'), false);
  });
});

test('archive is refused while the location reports unpushed commits; an off-shape answer is an error, not clean', async () => {
  const sm = manager();
  let answer = [{ repo: 'acme/widgets', dir: `${WORK}/box-1/widgets`, commits: [{ sha: 'abc1234', subject: 'wip' }] }];
  await withRuntime(testLocationRuntime([], { unpushed: async () => answer }), async () => {
    const { sessionId } = await sm.dispatch({ intent: 'x', runtime: 'testloc' });
    const check = () => findUnpushed([sessionId], { entryFor: (id) => sm.map.get(id) });
    assert.deepEqual((await check())[0].repos, answer);
    answer = 'nope';
    assert.match((await check())[0].repos[0].error, /answered without a list/);
    answer = [];
    assert.deepEqual(await check(), []);
  });
});

test('Codex at a location takes its conversation id from the hook, shape-checked', async () => {
  let answer = 'not an id!';
  const sm = manager();
  const rt = testLocationRuntime([], { codexId: async () => answer });
  const entry = { runtime: 'testloc', location: { box: 'b' } };
  await withRuntime(rt, async () => {
    assert.equal(await locationCodexId(rt, entry), null);
    answer = '019a2b3c-4d5e-7f00-8a9b-0c1d2e3f4a5b';
    assert.equal(await locationCodexId(rt, entry), answer);
    assert.equal(await locationCodexId(rt, entry, { excludeIds: new Set([answer]) }), null, 'an id another card owns');
    const { sessionId } = await sm.dispatch({ intent: 'x', agent: 'codex', runtime: 'testloc' });
    assert.equal(sm.map.get(sessionId).liveSessionId, answer);
  });
});

test('the graph reads a location card from its hooks, never this machine', async () => {
  const sm = manager();
  await withRuntime(testLocationRuntime(), async () => {
    const { sessionId } = await sm.dispatch({ intent: 'x', runtime: 'testloc', branch: 'fix-widget' });
    await sm.suspend(sessionId, { label: 'x' });
    const graph = await buildGraph(sm, null, { discover: async () => [], capture: async () => '' });
    const card = graph.sessions.find((s) => s.sessionId === sessionId);
    assert.equal(card.branch, 'fix-widget');
    assert.equal(card.repoSlug, null);
    assert.ok(card.usd > 0, 'the suspended card keeps the cost it had');
  });
});

test('set_links accepts a PR from a location session at either scope; name_branch records the branch and hands back the rename', async () => {
  const { setLinksTool } = await import('../mcp/tools/set-links.js');
  const { nameBranchTool } = await import('../mcp/tools/name-branch.js');
  const sm = manager();
  await withRuntime(testLocationRuntime(), async () => {
    const { sessionId } = await sm.dispatch({ intent: 'x', runtime: 'testloc', branch: 'wip' });
    const taskLinks = [];
    const deps = {
      sessionManager: sm,
      taskStore: { taskFor: () => ({ id: 'T1' }), getLinks: () => taskLinks, setLinks: (_id, l) => taskLinks.push(...l) },
      rebuild: async () => {},
    };
    for (const scope of ['session', 'task']) {
      const out = await setLinksTool.handler({ deps, caller: sessionId }, { scope, links: [{ type: 'pr', url: 'https://github.com/other/thing/pull/1' }] });
      assert.notEqual(out.isError, true, scope);
    }
    const ok = await setLinksTool.handler({ deps, caller: sessionId }, { scope: 'session', links: [{ type: 'pr', url: 'https://github.com/acme/widgets/pull/2' }] });
    assert.notEqual(ok.isError, true);

    const renamed = await nameBranchTool.handler({ deps, caller: sessionId }, { name: 'Add CSV export' });
    assert.deepEqual(renamed.structuredContent, { branch: 'add-csv-export' });
    assert.match(renamed.content[0].text, /git branch -m wip add-csv-export/);
    assert.equal(sm.map.get(sessionId).branch, 'add-csv-export');
  });
});
