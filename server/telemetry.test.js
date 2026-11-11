import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTelemetry, repoSlug, QUEUE_MAX, BACKOFF_START_MS, BACKOFF_MAX_MS, QUEUE_MAX_AGE_MS, BUILTIN_ENDPOINT, REPO_OWNERS, BATCH_MAX } from './telemetry.js';
import { normaliseTelemetryDecl } from './extensions/telemetry-schema.js';

const noTimers = { setTimeout: () => ({}), clearTimeout: () => {}, setInterval: () => ({}), clearInterval: () => {} };

const DECL = normaliseTelemetryDecl({
  events: {
    'step.ended': { v: 1, fields: { kind: { enum: ['pr', 'session'] }, tries: { int: [0, 50] }, repo: { repo: true }, job: 'ref' } },
  },
}, ['telemetry:emit']);

const BUILTIN = 'https://collector.example.com/v1/events';

function setup({ url, env = {}, responses = [], clock = { t: Date.UTC(2026, 10, 10, 12, 0, 0, 400) } } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-telemetry-'));
  const file = path.join(dir, 'telemetry.json');
  const cfg = { telemetry: { ...(url ? { url } : {}) } };
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const r = responses.length ? responses.shift() : 200;
    if (r instanceof Error) throw r;
    return { status: r, text: async () => '' };
  };
  const t = createTelemetry({
    file,
    readConfig: () => cfg,
    fetchImpl,
    now: () => clock.t,
    env,
    builtinEndpoint: BUILTIN,
    repoOwners: ['acme'],
    awVersion: '0.1.0',
    timers: noTimers,
  });
  return { t, file, calls, clock, cfg: () => cfg };
}

function withDemo(t) {
  t.registerEmitter('demo', { version: '2.0.0', events: DECL.events });
}

const step = (t, over = {}) => ({ kind: 'pr', tries: 1, repo: t.repo('git@github.com:acme/widgets.git'), job: t.ref('job', 'job_1'), ...over });

test('an event from an extension reaches the built-in collector as the envelope plus its declared fields, with no credentials', async () => {
  const { t, calls } = setup();
  withDemo(t);
  assert.equal(t.emit('demo', 'step.ended', step(t)), true);
  await t.flush();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, BUILTIN);
  assert.equal(calls[0].init.method, 'POST');
  assert.deepEqual(calls[0].init.headers, { 'content-type': 'application/json' });
  const [ev] = calls[0].body.events;
  assert.match(ev.eventId, /^[0-9a-f-]{36}$/);
  assert.deepEqual({ ...ev, eventId: 'x' }, {
    eventId: 'x', ts: '2026-11-10T12:00:00Z', type: 'demo.step.ended', v: 1, install: t.install(),
    awVersion: '0.1.0', emitterVersion: '2.0.0', kind: 'pr', tries: 1, repo: 'acme/widgets', job: t.ref('job', 'job_1'),
  });
  assert.equal(t.status().queued, 0, 'a 2xx removes the batch');
  assert.equal(t.status().sink.sent, 1);
});

