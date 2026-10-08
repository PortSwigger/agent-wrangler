import test from 'node:test';
import assert from 'node:assert/strict';
import { CAPABILITIES, CLIENT_CAPABILITIES } from '../extensions/index.js';
import { buildHostApi, buildExtSettings } from './index.js';
import { V1_BUILDERS, usdByCard } from './v1.js';
import { HOST_API_VERSION } from './version.js';
import { _resetUsageCache } from '../usage-scan-memo.js';
import { createEventBus } from '../events.js';

const ALWAYS = ['id', 'version', 'stores', 'settings', 'log'];

function wiring(overrides = {}) {
  return {
    core: {
      sessionManager: {
        activeEntries: () => [{ sessionId: 'c1', cwd: '/a', liveSessionId: 'uuid' }],
        entryFor: (id) => (id === 'c1' ? { cwd: '/a', liveSessionId: 'uuid' } : null),
        resume: () => {},
        dispatch: async () => ({ sessionId: 'new', tmux: 'cc_new', cwd: '/a' }),
        killForSession: () => {},
        setAutoFixPrChecks: () => {},
        recordPriorLiveSessionId: () => true,
      },
      taskStore: { taskFor: () => null, snapshot: () => ({ tasks: [] }), assign: () => {} },
    },
    // `memory.*` is provided by the task-memory extension's store while it is
    // active; the default wiring has one, a test passes `memoryProvider: () => null`
    // for the disabled case.
    memoryProvider: () => ({ read: () => 'md', hasMemory: () => true, append: () => {} }),
    events: createEventBus(),
    deliver: () => {},
    rebuild: () => {},
    broadcast: () => {},
    archiveSession: () => {},
    archiveTask: async () => ({ archived: false, sessionIds: [], unclean: false }),
    createTerminal: () => {},
    interruptSession: async () => true,
    scheduleStore: { snapshot: () => [], create: () => {}, update: () => {}, delete: () => {} },
    mailStore: { unreadInfo: () => null, list: () => [], append: () => {} },
    scanUsage: async () => ({ sessions: [] }),
    ...overrides,
  };
}

test('V1_BUILDERS keys and CAPABILITIES match in both directions', () => {
  assert.deepEqual(Object.keys(V1_BUILDERS).sort(), [...CAPABILITIES].sort());
});

test('a facade has exactly its declared capabilities plus the always-present keys', () => {
  const host = buildHostApi({ id: 'x', requires: ['board:rebuild'], ...wiring() });
  assert.deepEqual(Object.keys(host).sort(), [...ALWAYS, 'rebuild'].sort());
  assert.equal(host.id, 'x');
  assert.equal(host.version, HOST_API_VERSION);
});

test('an undeclared capability is ABSENT, not a throwing method', () => {
  const host = buildHostApi({ id: 'x', requires: ['board:rebuild'], ...wiring() });
  assert.equal(host.sessions, undefined);
  assert.equal('sessions' in host, false);
  assert.equal('deliver' in host, false);
});

test('capabilities sharing a namespace merge into one object', () => {
  const host = buildHostApi({ id: 'x', requires: ['sessions:read', 'sessions:wake'], ...wiring() });
  assert.equal(typeof host.sessions.list, 'function');
  assert.equal(typeof host.sessions.wake, 'function');
  assert.equal(host.sessions.archive, undefined);
});

test('the facade and every nested sub-object are frozen', () => {
  const host = buildHostApi({ id: 'x', requires: [...CAPABILITIES], ...wiring() });
  assert.ok(Object.isFrozen(host));
  for (const key of ['sessions', 'tasks', 'memory', 'events', 'mail', 'schedules', 'terminals', 'stores', 'settings']) {
    assert.ok(Object.isFrozen(host[key]), key);
  }
  assert.throws(() => { host.rebuild = () => {}; }, TypeError);
  assert.throws(() => { host.sessions.kill = () => {}; }, TypeError);
});

test('host.stores carries only what was wired for this extension', () => {
  const host = buildHostApi({ id: 'x', requires: [], stores: { mine: 1 }, ...wiring() });
  assert.deepEqual(Object.keys(host.stores), ['mine']);
});

// -- host.settings ---------------------------------------------------------
const DEFS = [{ key: 'registryUrl', type: 'text', label: 'Registry URL' }, { key: 'auto', type: 'toggle', label: 'Auto' }];

