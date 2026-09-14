import test from 'node:test';
import assert from 'node:assert/strict';
import { CAPABILITIES } from '../extensions/index.js';
import { buildHostApi } from './index.js';
import { V1_BUILDERS } from './v1.js';
import { HOST_API_VERSION } from './version.js';

const ALWAYS = ['id', 'version', 'stores', 'log'];

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
  for (const key of ['sessions', 'tasks', 'memory', 'mail', 'schedules', 'terminals', 'stores']) {
    assert.ok(Object.isFrozen(host[key]), key);
  }
  assert.throws(() => { host.rebuild = () => {}; }, TypeError);
  assert.throws(() => { host.sessions.kill = () => {}; }, TypeError);
});

test('host.stores carries only what was wired for this extension', () => {
  const host = buildHostApi({ id: 'x', requires: [], stores: { mine: 1 }, ...wiring() });
  assert.deepEqual(Object.keys(host.stores), ['mine']);
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