test('the built-in collector is the shipped prod URL, and only the report\'s repo owners are named', () => {
  assert.equal(BUILTIN_ENDPOINT, 'https://wrangler-telemetry.platform-prod.portswigger.io/v1/events');
  assert.deepEqual([...REPO_OWNERS], ['portswigger', 'portswigger-apps']);
  const t = createTelemetry({ file: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aw-telemetry-')), 't.json'), env: {}, timers: noTimers });
  assert.deepEqual(t.destination(), { url: BUILTIN_ENDPOINT, source: 'builtin', error: null });
});

test('AW_TELEMETRY_URL, then config telemetry.url, override the built-in URL', async () => {
  const a = setup({ env: { AW_TELEMETRY_URL: 'http://127.0.0.1:4318/v1/events' }, url: 'https://dev.example.com/v1/events' });
  withDemo(a.t);
  a.t.emit('demo', 'step.ended', step(a.t));
  await a.t.flush();
  assert.equal(a.calls[0].url, 'http://127.0.0.1:4318/v1/events');
  assert.equal(a.t.status().sink.source, 'env');
  assert.equal(a.t.status().sink.builtin, BUILTIN);

  const b = setup({ url: 'https://dev.example.com/v1/events' });
  withDemo(b.t);
  b.t.emit('demo', 'step.ended', step(b.t));
  await b.t.flush();
  assert.equal(b.calls[0].url, 'https://dev.example.com/v1/events');
  assert.equal(b.t.status().sink.source, 'config');
});

test('an override that is not a valid endpoint sends nothing rather than falling back', async () => {
  for (const url of ['http://collector.example.com/v1/events', 'https://user:pw@collector.example.com/', 'https://collector.example.com/?k=v', 'not a url']) {
    const { t, calls } = setup({ env: { AW_TELEMETRY_URL: url } });
    withDemo(t);
    assert.equal(t.on(), false, url);
    assert.equal(t.emit('demo', 'step.ended', step(t)), false, url);
    await t.flush();
    assert.equal(calls.length, 0, url);
    assert.ok(t.status().sink.error, url);
  }
});

test('telemetry is on from first run with no config, and a stale enabled:false in config does not turn it off', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-telemetry-'));
  for (const config of [{}, { telemetry: { enabled: false } }]) {
    const calls = [];
    const t = createTelemetry({
      file: path.join(dir, `${calls.length}-${Object.keys(config).length}.json`),
      readConfig: () => config,
      fetchImpl: async (url, init) => { calls.push(JSON.parse(init.body)); return { status: 200, text: async () => '' }; },
      builtinEndpoint: BUILTIN,
      timers: noTimers,
    });
    withDemo(t);
    assert.equal(t.on(), true);
    assert.equal(t.emit('demo', 'step.ended', step(t)), true);
    await t.flush();
    assert.equal(calls.length, 1, JSON.stringify(config));
    assert.equal('enabled' in t.status(), false);
  }
});

test('there is no way to switch telemetry off or discard the queue', () => {
  const { t } = setup();
  for (const name of ['setEnabled', 'enabled', 'clearQueue', 'disable', 'setTeam']) assert.equal(t[name], undefined, name);
});

test('emit throws on an undeclared event, an undeclared field or an ill-typed one, even under a broken override', () => {
  const { t } = setup({ env: { AW_TELEMETRY_URL: 'not a url' } });
  withDemo(t);
  assert.throws(() => t.emit('demo', 'nope', {}), /not declared/);
  assert.throws(() => t.emit('demo', 'step.ended', { ...step(t), prompt: 'fix the login bug' }), /"prompt" is not declared/);
  assert.throws(() => t.emit('demo', 'step.ended', step(t, { tries: 99 })), /field tries/);
  assert.throws(() => t.emit('demo', 'step.ended', step(t, { job: 'job_1' })), /field job must be a ref/);
  assert.throws(() => t.emit('stranger', 'step.ended', step(t)), /declares no telemetry events/);
});

test('a repo outside the allowed owners goes as other, and no event carries a team', async () => {
  const { t, calls } = setup();
  withDemo(t);
  t.emit('demo', 'step.ended', step(t, { repo: t.repo('https://github.com/SomeoneElse/private-thing') }));
  t.emit('demo', 'step.ended', step(t, { repo: t.repo('') }));
  await t.flush();
  const [a, b] = calls[0].body.events;
  assert.equal(a.repo, 'other');
  assert.equal(b.repo, 'none');
  assert.equal('team' in a, false);
});

test('5xx, 403, 404, 408, 429 and network errors retry with doubling backoff; other 4xx drop the batch', async () => {
  const { t, calls, clock } = setup({ responses: [503, new Error('ECONNREFUSED'), 429, 200] });
  withDemo(t);
  t.emit('demo', 'step.ended', step(t));
  await t.flush();
  assert.equal(calls.length, 1);
  assert.match(t.status().sink.lastError, /HTTP 503: retrying in 15s/);
  await t.flush();
  assert.equal(calls.length, 1, 'inside the backoff nothing is sent');
  clock.t += BACKOFF_START_MS;
  await t.flush();
  assert.equal(calls.length, 2);
  assert.match(t.status().sink.lastError, /retrying in 30s/);
  clock.t += 2 * BACKOFF_START_MS;
  await t.flush();
  assert.equal(calls.length, 3);
  assert.match(t.status().sink.lastError, /HTTP 429: retrying in 60s/);
  clock.t += 4 * BACKOFF_START_MS;
  await t.flush();
  assert.equal(calls.length, 4);
  assert.equal(t.status().queued, 0);
  assert.equal(t.status().sink.lastError, null);
  // Every retry re-sent the same event, so the collector can dedupe on eventId.
  assert.equal(new Set(calls.map((c) => c.body.events[0].eventId)).size, 1);

  const d = setup({ responses: [400] });
  withDemo(d.t);
  d.t.emit('demo', 'step.ended', step(d.t));
  await d.t.flush();
  assert.equal(d.t.status().queued, 0);
  assert.equal(d.t.status().sink.dropped, 1);
  assert.match(d.t.status().sink.lastError, /HTTP 400: batch of 1 refused and dropped/);
});

test('backoff is capped at an hour', async () => {
  const { t, clock } = setup({ responses: Array(20).fill(500) });
  withDemo(t);
  t.emit('demo', 'step.ended', step(t));
  for (let i = 0; i < 12; i += 1) {
    await t.flush();
    clock.t += BACKOFF_MAX_MS;
  }
  assert.match(t.status().sink.lastError, /retrying in 3600s/);
});

test('batches hold at most BATCH_MAX events, oldest first', async () => {
  const { t, calls } = setup();
  withDemo(t);
  for (let i = 0; i < BATCH_MAX * 2 + 1; i += 1) t.emit('demo', 'step.ended', step(t, { tries: i % 50 }));
  await t.flush();
  assert.deepEqual(calls.map((c) => c.body.events.length), [BATCH_MAX, BATCH_MAX, 1]);
  assert.deepEqual(calls[0].body.events.slice(0, 3).map((e) => e.tries), [0, 1, 2]);
});

test('off the office network the events stay queued: a 403 or an unreachable host retries, it never drops', async () => {
  const err = Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND' } });
  const { t, calls, clock } = setup({ responses: [403, err, 200] });
  withDemo(t);
  t.emit('demo', 'step.ended', step(t));
  await t.flush();
  assert.equal(t.status().queued, 1);
  assert.match(t.status().sink.lastError, /HTTP 403: retrying in 15s/);
  clock.t += BACKOFF_START_MS;
  await t.flush();
  assert.equal(t.status().queued, 1);
  assert.match(t.status().sink.lastError, /ENOTFOUND: retrying in 30s/);
  assert.equal(t.status().sink.dropped, 0);
  clock.t += 2 * BACKOFF_START_MS;
  await t.flush();
  assert.equal(calls.length, 3);
  assert.equal(t.status().queued, 0);
});

test('a new URL is tried at once, not after the old one\'s backoff', async () => {
  const s = setup({ responses: [503, 200] });
  withDemo(s.t);
  s.t.emit('demo', 'step.ended', step(s.t));
  await s.t.flush();
  s.cfg().telemetry.url = 'http://localhost:4318/v1/events';
  await s.t.flush();
  assert.deepEqual(s.calls.map((c) => c.url), [BUILTIN, 'http://localhost:4318/v1/events']);
  assert.equal(s.t.status().queued, 0);
});

test('before each send, fields the catalogue no longer declares are stripped', async () => {
  const { t, calls, clock } = setup({ responses: [503, 200] });
  withDemo(t);
  t.emit('demo', 'step.ended', step(t));
  await t.flush();
  const narrower = normaliseTelemetryDecl({ events: { 'step.ended': { v: 1, fields: { kind: { enum: ['pr', 'session'] }, tries: { int: [0, 50] }, repo: { repo: true } } } } }, ['telemetry:emit']);
  t.registerEmitter('demo', { version: '2.0.1', events: narrower.events });
  clock.t += BACKOFF_START_MS;
  await t.flush();
  assert.equal(calls.length, 2);
  const sent = calls[1].body.events[0];
  assert.equal('job' in calls[0].body.events[0], true);
  assert.equal('job' in sent, false);
  assert.equal(sent.tries, 1);
});

test('an event that no longer fits its catalogue, or whose emitter has gone, is dropped rather than sent', async () => {
  const { t, calls, clock } = setup({ responses: [503, 200] });
  withDemo(t);
  t.emit('demo', 'step.ended', step(t));
  await t.flush();
  const bumped = normaliseTelemetryDecl({ events: { 'step.ended': { v: 2, fields: { kind: { enum: ['pr'] } } } } }, ['telemetry:emit']);
  t.registerEmitter('demo', { version: '3.0.0', events: bumped.events });
  clock.t += BACKOFF_START_MS;
  await t.flush();
  assert.equal(calls.length, 1, 'a v1 event is not sent under a v2 catalogue');
  assert.equal(t.status().queued, 0);
  assert.equal(t.status().sink.dropped, 1);

  t.emit('demo', 'step.ended', { kind: 'pr' });
  t.unregisterEmitter('demo');
  await t.flush();
  assert.equal(calls.length, 1, 'an event whose emitter has gone is not sent');
  assert.equal(t.status().queued, 0);
  assert.equal(t.status().sink.dropped, 2);
});

test('the queue is capped at its size and age, oldest dropped first', () => {
  const { t, clock, file } = setup({ responses: [] });
  withDemo(t);
  t.emit('demo', 'step.ended', step(t, { tries: 0 }));
  clock.t += QUEUE_MAX_AGE_MS + 1;
  for (let i = 0; i < QUEUE_MAX + 3; i += 1) t.emit('demo', 'step.ended', step(t, { tries: 1 }));
  assert.equal(t.status().queued, QUEUE_MAX);
  t.saveNow();
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).queue.some((q) => q.e.data.tries === 0), false);
});

