import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStatusWatcher, IDLE_HOLD_MS, QUIET_MS } from './status-notices.js';

const node = (over = {}) => ({ sessionId: 'c', label: 'Child', status: 'idle', waitingFor: null, exitOutput: null, managed: true, lastActivity: null, ...over });
function fixture(entry = { statusNotify: { to: 'p', since: 0 } }) {
  const watcher = createStatusWatcher();
  let current = entry;
  let reported = false;
  const tick = (now, over = {}) => watcher.tick(over === null ? [] : [node(over)], () => current, { now, mailSince: (c, p, since) => reported && c === 'c' && p === 'p' && since === 0 });
  return { watcher, tick, mail: () => { reported = true; }, entry: (e) => { current = e; } };
}

test('first tick seeds and emits nothing', () => {
  const f = fixture();
  assert.deepEqual(f.tick(0, { status: 'needs-you' }), []);
  assert.deepEqual(f.tick(100000), []);
});

test('a new child first seen needing help after the restart baseline notifies immediately', () => {
  const f = fixture();
  f.tick(0, null);
  const [event] = f.tick(1, { status: 'needs-you', waitingFor: 'Trust this folder' });
  assert.equal(event.kind, 'needs-you');
  assert.equal(event.to, 'p');
  assert.equal(event.child.waitingFor, 'Trust this folder');
  assert.deepEqual(f.tick(2, { status: 'needs-you' }), []);
});

test('newly discovered startup idle stays silent and an already exited child reports once', () => {
  const f = fixture();
  f.tick(0, null);
  assert.deepEqual(f.tick(1), []);
  assert.deepEqual(f.tick(120001), []);
  const exited = fixture();
  exited.tick(0, null);
  assert.equal(exited.tick(1, { exitOutput: 'done' })[0].kind, 'exited');
  assert.deepEqual(exited.tick(2, { exitOutput: 'done' }), []);
});

test('idle notice after the hold once the child has worked, once per episode', () => {
  const f = fixture();
  f.tick(0, { status: 'working' });
  f.tick(1000);
  assert.deepEqual(f.tick(60999), []);
  const [event] = f.tick(61000);
  assert.equal(event.kind, 'idle');
  assert.equal(event.to, 'p');
  assert.equal(event.idleMs, IDLE_HOLD_MS);
  assert.deepEqual(f.tick(121000), []);
  f.tick(122000, { status: 'working' });
  f.tick(123000);
  assert.equal(f.tick(183000)[0].kind, 'idle');
});

test('no idle notice before the child has worked', () => {
  const f = fixture();
  f.tick(0);
  assert.deepEqual(f.tick(120000), []);
});

test('idle hold records mail from the child to the subscriber without suppressing the event', () => {
  const f = fixture();
  f.tick(0, { status: 'working' });
  f.tick(1000);
  f.mail();
  const events = f.tick(61000);
  assert.equal(events[0].reported, true);
  assert.equal(events.length, 1);
  assert.deepEqual(f.tick(121000), []);
});

test('needs-you emits on the transition only', () => {
  const f = fixture();
  f.tick(0, { status: 'working' });
  assert.equal(f.tick(1, { status: 'needs-you', waitingFor: 'approval' })[0].child.waitingFor, 'approval');
  assert.deepEqual(f.tick(2, { status: 'needs-you' }), []);
  f.tick(3);
  assert.equal(f.tick(4, { status: 'needs-you' })[0].kind, 'needs-you');
});

for (const reason of ['exited', 'archived', 'gone']) {
  test(`exited on ${reason}, once even after forget`, () => {
    const f = fixture();
    f.tick(0, { status: 'working' });
    if (reason === 'archived') f.entry({ archivedAt: 1, statusNotify: { to: 'p' } });
    if (reason === 'gone') f.entry(undefined);
    const over = reason === 'exited' ? { exitOutput: 'done' } : null;
    const [event] = f.tick(1, over);
    assert.equal(event.kind, 'exited');
    assert.equal(event.exitReason, reason);
    assert.equal(event.to, 'p');
    f.watcher.forget('c');
    assert.deepEqual(f.tick(2, over), []);
    assert.deepEqual(f.tick(3, over), []);
  });
}