test('host.settings is UNGATED — present on a facade that declared no capabilities at all', () => {
  const host = buildHostApi({ id: 'x', requires: [], ...wiring() });
  assert.equal('settings' in host, true, 'the extension\'s own values are not a core surface to gate');
  assert.deepEqual(host.settings.all(), {}, 'no defs declared, so no vocabulary');
});

test('host.settings reads ITS OWN id only, and never as a caller-passable argument', () => {
  const asked = [];
  const host = buildHostApi({
    id: 'x', requires: [], settingDefs: DEFS,
    readSettings: (id) => { asked.push(id); return { x: { registryUrl: 'https://mine' }, other: { registryUrl: 'https://theirs' } }[id] || {}; },
    ...wiring(),
  });
  assert.equal(host.settings.get('registryUrl'), 'https://mine');
  assert.deepEqual(host.settings.all(), { registryUrl: 'https://mine', auto: undefined });
  // There is no signature through which a sibling's block could be reached:
  // `id` is closed over, exactly like broadcast's type and mail.send's from.
  assert.equal(host.settings.get('registryUrl', 'other'), 'https://mine');
  assert.deepEqual([...new Set(asked)], ['x']);
});

test('host.settings reads THROUGH on every call, so an edit lands without a restart', () => {
  let stored = {};
  const host = buildHostApi({ id: 'x', requires: [], settingDefs: DEFS, readSettings: () => stored, ...wiring() });
  assert.equal(host.settings.get('registryUrl'), undefined);
  stored = { registryUrl: 'https://later' };
  assert.equal(host.settings.get('registryUrl'), 'https://later', 'the facade is built once per activation; the value is not');
  assert.deepEqual(host.settings.all(), { registryUrl: 'https://later', auto: undefined });
});

test('a key the manifest never declared reads undefined from both get and all', () => {
  const host = buildHostApi({ id: 'x', requires: [], settingDefs: DEFS, readSettings: () => ({ registryUrl: 'https://mine', stray: 'ignored' }), ...wiring() });
  assert.equal(host.settings.get('stray'), undefined, 'a typo is the extension\'s own bug, with nothing to leak into');
  assert.deepEqual(Object.keys(host.settings.all()), ['registryUrl', 'auto'], 'get and all agree about the vocabulary');
});

// The store-factory half of the same surface (server/index.js activateExtension
// hands a factory this, since a factory runs before any facade exists). Same
// builder, so the narrowing, the read-through and the declared vocabulary
// cannot drift between the two callers.
test('buildExtSettings is the ONE definition, and host.settings is built from it', () => {
  let stored = { alpha: { registryUrl: 'https://alpha' }, beta: { registryUrl: 'https://beta' } };
  const forFactory = buildExtSettings({ id: 'alpha', settingDefs: DEFS, readSettings: (id) => stored[id] || {} });
  assert.equal(forFactory.get('registryUrl'), 'https://alpha');
  assert.equal(forFactory.get('registryUrl', 'beta'), 'https://alpha', 'the id is closed over, not a caller-passable argument');
  assert.equal(forFactory.get('stray'), undefined, 'only the declared vocabulary');
  stored = { alpha: { registryUrl: 'https://edited' } };
  assert.equal(forFactory.get('registryUrl'), 'https://edited', 'read THROUGH, so a store built at boot still sees an edit');
  assert.equal(Object.isFrozen(forFactory), true);
  // And the facade's own key is the same thing, with nothing extra on it.
  const host = buildHostApi({ id: 'alpha', requires: [], settingDefs: DEFS, readSettings: (id) => stored[id] || {}, ...wiring() });
  assert.deepEqual(Object.keys(host.settings), Object.keys(forFactory));
  assert.deepEqual(host.settings.all(), forFactory.all());
});

test('an unknown capability throws naming the extension', () => {
  assert.throws(
    () => buildHostApi({ id: 'boom', requires: ['sessions:teleport'], ...wiring() }),
    /Extension boom: unknown capability "sessions:teleport"/,
  );
});

test('a non-array requires throws naming the extension', () => {
  assert.throws(() => buildHostApi({ id: 'boom', requires: 'board:rebuild', ...wiring() }), /Extension boom: requires must be an array/);
});