test('the queue, install id and secret survive a restart; the file is private', async () => {
  const { t, file } = setup({ responses: [503] });
  withDemo(t);
  t.emit('demo', 'step.ended', step(t));
  await t.flush();
  t.saveNow();
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const again = createTelemetry({ file, readConfig: () => ({}), timers: noTimers });
  assert.equal(again.install(), t.install());
  assert.equal(again.ref('job', 'job_1'), t.ref('job', 'job_1'));
  assert.equal(again.status().queued, 1);
});

test('refs are stable per install, differ between installs, and never contain the id', () => {
  const a = setup().t;
  const b = setup().t;
  assert.equal(a.ref('job', 'job_1'), a.ref('job', 'job_1'));
  assert.notEqual(a.ref('job', 'job_1'), a.ref('session', 'job_1'));
  assert.notEqual(a.ref('job', 'job_1'), b.ref('job', 'job_1'));
  assert.match(a.ref('job', 'job_1'), /^[0-9a-f]{16}$/);
  assert.throws(() => a.ref('job', ''), /required/);
});

test('repoSlug reads slugs and remotes, and refuses paths', () => {
  assert.equal(repoSlug('acme/Widgets'), 'acme/widgets');
  assert.equal(repoSlug('git@github.com:acme/widgets.git'), 'acme/widgets');
  assert.equal(repoSlug('https://github.com/acme/widgets'), 'acme/widgets');
  assert.equal(repoSlug('ssh://git@github.com/acme/widgets.git'), 'acme/widgets');
  assert.equal(repoSlug('/Users/me/src/widgets/deeper'), null);
  assert.equal(repoSlug('not a repo'), null);
});

test('status shows the URL in use and where it came from, with no team', () => {
  const { t } = setup({ responses: [] });
  withDemo(t);
  t.emit('demo', 'step.ended', step(t));
  const st = t.status();
  assert.equal(st.queued, 1);
  assert.equal(st.sink.url, BUILTIN);
  assert.equal(st.sink.source, 'builtin');
  assert.equal('teams' in st || 'team' in st, false);
});

test('an invalid override is logged once, not on every flush', async () => {
  const logs = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-telemetry-'));
  const t = createTelemetry({ file: path.join(dir, 't.json'), env: { AW_TELEMETRY_URL: 'http://collector.example.com/' }, log: (m) => logs.push(m), timers: noTimers });
  await t.flush();
  await t.flush();
  assert.equal(logs.length, 1);
  assert.match(logs[0], /not sending: AW_TELEMETRY_URL or telemetry\.url is not a valid endpoint/);
});
