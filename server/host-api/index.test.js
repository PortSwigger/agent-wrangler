import test from 'node:test';
import assert from 'node:assert/strict';
import { CAPABILITIES } from '../extensions/index.js';
import { buildHostApi, buildExtSettings } from './index.js';
import { V1_BUILDERS } from './v1.js';
import { HOST_API_VERSION } from './version.js';

const ALWAYS = ['id', 'version', 'stores', 'settings', 'log'];

function wiring(overrides = {}) {
  return {
    core: {
      sessionManager: {
        activeEntries: () => [{ sessionId: 'c1', cwd: '/a', liveSessionId: 'uuid' }],
        entryFor: (id) => (id === 'c1' ? { cwd: '/a', liveSessionId: 'uuid' } : null),
        resume: () => {},
        dispatch: () => {},
        killForSession: () => {},
      },
      taskStore: { taskFor: () => null, snapshot: () => ({ tasks: [] }) },
      memoryStore: { read: () => '', hasMemory: () => false, append: () => {} },
    },
    deliver: () => {},
    rebuild: () => {},
    broadcast: () => {},
    archiveSession: () => {},
    createTerminal: () => {},
    scheduleStore: { snapshot: () => [], create: () => {}, update: () => {}, delete: () => {} },
    mailStore: { unreadInfo: () => null, list: () => [], append: () => {} },
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
  for (const key of ['sessions', 'tasks', 'memory', 'mail', 'schedules', 'terminals', 'stores', 'settings']) {
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