test('a range the server does not serve throws at build; one it serves builds', () => {
  assert.throws(
    () => buildHostApi({ id: 'boom', requires: [], range: `>${HOST_API_VERSION}`, ...wiring() }),
    new RegExp(`Extension boom: needs host API >${HOST_API_VERSION.replace(/\./g, '\\.')}`),
  );
  assert.ok(buildHostApi({ id: 'ok', requires: [], range: `^${HOST_API_VERSION}`, ...wiring() }));
  assert.ok(buildHostApi({ id: 'ok', requires: [], range: null, ...wiring() }));
});

test('broadcast forces type: ext:<id> whatever the payload says', () => {
  const seen = [];
  const host = buildHostApi({ id: 'x', requires: ['board:broadcast'], ...wiring({ broadcast: (o) => seen.push(o) }) });
  host.broadcast({ type: 'graph', a: 1 });
  assert.deepEqual(seen, [{ type: 'ext:x', a: 1 }]);
});

test('mail.send forces from: ext:<id>', () => {
  const seen = [];
  const host = buildHostApi({ id: 'x', requires: ['mail:send'], ...wiring({ mailStore: { append: (to, m) => seen.push({ to, ...m }) } }) });
  host.mail.send('c1', 'hello');
  assert.deepEqual(seen, [{ to: 'c1', from: 'ext:x', body: 'hello' }]);
});

test('wake and kill force reason: ext:<id> and cannot be overridden by an argument', () => {
  const resumed = [];
  const killed = [];
  const w = wiring();
  w.core.sessionManager.resume = (id, cwd, opts) => resumed.push({ id, cwd, opts });
  w.core.sessionManager.killForSession = (id, opts) => killed.push({ id, opts });
  const host = buildHostApi({ id: 'x', requires: ['sessions:wake', 'sessions:kill'], ...w });
  host.sessions.wake('c1', { reason: 'message' });
  host.sessions.kill('c1', { reason: 'message' });
  assert.deepEqual(resumed, [{ id: 'c1', cwd: undefined, opts: { reason: 'ext:x' } }]);
  assert.deepEqual(killed, [{ id: 'c1', opts: { reason: 'ext:x' } }]);
});

test('sessions:interrupt passes the card id straight to the composed interruptSession', async () => {
  const seen = [];
  const host = buildHostApi({ id: 'x', requires: ['sessions:interrupt'], ...wiring({ interruptSession: async (sid) => { seen.push(sid); return sid === 'c1'; } }) });
  assert.equal(await host.sessions.interrupt('c1'), true);
  assert.equal(await host.sessions.interrupt('gone'), false);
  assert.deepEqual(seen, ['c1', 'gone']);
});

// -- links:write -----------------------------------------------------------
// A links wiring over one real card's link list, with the normalise hooks of
// two extensions: `x` claims `cloud`, `other` claims `jira`.
function linksWiring({ links = [], rebuilds = [] } = {}) {
  const stored = { c1: links };
  const hooks = [
    { extId: 'x', fn: ({ link, host }) => {
      if (link.type !== 'cloud') return undefined;
      if (!link.key) throw new Error('cloud links need a key');
      return { type: 'cloud', key: link.key, url: link.url, by: host.id };
    } },
    { extId: 'other', fn: ({ link }) => (link.type === 'jira' ? { type: 'jira', key: link.key } : undefined) },
  ];
  let host;
  const w = wiring({
    rebuild: () => { rebuilds.push(1); },
    linkNormalisersFor: (id) => hooks.filter((h) => h.extId === id),
    hostApiFor: () => host,
  });
  w.core.sessionManager.getLinks = (sid) => [...(stored[sid] || [])];
  w.core.sessionManager.setLinks = (sid, next) => { stored[sid] = [...next]; return true; };
  host = buildHostApi({ id: 'x', requires: ['links:write'], ...w });
  return { host, stored, rebuilds };
}

test('links:write get returns a copy of the card\'s links, [] for an unknown card', () => {
  const { host, stored } = linksWiring({ links: [{ type: 'pr', url: 'https://github.com/o/r/pull/1' }] });
  const got = host.links.get('c1');
  assert.deepEqual(got, stored.c1);
  got[0].url = 'mutated';
  assert.equal(stored.c1[0].url, 'https://github.com/o/r/pull/1');
  assert.deepEqual(host.links.get('gone'), []);
});

