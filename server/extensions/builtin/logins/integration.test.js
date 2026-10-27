import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-login-home-'));
process.env.HOME = home;
process.on('exit', () => fs.rmSync(home, { recursive: true, force: true }));
const { default: extension } = await import('./index.js');
const { LoginStore } = await import('./login-store.js');
const { loadExtensions, hookPayloadFor, SESSION_HOOKS } = await import('../../index.js');
const { SessionManager } = await import('../../../session-manager.js');
const { collectPrepare } = await import('../../../session-prepare.js');
const { collectLaunchContext } = await import('../../../launch-context.js');
const { buildHostApi } = await import('../../../host-api/index.js');
const { createEventBus } = await import('../../../events.js');
const { runArchiveReview, ARCHIVE_REVIEW_COMPLETED } = await import('../../../archive-review-runner.js');

function fixture(t, enabled = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-login-integration-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new LoginStore(path.join(root, 'logins')); store.add('Personal');
  store.setClaudeToken('personal', 'fixture-token');
  fs.mkdirSync(store.codexHome('personal')); fs.writeFileSync(path.join(store.codexHome('personal'), 'auth.json'), '{}');
  const registry = loadExtensions({ cfg: { extensions: { logins: enabled } }, builtin: [extension] });
  const host = { stores: { logins: store } };
  const options = { ext: registry, hostApiFor: () => host };
  const sm = new SessionManager(); sm.map.clear(); sm._save = () => {}; sm.refreshAlive = async () => {}; sm.killForSession = async () => {};
  sm._ensureClaudeTrust = async () => {}; sm._ensureCodexTrust = async () => {};
  const commands = [];
  sm._newSession = async (_tmux, _cwd, cmd) => { commands.push(cmd); };
  sm._prepare = (p) => collectPrepare(p, options);
  sm._launchContext = (p) => collectLaunchContext(p, options);
  for (const name of SESSION_HOOKS) sm._extHooks[name] = registry.sessionHooks[name].map(({ extId, fn }) => (p) => fn({ ...hookPayloadFor(extId, p), host }));
  const api = buildHostApi({ id: 'launcher', requires: ['sessions:spawn', 'sessions:env'], core: { sessionManager: sm, taskStore: { taskFor: () => null } }, launchContext: sm._launchContext });
  return { sm, api, store, commands, root, options };
}

for (const agent of ['claude', 'codex']) {
  test(`${agent}: host API spawn ext binds a real card, resume and fork retain env, and agent children inherit Default`, async (t) => {
    const { sm, api, store, commands, root } = fixture(t);
    const card = await api.sessions.spawn({ cwd: root, intent: 'fixture', agent, ext: { logins: { login: 'personal' } } });
    assert.equal(store.loginFor(card.sessionId), 'personal');
    const marker = agent === 'claude' ? "CLAUDE_CODE_OAUTH_TOKEN='fixture-token'" : `CODEX_HOME='${store.codexHome('personal')}'`;
    assert.ok(commands[0].includes(marker));
    const liveId = `${card.sessionId}-live`;
    sm.map.get(card.sessionId).liveSessionId = liveId;
    if (agent === 'claude') {
      const bucket = path.join(home, '.claude', 'projects', card.sessionId);
      fs.mkdirSync(bucket, { recursive: true });
      fs.writeFileSync(path.join(bucket, `${liveId}.jsonl`), JSON.stringify({ cwd: root }) + '\n');
    }
    await sm.resume(card.sessionId, root);
    assert.ok(commands[1].includes(marker));
    const fork = await sm.fork({ sourceId: liveId, parentId: card.sessionId, parentEntry: sm.entryFor(card.sessionId), cwd: root });
    assert.ok(commands[2].includes(marker));
    assert.equal(store.loginFor(fork.sessionId), 'personal');
    const child = await sm.dispatch({ cwd: root, agent, spawnedBy: 'default-parent', ext: { logins: { login: 'personal' } } });
    assert.equal(store.loginFor(child.sessionId), null);
    assert.ok(!commands[3].includes(marker));
    store.remove('personal');
    await assert.rejects(sm.resume(card.sessionId, root), /login "Personal" no longer exists/);
    await assert.rejects(sm.fork({ sourceId: liveId, parentId: card.sessionId, parentEntry: sm.entryFor(card.sessionId), cwd: root }), /login "Personal" no longer exists/);
  });

  test(`${agent}: disabling Logins leaves dispatch, resume and fork free of login environment`, async (t) => {
    const { sm, api, store, commands, root } = fixture(t, false);
    const card = await api.sessions.spawn({ cwd: root, intent: 'fixture', agent, ext: { logins: { login: 'personal' } } });
    store.bind(card.sessionId, 'personal');
    const liveId = `${card.sessionId}-live`;
    sm.map.get(card.sessionId).liveSessionId = liveId;
    if (agent === 'claude') {
      const bucket = path.join(home, '.claude', 'projects', card.sessionId);
      fs.mkdirSync(bucket, { recursive: true });
      fs.writeFileSync(path.join(bucket, `${liveId}.jsonl`), JSON.stringify({ cwd: root }) + '\n');
    }
    await sm.resume(card.sessionId, root);
    await sm.fork({ sourceId: liveId, parentId: card.sessionId, parentEntry: sm.entryFor(card.sessionId), cwd: root });
    assert.equal(commands.length, 3);
    for (const cmd of commands) {
      assert.ok(!cmd.includes('fixture-token'));
      assert.ok(!cmd.includes(store.codexHome('personal')));
      assert.ok(!cmd.includes('CLAUDE_CODE_OAUTH_TOKEN='));
      assert.ok(!cmd.includes('CODEX_HOME='));
    }
  });
}

test('archive review uses the mapped Claude token; a Codex-only login skips with a named refusal', async (t) => {
  const { store, sm, options } = fixture(t);
  store.bind('review-card', 'personal');
  const events = createEventBus(); events.on(ARCHIVE_REVIEW_COMPLETED, () => {}, 'memory');
  const calls = []; const logs = [];
  const deps = {
    events, isEnabled: () => true, findTranscriptFn: async () => 'fixture',
    readLinesFn: async () => [{ type: 'user', message: { role: 'user', content: 'Remember this fixture' } }],
    launchContext: (p) => collectLaunchContext(p, options),
    review: async (_text, opts) => { calls.push(opts); return { text: 'NONE', liveSessionId: 'review-live', error: null }; },
    onError: (msg) => logs.push(msg),
  };
  const entry = { agent: 'claude', liveSessionId: 'fixture-live' };
  assert.equal(await runArchiveReview('review-card', entry, { id: 'task' }, deps), 'none');
  assert.deepEqual(calls, [{ env: { CLAUDE_CODE_OAUTH_TOKEN: 'fixture-token' } }]);
  store.forget('personal', 'claude');
  assert.equal(await runArchiveReview('review-card', entry, { id: 'task' }, deps), 'skipped');
  assert.equal(calls.length, 1);
  assert.match(logs[0], /archive review skipped for review-card: login "Personal" has no Claude login/);
  await assert.rejects(sm.dispatch({ cwd: os.tmpdir(), agent: 'claude', spawnedBy: 'review-card' }), /login "Personal" has no Claude login/);
});
