import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseCliArgs } from '../cli-args.js';
import { testLocationRuntime, withRuntime, manager } from '../fixtures/location-runtime.js';
import { runtimeOffer, launchRefusal, localProcessRefusal, runsNothingHere, parseRuntimeIds } from '../runtimes/offer.js';
import { spawnSessionTool } from '../mcp/tools/spawn-session.js';
import { createTerminalTool } from '../mcp/tools/create-terminal.js';
import { restoreSessionTool } from '../mcp/tools/restore-session.js';
import { createShellSession } from '../shell-session.js';
import { runSessionAction } from '../session-action-runner.js';
import { wakeDir } from '../wake-dir.js';

function spawnDeps(sm) {
  return {
    sessionManager: sm,
    taskStore: { taskFor: () => null, assign() {} },
    dispatch: (opts) => sm.dispatch(opts),
    rebuild: async () => {},
    graph: () => ({ sessions: [] }),
    launchWait: { timeoutMs: 0, pollMs: 1 },
  };
}

const MIXED = { picked: null };

async function locationParent(sm) {
  const { sessionId } = await sm.dispatch({ intent: 'parent', runtime: 'testloc', repos: ['acme/widgets'] });
  return sessionId;
}

test('a location session spawning with no runtime gets its parent\'s, through spawn_session and dispatch alike', async () => {
  const sm = manager();
  await withRuntime(testLocationRuntime(), async () => {
    const parent = await locationParent(sm);
    const res = await spawnSessionTool.handler({ deps: spawnDeps(sm), caller: parent }, { intent: 'child', wait: false });
    assert.equal(res.isError, undefined, res.content[0].text);
    const child = sm.map.get(res.structuredContent.sessionId);
    assert.equal(child.runtime, 'testloc');
    assert.deepEqual(child.location, { box: 'box-2' });
    assert.deepEqual(child.repos, ['acme/widgets']);

    const { sessionId } = await sm.dispatch({ intent: 'scheduled child', launchSource: 'schedule', scheduledBy: parent });
    assert.equal(sm.map.get(sessionId).runtime, 'testloc', 'a schedule a location session saved fires at a location');
  });
});

test('a location session spawning with runtime local is refused, on every path that starts a session for it', async () => {
  const sm = manager();
  await withRuntime(testLocationRuntime(), async () => {
    const parent = await locationParent(sm);
    const before = sm.map.size;
    const res = await spawnSessionTool.handler({ deps: spawnDeps(sm), caller: parent }, { intent: 'child', runtime: 'local', wait: false });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /A session at a location starts and wakes sessions only at a location, and "Local \(host\)" runs on this deck's machine/);
    await assert.rejects(sm.dispatch({ intent: 'x', runtime: 'devcontainer', spawnedBy: parent }), /only at a location/);
    await assert.rejects(sm.dispatch({ intent: 'x', runtime: 'local', launchSource: 'schedule', scheduledBy: parent }), /only at a location/);
    assert.equal(sm.map.size, before, 'nothing was created');

    sm.map.set('local-card', { cwd: '/tmp', agent: 'claude', createdAt: new Date().toISOString() });
    const restored = await restoreSessionTool.handler({ deps: { ...spawnDeps(sm), sessionFromGraph: () => null }, caller: parent }, { target: 'local-card' });
    assert.equal(restored.isError, true);
    assert.match(restored.content[0].text, /only at a location/);
    await assert.rejects(sm.resume('local-card', '/tmp', { caller: parent }), /only at a location/);
    await assert.rejects(
      runSessionAction({ kind: 'session', sessionId: 'local-card', message: 'go' }, { sessionManager: sm, tmuxFor: () => null, socketFor: () => '', scheduledBy: parent }),
      /only at a location/,
    );
  });
});

test('a deck with local and a location runtime refuses location dispatch, and says why', async () => {
  const sm = manager();
  const calls = [];
  await withRuntime(testLocationRuntime(calls), async () => {
    const offer = runtimeOffer();
    const loc = offer.find((r) => r.id === 'testloc');
    assert.equal(loc.location, true);
    assert.match(loc.unavailable, /"Test location" runs sessions at a location, which a deck offers only when every runtime it offers does; this one also offers "Local \(host\)", "Devcontainer"/);
    assert.equal(offer.find((r) => r.id === 'local').unavailable, undefined);
    assert.equal(runsNothingHere(), false);
    await assert.rejects(sm.dispatch({ intent: 'x', runtime: 'testloc', repos: ['acme/widgets'] }), /runs sessions at a location, which a deck offers only/);
    assert.deepEqual(calls, [], 'nothing was provisioned');
    const res = await spawnSessionTool.handler({ deps: spawnDeps(sm), caller: null }, { intent: 'x', runtime: 'testloc', repos: ['acme/widgets'], wait: false });
    assert.equal(res.isError, true);
    assert.match(spawnSessionTool.inputSchema.runtime.description, /`testloc` is unavailable: "Test location" runs sessions at a location/);
  }, MIXED);
});

