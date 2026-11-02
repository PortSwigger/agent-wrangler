import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStatusNoticeRunner } from './status-notice-runner.js';
import { createStatusWatcher } from './status-notices.js';
import { MailboxStore } from './mailbox-store.js';

const event = (id, to = 'p', kind = 'needs-you') => ({ child: { sessionId: id, label: `Child ${id}`, waitingFor: null }, to, kind });
function fixture(events) {
  const entries = { p: {}, q: {}, c: { statusNotify: { to: 'p' } } };
  const sent = [], cleared = [], forgotten = [], published = [], logs = [];
  let fail = false;
  const deps = {
    watcher: { tick: () => events, forget: (id) => forgotten.push(id) },
    mailStore: { sentSince: () => false, unreadInfo: () => ({ unread: 0 }) },
    sessionManager: { entryFor: (id) => entries[id], clearStatusNotify: (id) => { cleared.push(id); delete entries[id]?.statusNotify; } },
    deliver: async (to, body) => { if (fail) throw new Error('broken'); sent.push({ to, body }); return { mode: 'live' }; },
    events: { emit: (...args) => published.push(args) }, log: (...args) => logs.push(args),
  };
  const runner = createStatusNoticeRunner(deps);
  return { runner, deps, entries, sent, cleared, forgotten, published, logs, fail: (v) => { fail = v; } };
}

test('runner delivers one coalesced notice per subscriber and publishes unsubscribed events', async () => {
  const f = fixture([event('c'), event('d'), event('e', 'q'), event('f', null)]);
  await f.runner.run({ sessions: [] }, 123);
  assert.equal(f.sent.length, 2);
  assert.equal(f.sent[0].to, 'p');
  assert.match(f.sent[0].body, /Child c.*\n- Child d/);
  assert.equal(f.published.length, 4);
  assert.equal(f.published[0][0], 'session-status:needs-you');
});

for (const missing of [false, true]) {
  test(`an archived or missing subscriber drops the subscription even without a child event (${missing})`, async () => {
    const f = fixture([]);
    if (missing) delete f.entries.p;
    else f.entries.p.archivedAt = 1;
    await f.runner.run({ sessions: [{ sessionId: 'c' }] });
    assert.equal(f.sent.length, 0);
    assert.deepEqual(f.cleared, ['c']);
  });
}

test('an exited event clears the subscription after sending', async () => {
  const f = fixture([event('c', 'p', 'exited')]);
  await f.runner.run({ sessions: [] });
  assert.equal(f.sent.length, 1);
  assert.deepEqual(f.cleared, ['c']);
  assert.deepEqual(f.forgotten, ['c']);
});

test('a delivery error is logged, not thrown, until delivery succeeds', async () => {
  const f = fixture([event('c')]);
  f.fail(true);
  await f.runner.run({ sessions: [] });
  await f.runner.run({ sessions: [] });
  assert.equal(f.logs.length, 1);
  f.fail(false);
  await f.runner.run({ sessions: [] });
  f.fail(true);
  await f.runner.run({ sessions: [] });
  assert.equal(f.logs.length, 2);
});