test('links:write attach runs the CALLER\'s own normalise, appends, then upserts in place, and rebuilds', () => {
  const { host, stored, rebuilds } = linksWiring({ links: [{ type: 'pr', url: 'https://github.com/o/r/pull/1' }] });
  const first = host.links.attach('c1', { type: 'cloud', key: 'session_1' });
  assert.deepEqual(first, { type: 'cloud', key: 'session_1', url: undefined, by: 'x' });
  assert.equal(stored.c1.length, 2);
  host.links.attach('c1', { type: 'cloud', key: 'session_1', url: 'https://claude.ai/code/session_1' });
  assert.equal(stored.c1.length, 2, 'a matching link is replaced, not duplicated');
  assert.equal(stored.c1[1].url, 'https://claude.ai/code/session_1');
  assert.equal(stored.c1[0].type, 'pr', 'other links are untouched');
  assert.equal(rebuilds.length, 2);
});

test('links:write attach refuses a type the caller does not claim, a throwing normalise, and an unknown card', () => {
  const { host, stored } = linksWiring();
  assert.throws(() => host.links.attach('c1', { type: 'jira', key: 'ABC-1' }), /no links\.normalise hook that claims "jira"/);
  assert.throws(() => host.links.attach('c1', { type: 'pr', url: 'https://github.com/o/r/pull/2' }), /claims "pr"/);
  assert.throws(() => host.links.attach('c1', { type: 'cloud' }), /cloud links need a key/);
  assert.throws(() => host.links.attach('gone', { type: 'cloud', key: 'session_1' }), /unknown session gone/);
  assert.deepEqual(stored.c1, []);
  assert.equal(stored.gone, undefined, 'an unknown card is never adopted');
});

// -- sessions:spawn --------------------------------------------------------
// A spawn wiring that records the dispatch payload and everything the builder
// does around it, so a test can assert the NAMES the options arrive under —
// the whole point of the builder is that it is the translation layer.
function spawnWiring() {
  const seen = { dispatch: [], assigned: [], autoFix: [] };
  const w = wiring();
  w.core.sessionManager.dispatch = async (opts) => {
    seen.dispatch.push(opts);
    return { sessionId: 'NEWCARD', tmux: 'cc_new', cwd: opts.cwd || '/a' };
  };
  w.core.sessionManager.entryFor = (id) => (id === 'NEWCARD'
    ? { worktree: { path: '/repo-worktree-fix', branch: 'fix', repoRoot: '/repo', createdAt: 7 } }
    : null);
  w.core.sessionManager.setAutoFixPrChecks = (sid, on) => seen.autoFix.push({ sid, on });
  w.core.taskStore.assign = (sid, taskId) => seen.assigned.push({ sid, taskId });
  return { seen, host: buildHostApi({ id: 'x', requires: ['sessions:spawn'], ...w }) };
}

test('spawn forwards every option to dispatch under its own name', async () => {
  const { seen, host } = spawnWiring();
  await host.sessions.spawn({
    cwd: '/repo', intent: 'do it', agent: 'codex', model: 'gpt-5.5', effort: 'high',
    autoCompactTokens: 120000, parentSession: 'c1',
    worktree: { branch: 'fix', base: 'refs/remotes/origin/main', auto: true, folderName: '/elsewhere/wt' },
    addDirs: ['/repo/.git'], autoMergeOnPass: true,
  });
  const [opts] = seen.dispatch;
  assert.equal(opts.cwd, '/repo');
  assert.equal(opts.intent, 'do it');
  assert.equal(opts.agent, 'codex');
  assert.equal(opts.model, 'gpt-5.5');
  assert.equal(opts.effort, 'high');
  assert.equal(opts.autoCompactTokens, 120000);
  assert.equal(opts.parentSession, 'c1');
  assert.equal(opts.worktree, true);
  assert.equal(opts.worktreeBranch, 'fix');
  assert.equal(opts.worktreeBase, 'refs/remotes/origin/main');
  assert.equal(opts.worktreeAuto, true);
  assert.equal(opts.worktreeFolderName, '/elsewhere/wt');
  assert.deepEqual(opts.addDirs, ['/repo/.git']);
  assert.equal(opts.autoMergeOnPass, true);
  assert.equal('spawnedBy' in opts, false, 'lineage is core-managed; an extension has no id to claim there');
});

test('spawn with no worktree option asks dispatch for none', async () => {
  const { seen, host } = spawnWiring();
  await host.sessions.spawn({ cwd: '/repo', intent: 'plain' });
  const [opts] = seen.dispatch;
  assert.equal(opts.worktree, undefined);
  assert.equal('addDirs' in opts, false);
  assert.equal('autoMergeOnPass' in opts, false);
  assert.equal('taskId' in opts, false, 'no task asked for, none forwarded');
  assert.equal(opts.launchReason, 'spawn');
});

