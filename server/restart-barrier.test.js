import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { setImmediate } from 'node:timers/promises';
import { createRestartBarrier, formatAge } from './restart-barrier.js';

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
  assert.equal(barrier.draining(), false);
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

test('store proxy binds methods to the underlying store and preserves non-function property identity', () => {
  const { barrier } = fixture();
  const bookkeeping = new WeakMap();
  const raw = {
    identity: {},
    label: 'example',
    count: 0,
    optional: null,
    remember(value) { bookkeeping.set(this.identity, value); return this; },
  };
  const store = barrier.wrapStore(raw);

  assert.notStrictEqual(store, raw);
  assert.strictEqual(store.remember('saved'), raw);
  assert.strictEqual(store.identity, raw.identity);
  assert.equal(bookkeeping.get(store.identity), 'saved');
  assert.equal(store.label, 'example');
  assert.equal(store.count, 0);
  assert.equal(store.optional, null);
  assert.equal(store.missing, undefined);
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

// A clock the test can jump forward, so an op can be "seven minutes old"
// without waiting seven minutes.
function clock() {
  let skew = 0;
  return { now: () => Date.now() + skew, advance: (ms) => { skew += ms; } };
}

test('formatAge renders seconds, minutes and hours', () => {
  assert.equal(formatAge(0), '0s');
  assert.equal(formatAge(45_000), '45s');
  assert.equal(formatAge(7 * 60_000 + 30_000), '7m');
  assert.equal(formatAge(2 * 3_600_000), '2h');
  assert.equal(formatAge(2 * 3_600_000 + 5 * 60_000), '2h5m');
});

test('timed-out drain lists every outstanding label with its age and logs each one', async () => {
  const time = clock();
  const logs = [];
  const { barrier, exits, statuses } = fixture({ timeoutMs: 20, now: time.now, log: (line) => logs.push(line) });
  const tool = deferred();
  const sweep = deferred();
  const toolRun = barrier.run(() => tool.promise, 'mcp:spawn_workflow');
  time.advance(7 * 60_000);
  const sweepRun = barrier.run(() => sweep.promise, 'sweep:jobs:tick');
  time.advance(45_000);
  assert.equal(await barrier.request('auto-updated jobs'), false);
  assert.deepEqual(exits, []);
  const status = statuses.at(-1);
  assert.equal(status.phase, 'pending');
  assert.equal(status.message, 'Restart pending: mcp:spawn_workflow (7m), sweep:jobs:tick (45s)');
  assert.deepEqual(status.running.map((r) => r.label), ['mcp:spawn_workflow', 'sweep:jobs:tick']);
  assert.equal(logs.length, 2);
  assert.match(logs[0], /still running .*mcp:spawn_workflow \(7m\)/);
  assert.match(logs[1], /still running .*sweep:jobs:tick \(45s\)/);
  tool.resolve();
  sweep.resolve();
  await Promise.all([toolRun, sweepRun]);
  assert.deepEqual(barrier.outstanding(), []);
});

test('forced board restart drains for the full timeout, refuses new work, then exits naming what it cut short', async () => {
  const time = clock();
  const { barrier, exits, statuses } = fixture({ timeoutMs: 60, now: time.now });
  const stuck = deferred();
  barrier.run(() => stuck.promise, 'mcp:spawn_workflow');
  time.advance(7 * 60_000);
  const started = Date.now();
  const restart = barrier.request('restart requested from the board', { force: true });
  assert.throws(() => barrier.run(() => assert.fail('new work ran'), 'http:/pr-attach'), { code: 'restarting' });
  await setImmediate();
  assert.deepEqual(exits, []);
  assert.equal(await restart, true);
  assert.ok(Date.now() - started >= 55, 'waited the full drain timeout before forcing');
  assert.deepEqual(exits, ['restart requested from the board']);
  const status = statuses.at(-1);
  assert.equal(status.phase, 'restarting');
  assert.equal(status.message, 'Forcing restart; still running: mcp:spawn_workflow (7m)');
  stuck.resolve();
});

test('a forced restart upgrades an unforced drain already in progress', async () => {
  const { barrier, exits, statuses } = fixture({ timeoutMs: 40 });
  const stuck = deferred();
  barrier.run(() => stuck.promise, 'headless:classify');
  const auto = barrier.request('auto-updated jobs');
  const manual = barrier.request('restart requested from the board', { force: true });
  assert.equal(manual, auto);
  assert.equal(await manual, true);
  assert.deepEqual(exits, ['auto-updated jobs']);
  assert.match(statuses.at(-1).message, /^Forcing restart; still running: headless:classify/);
  stuck.resolve();
});

test('repeated unattended restarts keep giving up while work is stuck', async () => {
  const { barrier, exits } = fixture({ timeoutMs: 20 });
  const stuck = deferred();
  barrier.run(() => stuck.promise, 'rebuild');
  assert.equal(await barrier.request('auto-updated jobs'), false);
  assert.equal(await barrier.request('updated to abc1234'), false);
  assert.deepEqual(exits, []);
  stuck.resolve();
});

test('labels are released on sync throw, async reject and success', async () => {
  const { barrier } = fixture();
  const seen = [];
  assert.throws(() => barrier.run(() => {
    seen.push(barrier.outstanding().map((o) => o.label));
    throw new Error('sync boom');
  }, 'ext-store:jobs.save'), /sync boom/);
  assert.deepEqual(barrier.outstanding(), []);

  const reject = deferred();
  const failing = barrier.run(async () => { await reject.promise; throw new Error('async boom'); }, 'mcp:spawn_session');
  assert.deepEqual(barrier.outstanding().map((o) => o.label), ['mcp:spawn_session']);
  reject.resolve();
  await assert.rejects(failing, /async boom/);
  assert.deepEqual(barrier.outstanding(), []);

  assert.equal(barrier.run(() => 'sync ok', 'control:restart-server'), 'sync ok');
  assert.deepEqual(barrier.outstanding(), []);

  const ok = deferred();
  const succeeding = barrier.run(() => ok.promise, 'sweep:jobs:tick');
  assert.deepEqual(barrier.outstanding().map((o) => o.label), ['sweep:jobs:tick']);
  ok.resolve('async ok');
  assert.equal(await succeeding, 'async ok');
  assert.deepEqual(barrier.outstanding(), []);
  assert.deepEqual(seen, [['ext-store:jobs.save']]);
  assert.equal(barrier.inFlight(), 0);
});

test('HTTP and store wrappers label their work by route and method', async (t) => {
  const { barrier } = fixture();
  const seen = [];
  const store = barrier.wrapStore({ save() { seen.push(barrier.outstanding().map((o) => o.label)); } }, 'ext-store:jobs');
  store.save();
  const server = http.createServer(barrier.http((_req, res) => {
    seen.push(barrier.outstanding().map((o) => o.label));
    res.end('ok');
  }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  await (await fetch(`http://127.0.0.1:${server.address().port}/status-event?x=1`, { method: 'POST' })).text();
  assert.deepEqual(seen, [['ext-store:jobs.save'], ['http:/status-event']]);
});

test('an untracked HTTP stream is refused while draining but never holds a restart', async (t) => {
  const { barrier, exits } = fixture();
  const opened = deferred();
  const server = http.createServer(barrier.http((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(':\n\n');
    opened.resolve();
  }, 'http:/stream', { track: false }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const ac = new AbortController();
  t.after(() => ac.abort());
  await fetch(url, { signal: ac.signal });
  await opened.promise;
  assert.equal(barrier.inFlight(), 0);
  const restart = barrier.request('update');
  assert.equal((await fetch(url)).status, 503);
  assert.equal(await restart, true);
  assert.deepEqual(exits, ['update']);
});