test('idle hold is suppressed by mail from the child to the subscriber, including read mail', async (t) => {
  const f = fixture([]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-status-runner-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  f.deps.mailStore = new MailboxStore(path.join(dir, 'mail.json'));
  f.deps.watcher = createStatusWatcher();
  const runner = createStatusNoticeRunner(f.deps);
  const tick = (now, status) => runner.run({ sessions: [{ sessionId: 'c', label: 'Child c', managed: true, status }] }, now);
  await tick(0, 'working');
  await tick(1000, 'idle');
  f.deps.mailStore.append('p', { from: 'c', body: 'report' }, 51000);
  f.deps.mailStore.drain('p');
  const before = fs.readFileSync(f.deps.mailStore.file, 'utf8');
  await tick(61000, 'idle');
  await tick(121000, 'idle');
  assert.deepEqual(f.sent, []);
  assert.equal(f.published.length, 1);
  assert.deepEqual(f.published[0], ['session-status:idle-held', {
    sid: 'c', kind: 'idle-held', at: 61000, waitingFor: null,
    idleMs: 60000, quietMs: undefined, exitReason: undefined,
  }]);
  assert.equal(fs.readFileSync(f.deps.mailStore.file, 'utf8'), before);
});

for (const [kind, suffix, fields] of [
  ['idle', 'idle-held', { idleMs: 61000 }],
  ['needs-you', 'needs-you', {}],
  ['quiet', 'quiet', { quietMs: 900000 }],
  ['exited', 'exited', { exitReason: 'archived' }],
]) {
  test(`runner publishes ${suffix} for an unsubscribed session with the documented payload`, async () => {
    const e = event('unsubscribed', null, kind);
    e.child.waitingFor = 'Approve command';
    const f = fixture([{ ...e, ...fields }]);
    await f.runner.run({ sessions: [] }, 123);
    assert.deepEqual(f.published, [[`session-status:${suffix}`, {
      sid: 'unsubscribed', kind: suffix, at: 123, waitingFor: 'Approve command',
      idleMs: undefined, quietMs: undefined, exitReason: undefined, ...fields,
    }]]);
    assert.deepEqual(f.sent, []);
  });
}

test('a held notice surfaces after two minutes and clears when its queue drains', async () => {
  const f = fixture([event('c')]);
  let pending = true;
  f.deps.pending = () => pending;
  f.deps.deliver = async () => ({ mode: 'deferred', reason: 'composer not confirmed empty' });
  const runner = createStatusNoticeRunner(f.deps);
  await runner.run({ sessions: [] }, 0);
  assert.equal(runner.blocked('p', 119999), false);
  assert.equal(runner.blocked('p', 120000), true);
  pending = false;
  assert.equal(runner.blocked('p', 120001), false);
});

test('idle notices include the child unread count and final assistant text', async (t) => {
  const f = fixture([{ ...event('c', 'p', 'idle'), idleMs: 60000 }]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-status-detail-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bucket = path.join(dir, '-work-a');
  fs.mkdirSync(bucket);
  fs.writeFileSync(path.join(bucket, 'live.jsonl'), JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } }) + '\n');
  f.entries.c.liveSessionId = 'live';
  f.deps.historyOptions = { projectsDir: dir };
  f.deps.mailStore = new MailboxStore(path.join(dir, 'mail.json'));
  f.deps.mailStore.append('c', { from: 'p', body: 'question' });
  await createStatusNoticeRunner(f.deps).run({ sessions: [] });
  assert.match(f.sent[0].body, /Unread mail waiting for it: 1. Last said: "done"/);
});

test('overlapping runs serialize each subscriber without blocking other subscribers', async () => {
  const events = [event('c')];
  const f = fixture(events);
  const started = [];
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  f.deps.deliver = async (to) => {
    started.push(to);
    if (started.length === 1) await blocked;
    return { mode: 'live' };
  };
  const runner = createStatusNoticeRunner(f.deps);
  const first = runner.run({ sessions: [] });
  await new Promise(setImmediate);
  events.push(event('d', 'q'));
  const second = runner.run({ sessions: [] });
  try {
    await new Promise(setImmediate);
    assert.deepEqual(started, ['p', 'q']);
    assert.equal(f.published.length, 3);
  } finally {
    release();
    await Promise.all([first, second]);
  }
  assert.deepEqual(started, ['p', 'q', 'p']);
});

for (const mode of ['live', 'deferred', 'dormant']) {
  test(`only an actual dormant wake requests a rebuild (${mode})`, async () => {
    const f = fixture([event('c')]);
    const woke = [];
    f.deps.deliver = async () => ({ mode });
    f.deps.onWoken = async (to) => { woke.push(to); };
    await createStatusNoticeRunner(f.deps).run({ sessions: [] });
    assert.deepEqual(woke, mode === 'dormant' ? ['p'] : []);
  });
}

test('board rebuild proceeds while status notice delivery is pending', async () => {
  const source = fs.readFileSync(new URL('./index.js', import.meta.url), 'utf8');
  const invocation = source.split('\n').find((line) => line.includes('statusNotices.run(graph)'));
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  let broadcast = false;
  const run = new Function('statusNotices', 'graph', 'logError', `return (async () => { ${invocation}; return true; })();`);
  const rebuilding = run({ run: () => pending }, {}, () => {}).then(() => { broadcast = true; });
  try {
    await new Promise(setImmediate);
    assert.equal(broadcast, true);
  } finally {
    release();
    await rebuilding;
  }
});
