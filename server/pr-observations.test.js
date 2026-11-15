import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPrObservationStore, createPrObservationPoller } from './pr-observations.js';
import { createEventBus } from './events.js';
import { buildHostApi } from './host-api/index.js';

async function collect(iterator) {
  const rows = [];
  for await (const row of iterator) rows.push(row);
  return rows;
}

const url = 'https://github.com/acme/widgets/pull/42';
const status = {
  nodeId: 'PR_42', createdAt: '2026-11-15T10:00:00Z', state: 'OPEN', title: 'A change', number: 42, isDraft: false, headSha: 'abc',
  mergeStateStatus: 'BLOCKED', statusCheckRollup: [{ name: 'test', status: 'IN_PROGRESS', conclusion: '' }],
  reviewDecision: '', checkStatus: 'pending', dirty: false,
};

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-observations-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const events = createEventBus();
  const file = path.join(dir, 'observations.json');
  const store = createPrObservationStore({ file, events });
  const host = buildHostApi({ id: 'test', requires: ['links:read', 'events'],
    core: { sessionManager: { getLinks: () => [] } }, prObservations: store, events });
  return { file, events, store, host };
}

test('host reads durable observations after terminal links disappear, without exposing a writer', (t) => {
  const { file, store, host } = setup(t);
  assert.equal(host.links.prObservation(url), null);
  store.record(url, { status: { ...status, state: 'MERGED' }, error: null }, '2026-11-15T12:00:00.000Z');
  assert.deepEqual(host.links.get('gone'), []);
  assert.equal(host.links.prObservation(url).state, 'merged');
  assert.equal(host.links.prObservations()[url].number, 42);
  assert.equal(host.links.record, undefined);
  assert.deepEqual(createPrObservationStore({ file }).get(url), store.get(url));
  const copy = host.links.prObservation(url);
  assert.throws(() => { copy.statusCheckRollup[0].name = 'corrupted'; }, TypeError);
  assert.equal(store.get(url).statusCheckRollup[0].name, 'test');
});

test('observations publish through host events only on meaningful change, after committing the snapshot', (t) => {
  const { file, store, host } = setup(t);
  const seen = [];
  host.events.on('pr:observation', (ev) => {
    assert.deepEqual(ev, store.get(url));
    assert.deepEqual(ev, createPrObservationStore({ file }).get(url));
    seen.push(ev);
    assert.throws(() => { ev.statusCheckRollup.push({}); }, TypeError);
  });
  store.record(url, { status, error: null }, '2026-11-15T12:00:00.000Z');
  store.record(url, { status, error: null }, '2026-11-15T12:01:00.000Z');
  assert.equal(seen.length, 1);
  assert.equal(host.links.prObservation(url).fetchedAt, '2026-11-15T12:01:00.000Z');
  store.record(url, { status: null, error: 'gh exited 1' }, '2026-11-15T12:02:00.000Z');
  assert.equal(seen.length, 2);
  assert.equal(seen[1].headSha, 'abc');
  assert.equal(seen[1].fetchedAt, '2026-11-15T12:01:00.000Z');
  assert.equal(seen[1].attemptedAt, '2026-11-15T12:02:00.000Z');
  assert.equal(seen[1].lastError, 'gh exited 1');
  store.record(url, { status: null, error: 'gh exited 1' }, '2026-11-15T12:03:00.000Z');
  assert.equal(seen.length, 2);
  store.record(url, { status, error: null }, '2026-11-15T12:04:00.000Z');
  assert.equal(seen.length, 3);
  assert.equal(seen[2].lastError, null);
  store.record(url, { status: { ...status, headSha: 'def' }, error: null });
  assert.equal(seen.length, 4);
});

test('a first failed fetch is distinguishable from an unseen URL and survives restart', (t) => {
  const { store, file } = setup(t);
  store.record(url, { status: null, error: 'unavailable' }, '2026-11-15T12:00:00.000Z');
  const held = createPrObservationStore({ file }).get(url);
  assert.equal(held.state, null);
  assert.equal(held.fetchedAt, null);
  assert.equal(held.lastError, 'unavailable');
});

