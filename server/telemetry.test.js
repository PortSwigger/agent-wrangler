import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTelemetry, repoSlug, QUEUE_MAX, BACKOFF_START_MS, BACKOFF_MAX_MS, QUEUE_MAX_AGE_MS } from './telemetry.js';
import { normaliseTelemetryDecl } from './extensions/telemetry-schema.js';

const noTimers = { setTimeout: () => ({}), clearTimeout: () => {}, setInterval: () => ({}), clearInterval: () => {} };

const DECL = normaliseTelemetryDecl({
  events: {
    'step.ended': { v: 1, fields: { kind: { enum: ['pr', 'session'] }, tries: { int: [0, 50] }, repo: { repo: true }, job: 'ref' } },
  },
  sinks: [{ id: 'main', endpoint: 'https://collector.example.com/v1/events', accepts: ['demo.*'], repoOwners: ['acme'], teams: ['platform', 'web'], headers: { 'X-Ingest-Token': 'tok' } }],
}, ['telemetry:emit', 'telemetry:sink']);

function setup({ enabled = true, team = null, responses = [], clock = { t: Date.UTC(2026, 10, 10, 12, 0, 0, 400) } } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-telemetry-'));
  const file = path.join(dir, 'telemetry.json');
  let cfg = { telemetry: { enabled, team } };
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
    writeConfig: (patch) => { cfg = { ...cfg, ...patch }; },
    fetchImpl,
    now: () => clock.t,
    awVersion: '0.1.0',
    timers: noTimers,
  });
  return { t, file, calls, clock, cfg: () => cfg };
}

function withDemo(t, { sinks = true } = {}) {
  t.registerEmitter('demo', { version: '2.0.0', events: DECL.events });
  if (sinks) t.registerSinks('privsink', { label: 'Private sink', sinks: DECL.sinks });
}

const step = (t, over = {}) => ({ kind: 'pr', tries: 1, repo: t.repo('git@github.com:acme/widgets.git'), job: t.ref('job', 'job_1'), ...over });

test('an event from an extension reaches its sink as the envelope plus its declared fields', async () => {
  const { t, calls } = setup({ team: 'web' });
  withDemo(t);
  assert.equal(t.emit('demo', 'step.ended', step(t)), true);
  await t.flush();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://collector.example.com/v1/events');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['content-type'], 'application/json');
  assert.equal(calls[0].init.headers['X-Ingest-Token'], 'tok');
  const [ev] = calls[0].body.events;
  assert.match(ev.eventId, /^[0-9a-f-]{36}$/);
  assert.deepEqual({ ...ev, eventId: 'x' }, {
    eventId: 'x', ts: '2026-11-10T12:00:00Z', type: 'demo.step.ended', v: 1, install: t.install(), team: 'web',
    awVersion: '0.1.0', emitterVersion: '2.0.0', kind: 'pr', tries: 1, repo: 'acme/widgets', job: t.ref('job', 'job_1'),
  });
  assert.equal(t.status().queued, 0, 'a 2xx removes the batch');
  assert.equal(t.status().sinks[0].sent, 1);
});

test('nothing is queued or sent without a sink, or while the switch is off', async () => {
  const a = setup();
  withDemo(a.t, { sinks: false });
  assert.equal(a.t.on(), false);
  assert.equal(a.t.emit('demo', 'step.ended', step(a.t)), false);
  await a.t.flush();
  assert.equal(a.calls.length, 0);
  assert.equal(a.t.status().queued, 0);

  const b = setup({ enabled: false });
  withDemo(b.t);
  assert.equal(b.t.on(), false);
  assert.equal(b.t.emit('demo', 'step.ended', step(b.t)), false);
  await b.t.flush();
  assert.equal(b.calls.length, 0);
});

test('emit throws on an undeclared event, an undeclared field or an ill-typed one, even while off', () => {
  const { t } = setup({ enabled: false });
  withDemo(t);
  assert.throws(() => t.emit('demo', 'nope', {}), /not declared/);
  assert.throws(() => t.emit('demo', 'step.ended', { ...step(t), prompt: 'fix the login bug' }), /"prompt" is not declared/);
  assert.throws(() => t.emit('demo', 'step.ended', step(t, { tries: 99 })), /field tries/);
  assert.throws(() => t.emit('demo', 'step.ended', step(t, { job: 'job_1' })), /field job must be a ref/);
  assert.throws(() => t.emit('stranger', 'step.ended', step(t)), /declares no telemetry events/);
});

test('switching off drops the queue; switching on starts empty', async () => {
  const { t, calls } = setup({ responses: [503] });
  withDemo(t);
  t.emit('demo', 'step.ended', step(t));
  await t.flush();
  assert.equal(t.status().queued, 1);
  t.setEnabled(false);
  assert.equal(t.status().queued, 0);
  assert.equal(t.status().enabled, false);
  t.setEnabled(true);
  await t.flush();
  assert.equal(calls.length, 1, 'the dropped event is never sent');
});

test('a repo outside the sink\'s owners goes as other, and a team the sink does not list goes as null', async () => {
  const { t, calls } = setup({ team: 'unknown-team' });
  withDemo(t);
  t.emit('demo', 'step.ended', step(t, { repo: t.repo('https://github.com/SomeoneElse/private-thing') }));
  t.emit('demo', 'step.ended', step(t, { repo: t.repo('') }));
  await t.flush();
  const [a, b] = calls[0].body.events;
  assert.equal(a.repo, 'other');
  assert.equal(b.repo, 'none');
  assert.equal(a.team, null);
});