test('spawn returns the resolved worktree summary beside the dispatch result', async () => {
  const { host } = spawnWiring();
  const res = await host.sessions.spawn({ cwd: '/repo', worktree: { branch: 'fix' } });
  assert.equal(res.sessionId, 'NEWCARD');
  assert.equal(res.tmux, 'cc_new');
  assert.deepEqual(res.worktree, { branch: 'fix', path: '/repo-worktree-fix', repoRoot: '/repo' });
  assert.ok(Object.isFrozen(res.worktree), 'the same frozen summary shape sessions:read reports');
  assert.equal('createdAt' in res.worktree, false, 'a summary, not the stored record');
});

test('spawn taskId rides dispatch (the launch context reads it BEFORE launch) and assigns the task after', async () => {
  const { seen, host } = spawnWiring();
  await host.sessions.spawn({ cwd: '/repo', taskId: 't1' });
  // The task has to reach dispatch itself, before the pane: a tasks.assign
  // afterwards cannot replace it for Codex (it resolves its writable roots once,
  // at launch), so the launch context must already know the task.
  assert.equal(seen.dispatch[0].taskId, 't1');
  assert.deepEqual(seen.assigned, [{ sid: 'NEWCARD', taskId: 't1' }]);
});

test('spawn autoFixPrChecks goes through the setter, since dispatch has no argument for it', async () => {
  const { seen, host } = spawnWiring();
  await host.sessions.spawn({ cwd: '/repo', autoFixPrChecks: false });
  assert.deepEqual(seen.autoFix, [{ sid: 'NEWCARD', on: false }]);
  assert.equal('autoFixPrChecks' in seen.dispatch[0], false);
  const untouched = spawnWiring();
  await untouched.host.sessions.spawn({ cwd: '/repo' });
  assert.deepEqual(untouched.seen.autoFix, [], 'absent means "inherit the default", not "off"');
});

test('a mistyped spawn option is REFUSED by name, never launched around', async () => {
  const { seen, host } = spawnWiring();
  const bad = [
    [{ worktree: true }, /worktree must be an object/],
    [{ worktree: [] }, /worktree must be an object/],
    [{ worktree: { baseRef: 'main' } }, /worktree has unknown option\(s\) baseRef/],
    [{ worktree: { branch: 3 } }, /worktree\.branch must be a string/],
    [{ worktree: { auto: 'yes' } }, /worktree\.auto must be a boolean/],
    [{ addDirs: '/repo' }, /addDirs must be an array/],
    [{ addDirs: ['relative/path'] }, /addDirs entries must be absolute/],
    [{ addDirs: [null] }, /addDirs entries must be absolute/],
    [{ taskId: 7 }, /taskId must be a non-empty task id/],
    [{ taskId: '' }, /taskId must be a non-empty task id/],
    [{ autoMergeOnPass: 'true' }, /autoMergeOnPass must be a boolean/],
    [{ autoFixPrChecks: 1 }, /autoFixPrChecks must be a boolean/],
  ];
  for (const [args, re] of bad) {
    await assert.rejects(() => host.sessions.spawn({ cwd: '/repo', ...args }), re, JSON.stringify(args));
  }
  assert.deepEqual(seen.dispatch, [], 'a refusal happens before anything is launched');
});

test('sessions:read hands back projections, never live entries', () => {
  const host = buildHostApi({ id: 'x', requires: ['sessions:read'], ...wiring() });
  const [row] = host.sessions.list();
  assert.equal('liveSessionId' in row, false);
  assert.equal(row.sessionId, 'c1');
  assert.ok(Object.isFrozen(row));
  assert.equal(host.sessions.get('nope'), null);
});

test('host.log prefixes the message and keeps an Error its own argument', () => {
  const lines = [];
  const host = buildHostApi({ id: 'x', requires: [], log: (...a) => lines.push(a), ...wiring() });
  const err = new Error('boom');
  host.log('something', err);
  host.log(err);
  assert.deepEqual(lines[0], ['[ext:x] something', err]);
  assert.deepEqual(lines[1], ['[ext:x]', err]);
});

