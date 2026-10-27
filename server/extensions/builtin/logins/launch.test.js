import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LoginStore } from './login-store.js';
import { prepare, launchContext, onBeforeDispatch, onFork, onPurge } from './launch.js';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-login-launch-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new LoginStore(root); store.add('Personal'); store.add('Other');
  fs.writeFileSync(path.join(process.env.CODEX_HOME, 'config.toml'), 'fixture');
  const host = { stores: { logins: store } };
  const give = (agent) => {
    if (agent === 'claude') store.setClaudeToken('personal', 'fixture-token');
    else { fs.mkdirSync(store.codexHome('personal'), { recursive: true }); fs.writeFileSync(path.join(store.codexHome('personal'), 'auth.json'), '{}'); }
  };
  return { store, host, give };
}

for (const agent of ['claude', 'codex']) {
  const provider = agent === 'claude' ? 'Claude' : 'Codex';
  test(`${agent}: dispatch validates provider and runtime; spawned children inherit including Default`, (t) => {
    const { store, host, give } = fixture(t);
    const base = { agent, host, runtime: 'local', ext: { login: 'personal' } };
    assert.equal(prepare({ agent, host }), undefined);
    assert.deepEqual(prepare(base), { abort: `login "Personal" has no ${provider} login` });
    give(agent);
    assert.equal(prepare(base), undefined);
    assert.deepEqual(prepare({ ...base, ownLaunch: true, runtime: 'cloud' }), { abort: 'login "Personal" cannot be used with runtime "cloud"' });
    assert.deepEqual(prepare({ ...base, ext: { login: 'missing' } }), { abort: 'login "missing" no longer exists' });
    store.bind('parent', 'personal');
    assert.equal(prepare({ ...base, spawnedBy: 'parent', ext: { login: 'other' } }), undefined);
    onBeforeDispatch({ ...base, sessionId: 'child', spawnedBy: 'parent', ext: { login: 'other' } });
    assert.equal(store.loginFor('child'), 'personal');
    assert.equal(prepare({ ...base, spawnedBy: 'default-parent', ext: { login: 'other' } }), undefined);
    onBeforeDispatch({ ...base, sessionId: 'default-child', spawnedBy: 'default-parent' });
    assert.equal(store.loginFor('default-child'), null);
    onBeforeDispatch({ ...base, sessionId: 'human' });
    assert.equal(store.loginFor('human'), 'personal');
    onBeforeDispatch({ host, sessionId: 'plain' });
    assert.equal(store.loginFor('plain'), null);
  });

  test(`${agent}: dispatch, resume and fork inject only the bound provider environment`, (t) => {
    const { store, host, give } = fixture(t); give(agent); store.bind('parent', 'personal');
    const expected = agent === 'claude' ? { CLAUDE_CODE_OAUTH_TOKEN: 'fixture-token' } : { CODEX_HOME: store.codexHome('personal') };
    for (const reason of ['dispatch', 'resume', 'fork']) {
      const args = { host, agent, reason, sid: reason === 'fork' ? 'child' : 'parent', parentId: reason === 'fork' ? 'parent' : undefined };
      assert.deepEqual(launchContext(args), { env: expected });
      assert.deepEqual(launchContext({ host, agent, reason, sid: 'unmapped', parentId: 'default' }), {});
    }
    if (agent === 'codex') assert.equal(fs.readlinkSync(path.join(store.codexHome('personal'), 'config.toml')), path.join(process.env.CODEX_HOME, 'config.toml'));
    onFork({ sessionId: 'child', parentId: 'parent', host });
    assert.equal(store.loginFor('child'), 'personal');
    onPurge({ sessionId: 'child', host });
    assert.equal(store.loginFor('child'), null);
  });

  test(`${agent}: removal and forgotten credentials refuse dispatch, resume, fork and headless`, (t) => {
    const { store, host, give } = fixture(t); give(agent); store.bind('parent', 'personal');
    store.forget('personal', agent);
    assert.deepEqual(prepare({ host, agent, spawnedBy: 'parent' }), { abort: `login "Personal" has no ${provider} login` });
    for (const reason of ['resume', 'fork', 'headless']) {
      assert.deepEqual(launchContext({ host, agent, reason, sid: reason === 'fork' ? 'child' : 'parent', parentId: 'parent' }), { refuse: `login "Personal" has no ${provider} login` });
    }
    store.remove('personal');
    assert.deepEqual(prepare({ host, agent, spawnedBy: 'parent' }), { abort: 'login "Personal" no longer exists' });
    for (const reason of ['resume', 'fork']) assert.deepEqual(launchContext({ host, agent, reason, sid: reason === 'fork' ? 'child' : 'parent', parentId: 'parent' }), { refuse: 'login "Personal" no longer exists' });
  });
}