test('5xx, 404, 408, 429 and network errors retry with doubling backoff; other 4xx drop the batch', async () => {
  const { t, calls, clock } = setup({ responses: [503, new Error('ECONNREFUSED'), 429, 200] });
  withDemo(t);
  t.emit('demo', 'step.ended', step(t));
  await t.flush();
  assert.equal(calls.length, 1);
  assert.match(t.status().sinks[0].lastError, /HTTP 503: retrying in 15s/);
  await t.flush();
  assert.equal(calls.length, 1, 'inside the backoff nothing is sent');
  clock.t += BACKOFF_START_MS;
  await t.flush();
  assert.equal(calls.length, 2);
  assert.match(t.status().sinks[0].lastError, /retrying in 30s/);
  clock.t += 2 * BACKOFF_START_MS;
  await t.flush();
  assert.equal(calls.length, 3);
  assert.match(t.status().sinks[0].lastError, /HTTP 429: retrying in 60s/);
  clock.t += 4 * BACKOFF_START_MS;
  await t.flush();
  assert.equal(calls.length, 4);
  assert.equal(t.status().queued, 0);
  assert.equal(t.status().sinks[0].lastError, null);
  // Every retry re-sent the same event, so the collector can dedupe on eventId.
  assert.equal(new Set(calls.map((c) => c.body.events[0].eventId)).size, 1);

  const d = setup({ responses: [400] });
  withDemo(d.t);
  d.t.emit('demo', 'step.ended', step(d.t));
  await d.t.flush();
  assert.equal(d.t.status().queued, 0);
  assert.equal(d.t.status().sinks[0].dropped, 1);
  assert.match(d.t.status().sinks[0].lastError, /HTTP 400: batch of 1 refused and dropped/);
});

test('backoff is capped at an hour', async () => {
  const { t, clock } = setup({ responses: Array(20).fill(500) });
  withDemo(t);
  t.emit('demo', 'step.ended', step(t));
  for (let i = 0; i < 12; i += 1) {
    await t.flush();
    clock.t += BACKOFF_MAX_MS;
  }
  assert.match(t.status().sinks[0].lastError, /retrying in 3600s/);
});

test('batches hold at most batchMax events', async () => {
  const { t, calls } = setup();
  t.registerEmitter('demo', { version: '2.0.0', events: DECL.events });
  t.registerSinks('privsink', { sinks: [{ ...DECL.sinks[0], batchMax: 2 }] });
  for (let i = 0; i < 5; i += 1) t.emit('demo', 'step.ended', step(t, { tries: i }));
  await t.flush();
  assert.deepEqual(calls.map((c) => c.body.events.length), [2, 2, 1]);
  assert.deepEqual(calls.flatMap((c) => c.body.events.map((e) => e.tries)), [0, 1, 2, 3, 4], 'oldest first');
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
  assert.equal(t.status().sinks[0].dropped, 1);

  t.emit('demo', 'step.ended', { kind: 'pr' });
  t.unregisterEmitter('demo');
  assert.equal(t.preview().length, 0);
});

test('removing a sink drops the events only it was waiting for', async () => {
  const { t } = setup({ responses: [503] });
  withDemo(t);
  t.emit('demo', 'step.ended', step(t));
  t.unregisterSinks('privsink');
  assert.equal(t.status().queued, 0);
  assert.equal(t.on(), false);
});

test('the queue is capped at its size and age, oldest dropped first', () => {
  const { t, clock } = setup({ responses: [] });
  withDemo(t);
  t.emit('demo', 'step.ended', step(t, { tries: 0 }));
  clock.t += QUEUE_MAX_AGE_MS + 1;
  for (let i = 0; i < QUEUE_MAX + 3; i += 1) t.emit('demo', 'step.ended', step(t, { tries: 1 }));
  assert.equal(t.status().queued, QUEUE_MAX);
  assert.equal(t.preview(QUEUE_MAX).some((p) => p.event.tries === 0), false);
});

test('the queue, install id and secret survive a restart; the file is private', async () => {
  const { t, file } = setup({ responses: [503] });
  withDemo(t);
  t.emit('demo', 'step.ended', step(t));
  await t.flush();
  t.saveNow();
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const again = createTelemetry({ file, readConfig: () => ({ telemetry: { enabled: true } }), timers: noTimers });
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

test('status shows each sink\'s host and header names but never header values; preview shows events as they would leave', () => {
  const { t } = setup({ responses: [] });
  withDemo(t);
  t.emit('demo', 'step.ended', step(t));
  const st = t.status();
  assert.equal(st.sinks[0].host, 'collector.example.com');
  assert.deepEqual(st.sinks[0].headerNames, ['X-Ingest-Token']);
  assert.equal(JSON.stringify(st).includes('tok"'), false);
  assert.deepEqual(st.teams, ['platform', 'web']);
  assert.deepEqual(st.emitters[0].events, [{ type: 'demo.step.ended', v: 1, fields: ['kind', 'tries', 'repo', 'job'] }]);
  const [p] = t.preview();
  assert.equal(p.sink, 'collector.example.com');
  assert.equal(p.event.type, 'demo.step.ended');
  t.clearQueue();
  assert.equal(t.preview().length, 0);
});

test('setTeam takes only a team some sink offers', () => {
  const s = setup();
  withDemo(s.t);
  s.t.setTeam('platform');
  assert.equal(s.cfg().telemetry.team, 'platform');
  s.t.setTeam('made-up');
  assert.equal(s.cfg().telemetry.team, null);
});

test('sinkStatus is narrowed to one extension\'s own sinks', () => {
  const { t } = setup();
  withDemo(t);
  t.registerSinks('other', { sinks: [{ ...DECL.sinks[0], id: 'theirs' }] });
  assert.deepEqual(t.sinkStatus('privsink').map((s) => s.id), ['main']);
});