test('exit beats idle in the same rebuild', () => {
  const f = fixture();
  f.tick(0, { status: 'working' });
  f.tick(1000);
  const events = f.tick(61000, { exitOutput: 'bye' });
  assert.deepEqual(events.map((e) => e.kind), ['exited']);
});

test('quiet after QUIET_MS of working with stale lastActivity, once per episode', () => {
  const f = fixture();
  f.tick(0, { status: 'working', lastActivity: 0 });
  assert.deepEqual(f.tick(QUIET_MS - 1, { status: 'working', lastActivity: 0 }), []);
  assert.equal(f.tick(QUIET_MS, { status: 'working', lastActivity: 0 })[0].quietMs, QUIET_MS);
  assert.deepEqual(f.tick(QUIET_MS + 1, { status: 'working', lastActivity: 0 }), []);
  f.tick(QUIET_MS + 2);
  assert.equal(f.tick(QUIET_MS + 3, { status: 'working', lastActivity: 0 })[0].kind, 'quiet');
});

test('missing activity never yields quiet', () => {
  const f = fixture();
  f.tick(0, { status: 'working' });
  assert.deepEqual(f.tick(QUIET_MS * 2, { status: 'working' }), []);
});

test('a session without statusNotify still yields events, with to null', () => {
  const f = fixture({});
  f.tick(0, { status: 'working' });
  assert.equal(f.tick(1, { status: 'needs-you' })[0].to, null);
});

test('a background shell keeps an idle card out of the hold', () => {
  const f = fixture();
  f.tick(0, { status: 'working' });
  assert.deepEqual(f.tick(1000, { hasBackgroundShell: true }), []);
  assert.deepEqual(f.tick(121000, { hasBackgroundShell: true }), []);
  assert.deepEqual(f.tick(122000), []);
  assert.deepEqual(f.tick(181999), []);
  assert.equal(f.tick(182000)[0].kind, 'idle');
});

test('dormant counts as idle', () => {
  const f = fixture();
  f.tick(0, { status: 'working' });
  f.tick(1000, { managed: false, status: 'unknown' });
  assert.equal(f.tick(61000, { managed: false, status: 'unknown' })[0].kind, 'idle');
});

test('unknown neither starts nor ends an idle episode', () => {
  const f = fixture();
  f.tick(0, { status: 'working' });
  f.tick(1000);
  assert.deepEqual(f.tick(61000, { status: 'unknown' }), []);
  assert.equal(f.tick(62000)[0].idleMs, 61000);
});

test('a resumed exited card can start new episodes', () => {
  const f = fixture();
  f.tick(0, { status: 'working' });
  f.tick(1, { exitOutput: 'done' });
  f.watcher.forget('c');
  f.tick(2, { status: 'working' });
  assert.equal(f.tick(3, { status: 'needs-you' })[0].kind, 'needs-you');
});

test('unknown preserves needs-you and quiet episodes until a known transition', () => {
  const f = fixture();
  f.tick(0, { status: 'working' });
  assert.equal(f.tick(1, { status: 'needs-you' })[0]?.kind, 'needs-you');
  assert.deepEqual(f.tick(2, { status: 'unknown' }), []);
  assert.deepEqual(f.tick(3, { status: 'needs-you' }), []);
  f.tick(4);
  assert.equal(f.tick(5, { status: 'needs-you' })[0]?.kind, 'needs-you');
  f.tick(6, { status: 'working', lastActivity: 0 });
  assert.equal(f.tick(QUIET_MS, { status: 'working', lastActivity: 0 })[0]?.kind, 'quiet');
  assert.deepEqual(f.tick(QUIET_MS + 1, { status: 'unknown' }), []);
  assert.deepEqual(f.tick(QUIET_MS + 2, { status: 'working', lastActivity: 0 }), []);
});

test('resume starts a fresh quiet interval even when transcript activity is old', () => {
  const f = fixture();
  f.tick(0, { status: 'working', lastActivity: 0 });
  const resumed = QUIET_MS * 2;
  f.entry({ statusNotify: { to: 'p', since: 0 }, relaunchedAt: resumed });
  assert.deepEqual(f.tick(resumed, { status: 'working', lastActivity: 0 }), []);
  assert.deepEqual(f.tick(resumed + QUIET_MS - 1, { status: 'working', lastActivity: 0 }), []);
  assert.equal(f.tick(resumed + QUIET_MS, { status: 'working', lastActivity: 0 })[0]?.quietMs, QUIET_MS);
});