// ---- usage:read ----------------------------------------------------------
// A scanAllDaily result in the shape the scanner produces: one row per transcript
// a card owned, each with per-day bags carrying `usd` and the Codex-estimate
// slice `estimatedUsd`.
const day = (usd, estimatedUsd = 0) => ({ usd, estimatedUsd });
const SCAN = { sessions: [
  { file: '/t/a.jsonl', cardId: 'c1', days: { '2026-09-01': day(1), '2026-09-02': day(2) } },
  // A `/clear` left an earlier transcript behind: a second row on the SAME card.
  { file: '/t/b.jsonl', cardId: 'c1', days: { '2026-09-03': day(4) } },
  // A Codex card: the whole bag is estimated.
  { file: null, cardId: 'c2', days: { '2026-09-01': day(0.5, 0.5) } },
  // A row the scanner could not tie to a card contributes to nobody.
  { file: '/t/z.jsonl', cardId: null, days: { '2026-09-01': day(99) } },
] };

test('usdByCard sums every row and day a card owned, keeping the estimate as a dollar slice', () => {
  assert.deepEqual(usdByCard(SCAN), [
    { cardId: 'c1', usd: 7, estimatedUsd: 0 },
    { cardId: 'c2', usd: 0.5, estimatedUsd: 0.5 },
  ]);
  assert.deepEqual(usdByCard(null), []);
  assert.deepEqual(usdByCard({ sessions: [{ cardId: 'c', days: undefined }] }), [{ cardId: 'c', usd: 0, estimatedUsd: 0 }]);
});

test('usage.byCard goes THROUGH the shared scan memo and hands back a frozen result', async () => {
  _resetUsageCache();
  try {
    let scans = 0;
    const host = buildHostApi({ id: 'x', requires: ['usage:read'], ...wiring({ scanUsage: async () => { scans += 1; return SCAN; } }) });
    const first = await host.usage.byCard();
    const second = await host.usage.byCard();
    assert.equal(scans, 1, 'two reads inside the TTL are one scan');
    assert.deepEqual(first, [{ cardId: 'c1', usd: 7, estimatedUsd: 0 }, { cardId: 'c2', usd: 0.5, estimatedUsd: 0.5 }]);
    assert.deepEqual(second, first);
    assert.ok(Object.isFrozen(first));
    assert.ok(Object.isFrozen(first[0]));
    assert.throws(() => { first[0].usd = 0; }, TypeError);
  } finally {
    _resetUsageCache();
  }
});

test('usage is ABSENT without usage:read, and sessions.bill is ABSENT without sessions:bill', () => {
  const host = buildHostApi({ id: 'x', requires: ['sessions:read'], ...wiring() });
  assert.equal('usage' in host, false);
  assert.equal('bill' in host.sessions, false);
});

// ---- sessions:bill -------------------------------------------------------
test('sessions.bill forwards both ids to recordPriorLiveSessionId and returns its boolean', () => {
  const calls = [];
  const host = buildHostApi({
    id: 'x',
    requires: ['sessions:bill'],
    ...wiring({ core: { ...wiring().core, sessionManager: { recordPriorLiveSessionId: (sid, live) => { calls.push([sid, live]); return sid === 'c1'; } } } }),
  });
  assert.equal(host.sessions.bill('c1', 'head-1'), true);
  assert.equal(host.sessions.bill('missing', 'head-1'), false);
  assert.deepEqual(calls, [['c1', 'head-1'], ['missing', 'head-1']]);
  // Only `bill` on the namespace: no read, wake or spawn rode in with it.
  assert.deepEqual(Object.keys(host.sessions), ['bill']);
});

test('CLIENT_CAPABILITIES is disjoint from CAPABILITIES and builds no façade key', () => {
  for (const c of CLIENT_CAPABILITIES) assert.equal(CAPABILITIES.has(c), false, c);
  const host = buildHostApi({ id: 'demo', requires: ['cards:hideChips'] });
  assert.equal('cards' in host, false);
  assert.deepEqual(Object.keys(host).sort(), ['id', 'log', 'settings', 'stores', 'version']);
});

test('tasks:read serves the Unassigned id, equal to the core ADHOC constant', async () => {
  const { ADHOC } = await import('../task-store.js');
  const host = buildHostApi({ id: 'x', requires: ['tasks:read'], ...wiring() });
  assert.equal(host.tasks.adhocId, ADHOC);
  assert.equal(host.tasks.adhocId, 'adhoc');
});