test('an existing location card on a mixed deck is neither resumed, woken nor forked', async () => {
  const sm = manager();
  const calls = [];
  let card;
  await withRuntime(testLocationRuntime(calls), async () => {
    card = await locationParent(sm);
  });
  await withRuntime(testLocationRuntime(calls), async () => {
    calls.length = 0;
    const entry = sm.map.get(card);
    await assert.rejects(sm.resume(card, null, { reason: 'mail', automatic: true }), /which a deck offers only/);
    await assert.rejects(sm.fork({ sourceId: entry.liveSessionId, parentId: card, parentEntry: entry, cwd: '/tmp' }), /which a deck offers only/);
    assert.deepEqual(calls, [], 'the location was not asked to resume');
  }, MIXED);
});

test('a location-only deck dispatches, and refuses local launches and create_terminal', async () => {
  const sm = manager();
  const calls = [];
  await withRuntime(testLocationRuntime(calls), async () => {
    assert.equal(launchRefusal('testloc'), null);
    assert.equal(runsNothingHere(), true);
    const { sessionId } = await sm.dispatch({ intent: 'x', runtime: 'testloc', repos: ['acme/widgets'] });
    assert.equal(sm.map.get(sessionId).runtime, 'testloc');

    await assert.rejects(sm.dispatch({ intent: 'x' }), /This deck doesn't offer the "Local \(host\)" runtime/);
    await assert.rejects(sm.dispatch({ intent: 'x', runtime: 'devcontainer' }), /doesn't offer the "Devcontainer" runtime/);
    const workflow = await spawnSessionTool.handler({ deps: spawnDeps(sm), caller: null }, { intent: 'x', wait: false });
    assert.equal(workflow.isError, true);

    sm.map.set('old-local', { cwd: '/tmp/never-made-here', agent: 'claude', createdAt: new Date().toISOString() });
    await assert.rejects(sm.resume('old-local', '/tmp', {}), /doesn't offer the "Local \(host\)" runtime/);
    assert.equal(await wakeDir(sm.map.get('old-local'), 'old-local', async () => '/tmp/never-made-here'), '/tmp/never-made-here');
    assert.equal(fs.existsSync('/tmp/never-made-here'), false, 'a wake makes no folder for a card it will refuse');

    assert.match(localProcessRefusal(), /starts nothing on its own machine/);
    await assert.rejects(createShellSession(os.tmpdir(), 'aw-test-socket', '/nonexistent/tmux'), /starts nothing on its own machine/);
    const deps = {
      sessionManager: { entryFor: () => ({ cwd: `${os.tmpdir()}` }), socket: 'aw-test-socket' },
      boardClients: () => 1,
      createShellSession: (cwd, socket, command) => createShellSession(cwd, socket, '/nonexistent/tmux', command),
      terminalRegistry: new Map(),
      broadcast() { throw new Error('no terminal should open'); },
    };
    const term = await createTerminalTool.handler({ deps, caller: sessionId }, {});
    assert.equal(term.isError, true);
    assert.match(term.content[0].text, /starts nothing on its own machine/);
  });
});

test('a local-only deck is unchanged: every runtime offered, nothing refused', () => {
  const offer = runtimeOffer({ picked: null });
  assert.deepEqual(offer.map((r) => [r.id, r.location, r.unavailable]), [['local', false, undefined], ['devcontainer', false, undefined]]);
  assert.equal(launchRefusal(undefined, { picked: null }), null);
  assert.equal(launchRefusal('devcontainer', { picked: null }), null);
  assert.equal(localProcessRefusal({ picked: null }), null);
  assert.equal(runsNothingHere({ picked: null }), false);
});

test('a deck picking runtimes hides the rest; a pick whose runtimes are all off offers nothing rather than falling back to local', () => {
  const known = [
    { id: 'local', label: 'Local (host)', location: false },
    { id: 'devcontainer', label: 'Devcontainer', location: false },
  ];
  const onlyLocal = runtimeOffer({ picked: ['local'], known });
  assert.equal(onlyLocal.find((r) => r.id === 'local').unavailable, undefined);
  assert.match(onlyLocal.find((r) => r.id === 'devcontainer').unavailable, /doesn't offer the "Devcontainer" runtime/);
  assert.equal(runsNothingHere({ picked: ['local'], known }), false);

  const gone = runtimeOffer({ picked: ['cloud-box'], known });
  assert.ok(gone.every((r) => r.unavailable));
  assert.equal(runsNothingHere({ picked: ['cloud-box'], known }), true);
  assert.match(launchRefusal('local', { picked: ['cloud-box'], known }), /doesn't offer/);
});

test('the --runtimes value is read as ids, a comma list, or nothing for every runtime', () => {
  assert.equal(parseRuntimeIds(undefined), null);
  assert.equal(parseRuntimeIds(' , '), null);
  assert.deepEqual(parseRuntimeIds('testloc, testloc ,cloud'), ['testloc', 'cloud']);
});

function startDeck(env) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-offer-'));
  const childEnv = { ...process.env, AW_DATA_DIR: dataDir, AW_PORT: '0', ...env };
  if (env.AW_RUNTIMES === undefined) delete childEnv.AW_RUNTIMES;
  try {
    const out = execFileSync(process.execPath, ['--import', fileURLToPath(new URL('../test-setup.js', import.meta.url)), fileURLToPath(new URL('../fixtures/startup-offer-probe.js', import.meta.url))], { env: childEnv, encoding: 'utf8' });
    return JSON.parse(out);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

test('a deck started with --runtimes set to only the test location runtime offers it and refuses local sessions and terminals', () => {
  const { env } = parseCliArgs(['--runtimes', 'testloc']);
  const deck = startDeck(env);
  assert.deepEqual(deck.startup, ['testloc']);
  assert.deepEqual(deck.offer.find((r) => r.id === 'testloc'), { id: 'testloc' });
  assert.match(deck.offer.find((r) => r.id === 'local').unavailable, /doesn't offer the "Local \(host\)" runtime \(the deck's --runtimes startup option, env AW_RUNTIMES\)/);
  assert.deepEqual(deck.testloc, { ok: 'testloc' });
  assert.match(deck.local.refused, /doesn't offer the "Local \(host\)" runtime/);
  assert.match(deck.terminalRefusal, /starts nothing on its own machine \(the deck's --runtimes startup option/);
  assert.match(deck.terminal.refused, /starts nothing on its own machine/);
  assert.deepEqual(deck.offerAfterConfigWrite, deck.offer, 'a config.json deckRuntimes key changes nothing');
});

test('a deck started with no option offers every runtime and launches locally as before', () => {
  const deck = startDeck({ AW_RUNTIMES: undefined });
  assert.equal(deck.startup, null);
  assert.deepEqual(deck.offer.map((r) => r.id), ['local', 'devcontainer', 'testloc']);
  assert.equal(deck.offer.find((r) => r.id === 'local').unavailable, undefined);
  assert.equal(deck.offer.find((r) => r.id === 'devcontainer').unavailable, undefined);
  assert.match(deck.offer.find((r) => r.id === 'testloc').unavailable, /Choose its runtimes with the deck's --runtimes startup option/);
  assert.deepEqual(deck.local, { ok: 'local' });
  assert.match(deck.testloc.refused, /which a deck offers only when every runtime it offers does/);
  assert.equal(deck.terminalRefusal, null);
  assert.deepEqual(deck.offerAfterConfigWrite, deck.offer);
});

test('no API call changes the offer: no control handler, deck action or host API method sets it', async () => {
  const { CONTROL_HANDLERS } = await import('../control/handlers/index.js');
  const { CORE_ACTIONS } = await import('../deck/actions.js');
  const { BOARD_ACTIONS } = await import('../../public/deck-actions.js');
  const types = CONTROL_HANDLERS.map((h) => h.type);
  assert.ok(types.includes('set-default-runtime'));
  assert.deepEqual(types.filter((t) => /runtimes|offer/i.test(t)), []);
  assert.deepEqual(Object.keys(CORE_ACTIONS).filter((t) => /runtimes|offer/i.test(t)), []);
  assert.deepEqual(Object.keys(BOARD_ACTIONS).filter((t) => /runtimes|offer/i.test(t)), []);
  const dir = fileURLToPath(new URL('../host-api/', import.meta.url));
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.js') && !n.endsWith('.test.js') && n !== 'version.js')) {
    assert.doesNotMatch(fs.readFileSync(path.join(dir, f), 'utf8'), /setPickedRuntimes|AW_RUNTIMES|deckRuntimes/, f);
  }
});
