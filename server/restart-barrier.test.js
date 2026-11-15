import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { setImmediate } from 'node:timers/promises';
import { createRestartBarrier } from './restart-barrier.js';

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

function fixture(options = {}) {
  const exits = [];
  const statuses = [];
  const barrier = createRestartBarrier({ timeoutMs: 100, settleMs: 0, exit: (reason) => exits.push(reason), onStatus: (s) => statuses.push(s), ...options });
  return { barrier, exits, statuses };
}

test('restart closes admission, drains admitted nested writes, then exits', async () => {
  const { barrier, exits } = fixture();
  const gate = deferred();
  let saved = false;
  const write = barrier.run(async () => {
    await gate.promise;
    await barrier.run(async () => { saved = true; });
  });
  assert.equal(barrier.inFlight(), 1);
  const restart = barrier.request('update');
  assert.throws(() => barrier.run(() => assert.fail('new mutation ran')), { code: 'restarting', retryable: true });
  assert.deepEqual(exits, []);
  gate.resolve();
  await write;
  assert.equal(await restart, true);
  assert.equal(saved, true);
  assert.deepEqual(exits, ['update']);
});

test('restart initiated inside a tracked request does not wait on itself', async () => {
  const { barrier, exits } = fixture();
  let restart;
  await barrier.run(async () => {
    restart = barrier.request('manual');
    assert.deepEqual(exits, []);
  });
  assert.equal(await restart, true);
  assert.deepEqual(exits, ['manual']);
});

test('timeout keeps restart pending, reopens admission and permits retry', async () => {
  const { barrier, exits, statuses } = fixture({ timeoutMs: 10 });
  const gate = deferred();
  const write = barrier.run(() => gate.promise);
  assert.equal(await barrier.request('update'), false);
  assert.deepEqual(exits, []);
  assert.equal(barrier.status().phase, 'pending');
  assert.match(statuses.at(-1).message, /pending/i);
  assert.equal(barrier.run(() => 42), 42);
  gate.resolve();
  await write;
  assert.equal(await barrier.request('retry'), true);
});

test('concurrent restarts coalesce and throwing work releases its lease', async () => {
  const { barrier, exits } = fixture();
  assert.throws(() => barrier.run(() => { throw new Error('write failed'); }), /write failed/);
  await assert.rejects(barrier.run(async () => { throw new Error('async failed'); }), /async failed/);
  assert.equal(barrier.inFlight(), 0);
  const first = barrier.request('first');
  const second = barrier.request('second');
  assert.equal(await first, true);
  assert.equal(await second, true);
  assert.deepEqual(exits, ['first']);
});

test('HTTP response survives a restart during a committed write; fresh requests get 503', async (t) => {
  const { barrier, exits } = fixture({ timeoutMs: 1000 });
  const started = deferred();
  const committed = deferred();
  const respond = deferred();
  const server = http.createServer(barrier.http(async (_req, res) => {
    started.resolve();
    await committed.promise;
    await respond.promise;
    res.end(JSON.stringify({ applied: true }));
  }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const response = fetch(url, { method: 'POST' });
  await started.promise;
  committed.resolve();
  const restart = barrier.request('extension update');
  const refused = await fetch(url, { method: 'POST' });
  assert.equal(refused.status, 503);
  assert.equal(refused.headers.get('retry-after'), '1');
  assert.equal((await refused.json()).retryable, true);
  await setImmediate();
  assert.deepEqual(exits, []);
  respond.resolve();
  assert.deepEqual(await (await response).json(), { applied: true });
  assert.equal(await restart, true);
});

test('HTTP disconnect does not release a still-running write', async (t) => {
  const { barrier, exits } = fixture({ timeoutMs: 1000 });
  const started = deferred();
  const finish = deferred();
  const server = http.createServer(barrier.http(async (_req, res) => {
    started.resolve();
    await finish.promise;
    res.end('done');
  }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const req = http.request({ host: '127.0.0.1', port: server.address().port, method: 'POST' });
  req.on('error', () => {});
  req.end();
  await started.promise;
  req.destroy();
  const restart = barrier.request('manual');
  await setImmediate();
  assert.deepEqual(exits, []);
  finish.resolve();
  assert.equal(await restart, true);
});

test('store wrapper preserves synchronous results and tracks asynchronous methods', async () => {
  const { barrier } = fixture();
  const gate = deferred();
  class Store {
    #value = 3;
    read() { return this.#value; }
    async write() { await gate.promise; this.#value += 1; }
  }
  const store = barrier.wrapStore(new Store());
  assert.equal(store.read(), 3);
  const write = store.write();
  const restart = barrier.request('update');
  assert.throws(() => store.write(), { code: 'restarting' });
  gate.resolve();
  await write;
  assert.equal(await restart, true);
});

test('automatic quiet checks include interactive turns, requests and scheduled launches', async () => {
  const { restartIsQuiet } = await import('./restart-barrier.js');
  const { barrier } = fixture();
  const quiet = (overrides = {}) => restartIsQuiet({ barrier, ...overrides });
  assert.equal(quiet(), true);
  assert.equal(quiet({ sessions: [{ status: 'working' }] }), false);
  assert.equal(quiet({ sessions: [{ status: 'idle' }] }), true);
  assert.equal(quiet({ headless: 1 }), false);
  assert.equal(quiet({ launching: true }), false);
  assert.equal(quiet({ due: [{}] }), false);
  barrier.run(() => assert.equal(quiet(), false));
});