test('tasks:archive is its own grant: tasks:write alone has no archive', async () => {
  const calls = [];
  const w = wiring({ archiveTask: async (t) => { calls.push(t); return { archived: true, sessionIds: ['s1'], unclean: false }; } });
  assert.equal('archive' in buildHostApi({ id: 'x', requires: ['tasks:write'], ...w }).tasks, false);
  const host = buildHostApi({ id: 'x', requires: ['tasks:read', 'tasks:archive'], ...w });
  assert.deepEqual(await host.tasks.archive('t_1'), { archived: true, sessionIds: ['s1'], unclean: false });
  assert.deepEqual(calls, ['t_1']);
  assert.equal(typeof host.tasks.list, 'function');
});

// -- memory (provided by the task-memory extension) -------------------------
test('memory.* delegates to the provider while the task-memory extension is active', () => {
  const calls = [];
  const store = { read: (t) => `md:${t}`, hasMemory: (t) => t === 'has', append: (t, x) => calls.push([t, x]) };
  const host = buildHostApi({ id: 'x', requires: ['memory:read', 'memory:append'], ...wiring({ memoryProvider: () => store }) });
  assert.equal(host.memory.read('T1'), 'md:T1');
  assert.equal(host.memory.has('has'), true);
  assert.equal(host.memory.append('T1', 'hello'), true);
  assert.deepEqual(calls, [['T1', 'hello']]);
});

test('memory.* is "not available" — null / false, plus a logged warning — when the extension is disabled', () => {
  const logged = [];
  const host = buildHostApi({ id: 'x', requires: ['memory:read', 'memory:append'], ...wiring({ memoryProvider: () => null, log: (m) => logged.push(m) }) });
  assert.equal(host.memory.read('T1'), null);
  assert.equal(host.memory.has('T1'), false);
  assert.equal(host.memory.append('T1', 'x'), false);
  assert.equal(logged.length, 3);
  assert.match(logged[0], /\[ext:x\] memory\.read: the task-memory extension is not enabled/);
});

test('memory.* follows the provider LIVE: enabling the extension later makes it work without rebuilding the facade', () => {
  let store = null;
  const host = buildHostApi({ id: 'x', requires: ['memory:read'], ...wiring({ memoryProvider: () => store, log: () => {} }) });
  assert.equal(host.memory.read('T1'), null);
  store = { read: () => 'now', hasMemory: () => true };
  assert.equal(host.memory.read('T1'), 'now');
});

// -- events -----------------------------------------------------------------
test('events: on() subscribes under the extension id; emit() is FORCED under ext:<id>: and cannot forge a core event', () => {
  const events = createEventBus();
  const a = buildHostApi({ id: 'a', requires: ['events'], ...wiring({ events }) });
  const b = buildHostApi({ id: 'b', requires: ['events'], ...wiring({ events }) });
  const coreSeen = [];
  const bSeen = [];
  events.on('archive-review:completed', (p) => coreSeen.push(p));
  b.events.on('ext:a:ping', (p) => bSeen.push(p));
  assert.equal(a.events.emit('archive-review:completed', { forged: true }), 0, 'lands under ext:a:..., not the core name');
  assert.deepEqual(coreSeen, []);
  assert.equal(a.events.emit('ping', 1), 1);
  assert.deepEqual(bSeen, [1]);
  assert.throws(() => a.events.emit('', 1), /name must be a non-empty string/);
  assert.throws(() => a.events.on('x', 'nope'), /handler must be a function/);
});

test('events: delivery to an extension stops when it is deactivated (offOwner) or reported inactive', () => {
  const active = new Set(['a', 'b']);
  const events = createEventBus({ isActive: (id) => active.has(id) });
  const a = buildHostApi({ id: 'a', requires: ['events'], ...wiring({ events }) });
  const b = buildHostApi({ id: 'b', requires: ['events'], ...wiring({ events }) });
  const seen = [];
  a.events.on('core:thing', () => seen.push('a'));
  b.events.on('core:thing', () => seen.push('b'));
  events.emit('core:thing');
  assert.deepEqual(seen, ['a', 'b']);
  active.delete('a'); // disabled, even before its subscriptions are dropped
  events.emit('core:thing');
  assert.deepEqual(seen, ['a', 'b', 'b']);
  events.offOwner('b');
  events.emit('core:thing');
  assert.deepEqual(seen, ['a', 'b', 'b']);
});