test('headless resolves card before ext, refuses Codex-only Claude review, uses ext without a mapping', (t) => {
  const { store, host, give } = fixture(t); give('claude'); store.bind('card', 'personal');
  assert.deepEqual(launchContext({ host, sid: 'card', agent: 'claude', reason: 'headless', ext: { login: 'other' } }), { env: { CLAUDE_CODE_OAUTH_TOKEN: 'fixture-token' } });
  for (const sid of [null, 'unmapped']) assert.deepEqual(launchContext({ host, sid, agent: 'claude', reason: 'headless', ext: { login: 'personal' } }), { env: { CLAUDE_CODE_OAUTH_TOKEN: 'fixture-token' } });
  assert.deepEqual(launchContext({ host, sid: null, agent: 'claude', reason: 'headless' }), {});
  store.forget('personal', 'claude'); give('codex');
  assert.deepEqual(launchContext({ host, sid: 'card', agent: 'claude', reason: 'headless' }), { refuse: 'login "Personal" has no Claude login' });
});

test('empty or unreadable token, corrupt bindings and mirror errors fail closed', (t) => {
  const { store, host, give } = fixture(t); give('claude'); store.bind('card', 'personal');
  fs.writeFileSync(store.claudeTokenPath('personal'), '');
  assert.match(launchContext({ host, sid: 'card', agent: 'claude' }).refuse, /login "Personal": .*Claude token/);
  fs.rmSync(store.claudeTokenPath('personal')); fs.mkdirSync(store.claudeTokenPath('personal'));
  assert.match(launchContext({ host, sid: 'card', agent: 'claude' }).refuse, /Claude token/);
  give('codex');
  fs.rmSync(path.join(store.codexHome('personal'), 'auth.json'));
  fs.rmSync(store.codexHome('personal'), { recursive: true });
  fs.writeFileSync(store.codexHome('personal'), 'not a directory');
  assert.ok(launchContext({ host, sid: 'card', agent: 'codex' }).refuse);
  fs.writeFileSync(path.join(store.root, 'sessions.json'), '{broken');
  assert.ok(launchContext({ host, sid: 'card', agent: 'claude' }).refuse);
  assert.ok(prepare({ host, spawnedBy: 'card', agent: 'claude' }).abort);
});

test('a binding write failure refuses dispatch and fork instead of losing the login', (t) => {
  const { store, host, give } = fixture(t); give('claude'); store.bind('parent', 'personal');
  store.bind = () => { throw new Error('binding write failed'); };
  try { onBeforeDispatch({ host, sessionId: 'new', ext: { login: 'personal' } }); } catch {}
  assert.match(launchContext({ host, sid: 'new', reason: 'dispatch', agent: 'claude' }).refuse, /binding write failed/);
  assert.match(launchContext({ host, sid: 'fork', parentId: 'parent', reason: 'fork', agent: 'claude' }).refuse, /binding write failed/);
});

test('a transient lineage read failure cannot turn a spawned login into Default', (t) => {
  const { store, host, give } = fixture(t); give('claude'); store.bind('parent', 'personal');
  const original = store.loginFor.bind(store);
  let first = true;
  store.loginFor = (sid) => { if (first) { first = false; throw new Error('binding read failed'); } return original(sid); };
  try { onBeforeDispatch({ host, sessionId: 'child', spawnedBy: 'parent' }); } catch {}
  assert.match(launchContext({ host, sid: 'child', reason: 'dispatch', agent: 'claude' }).refuse, /binding read failed/);
});