test('new transcript activity after resume restarts the quiet interval', () => {
  const resumed = QUIET_MS * 2;
  const f = fixture({ relaunchedAt: resumed });
  f.tick(resumed, { status: 'working', lastActivity: 0 });
  const written = resumed + 1000;
  assert.deepEqual(f.tick(resumed + QUIET_MS, { status: 'working', lastActivity: written }), []);
  assert.equal(f.tick(written + QUIET_MS, { status: 'working', lastActivity: written })[0]?.quietMs, QUIET_MS);
});

test('a launch without transcript activity can go quiet after the launch interval', () => {
  const f = fixture({ createdAt: 1000 });
  f.tick(1000, { status: 'working' });
  assert.deepEqual(f.tick(1000 + QUIET_MS - 1, { status: 'working' }), []);
  assert.equal(f.tick(1000 + QUIET_MS, { status: 'working' })[0]?.quietMs, QUIET_MS);
});

test('a resume rearms quiet notices after a previous quiet episode', () => {
  const f = fixture();
  f.tick(0, { status: 'working', lastActivity: 0 });
  assert.equal(f.tick(QUIET_MS, { status: 'working', lastActivity: 0 })[0]?.kind, 'quiet');
  const resumed = QUIET_MS * 2;
  f.entry({ relaunchedAt: resumed });
  assert.deepEqual(f.tick(resumed, { status: 'working', lastActivity: 0 }), []);
  assert.equal(f.tick(resumed + QUIET_MS, { status: 'working', lastActivity: 0 })[0]?.quietMs, QUIET_MS);
});


test('idle notice detects mail from the preceding working period, excluding older mail', () => {
  for (const mailAt of [500, 51000, -1]) {
    const watcher = createStatusWatcher();
    const entry = { statusNotify: { to: 'p', since: 0 } };
    const tick = (now, status) => watcher.tick([node({ status })], () => entry, {
      now, mailSince: (from, to, since) => from === 'c' && to === 'p' && mailAt >= since,
    });
    tick(0, 'working');
    tick(1000, 'idle');
    assert.equal(tick(61000, 'idle')[0]?.reported, mailAt >= 0);
  }
});

test('an earlier work period report is not claimed for the following idle episode', () => {
  const watcher = createStatusWatcher();
  const tick = (now, status) => watcher.tick([node({ status })], () => ({ statusNotify: { to: 'p', since: 0 } }), {
    now, mailSince: (_from, _to, since) => 500 >= since,
  });
  tick(0, 'working');
  tick(1000, 'idle');
  assert.equal(tick(61000, 'idle')[0]?.reported, true);
  tick(62000, 'working');
  tick(63000, 'idle');
  assert.equal(tick(123000, 'idle')[0]?.reported, false);
});


test('unknown readings preserve mail attribution for the working period', () => {
  const watcher = createStatusWatcher();
  const tick = (now, status) => watcher.tick([node({ status })], () => ({ statusNotify: { to: 'p', since: 0 } }), {
    now, mailSince: (_from, _to, since) => 500 >= since,
  });
  tick(0, 'working');
  assert.deepEqual(tick(1000, 'unknown'), []);
  assert.deepEqual(tick(2000, 'working'), []);
  tick(3000, 'idle');
  assert.equal(tick(63000, 'idle')[0]?.reported, true);
});

test('resume still rearms quiet detection while the status is unknown', () => {
  const f = fixture();
  f.tick(0, { status: 'working', lastActivity: 0 });
  assert.equal(f.tick(QUIET_MS, { status: 'working', lastActivity: 0 })[0]?.kind, 'quiet');
  const resumed = QUIET_MS * 2;
  f.entry({ relaunchedAt: resumed });
  assert.deepEqual(f.tick(resumed, { status: 'unknown' }), []);
  assert.deepEqual(f.tick(resumed + 1, { status: 'working', lastActivity: 0 }), []);
  assert.equal(f.tick(resumed + QUIET_MS, { status: 'working', lastActivity: 0 })[0]?.quietMs, QUIET_MS);
});