test('duplicate owners and overlapping sweeps share existing status and thread fetches', async (t) => {
  const { store } = setup(t);
  const calls = [];
  let resolve;
  const poll = createPrObservationPoller({ observations: store,
    fetchStatus: async (u) => { calls.push(['status', u]); return new Promise((r) => { resolve = r; }); },
    fetchUnresolved: async (u) => { calls.push(['threads', u]); return 3; },
  });
  const links = [{ url, scope: 'task', ownerId: 't1' }, { url, scope: 'session', ownerId: 's1' }];
  const first = collect(poll(links));
  const overlap = collect(poll([links[1]]));
  resolve({ status, error: null });
  const [a, b] = await Promise.all([first, overlap]);
  assert.deepEqual(calls, [['status', url], ['threads', url]]);
  assert.equal(a.length, 2);
  assert.equal(a[0].unresolvedCount, 3);
  assert.equal(a[1].status, b[0].status);
  assert.equal(store.get(url).headSha, 'abc');
});

test('terminal and failed fetches do not fetch threads; failure retains prior success', async (t) => {
  const { store } = setup(t);
  let next = { status: { ...status, state: 'CLOSED' }, error: null };
  const poll = createPrObservationPoller({ observations: store, fetchStatus: async () => next,
    fetchUnresolved: () => assert.fail('unexpected GitHub request') });
  await collect(poll([{ url }]));
  assert.equal(store.get(url).state, 'closed');
  next = { status: null, error: 'offline' };
  await collect(poll([{ url }]));
  assert.equal(store.get(url).state, 'closed');
  assert.equal(store.get(url).lastError, 'offline');
});


test('a reused URL replaces its prior PR identity and emits even with identical status', (t) => {
  const { store, events } = setup(t);
  const seen = [];
  events.on('pr:observation', (ev) => seen.push(ev));
  store.record(url, { status: { ...status, state: 'MERGED' }, error: null });
  store.record(url, { status: null, error: 'offline' });
  store.record(url, { status: { ...status, nodeId: 'PR_new', createdAt: '2026-11-15T11:00:00Z' }, error: null });
  assert.equal(seen.length, 3);
  assert.equal(store.get(url).nodeId, 'PR_new');
  assert.equal(store.get(url).state, 'open');
  assert.equal(store.get(url).lastError, null);
  assert.equal(store.get(url).createdAt, '2026-11-15T11:00:00Z');
});

test('a failed durable write cannot publish or erase terminal links', async (t) => {
  const { store, file, events } = setup(t);
  store.record(url, { status, error: null });
  fs.rmSync(file);
  fs.mkdirSync(file);
  let emitted = false;
  events.on('pr:observation', () => { emitted = true; });
  const poll = createPrObservationPoller({ observations: store,
    fetchStatus: async () => ({ status: { ...status, state: 'MERGED' }, error: null }),
    fetchUnresolved: () => assert.fail('unexpected request') });
  assert.equal((await collect(poll([{ url }])))[0].status, null);
  assert.equal(store.get(url).state, 'open');
  assert.equal(emitted, false);
});

test('all owners of a URL receive its result before another slow fetch can make it stale', async (t) => {
  const { store } = setup(t);
  const other = 'https://github.com/acme/widgets/pull/43';
  const calls = [];
  const poll = createPrObservationPoller({ observations: store,
    fetchStatus: async (u) => { calls.push(u); return { status, error: null }; },
    fetchUnresolved: async () => null });
  const updates = poll([{ url, ownerId: 't1' }, { url: other, ownerId: 't2' }, { url, ownerId: 's1' }]);
  assert.equal((await updates.next()).value.ownerId, 't1');
  assert.equal((await updates.next()).value.ownerId, 's1');
  assert.deepEqual(calls, [url]);
  assert.equal((await updates.next()).value.ownerId, 't2');
  assert.equal((await updates.next()).done, true);
});
