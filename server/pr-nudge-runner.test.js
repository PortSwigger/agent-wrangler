import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deliverPrNudge } from './pr-nudge-runner.js';

// A real cwd so the runner's resolveResumeDir existence check operates on a path
// that's actually present — the dormant entry's cwd points here.
function realDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aw-prn-'));
}

// Deps double: `live` is the set of managed (attachable) card ids; `entries` maps
// card id → mapping entry. `resuming` makes isResuming() report an in-flight resume
// (a concurrent manual Resume / sibling PR wake) so we JOIN rather than OWN; `resume`
// resolves to the joined pane (`resumeTmux`, or none to exercise the onError fallback).
function deps({
  message = 'nudge', live = {}, entries = {}, resumeThrows = false,
  resuming = false, resumeTmux = 'cc_joined', resumeReturnsPane = true,
} = {}) {
  const sent = [];
  const resumed = [];
  const bound = [];
  const errors = [];
  return {
    message, sent, resumed, bound, errors,
    sessionManager: {
      entryFor: (id) => entries[id] || null,
      isResuming: () => resuming,
      resume: async (id, dir, opts) => {
        if (resumeThrows) throw new Error('transcript gone');
        resumed.push({ id, dir, opts });
        return resumeReturnsPane ? { tmux: resumeTmux } : {};
      },
    },
    tmuxFor: (id) => live[id]?.tmux ?? null,
    socketFor: (id) => live[id]?.socket ?? '',
    memoryStore: { bindSession: (id, taskId) => bound.push({ id, taskId }) },
    taskStore: { taskFor: () => null },
    sendText: async (name, text, socket) => { sent.push({ name, text, socket }); },
    onError: (ev, err) => { errors.push({ ev, err }); },
  };
}

const EV = { scope: 'session', ownerId: 'CARD1', url: 'https://github.com/o/r/pull/7', number: 7, checkStatus: 'failing' };

test('live owner: sendText into the pane on its socket, no resume', async () => {
  const d = deps({ message: 'PR #7 failing', live: { CARD1: { tmux: 'cc_one', socket: '/s/a' } }, entries: { CARD1: { cwd: '/x' } } });
  const mode = await deliverPrNudge(EV, { cwd: '/x' }, d);
  assert.equal(mode, 'live');
  assert.deepEqual(d.sent, [{ name: 'cc_one', text: 'PR #7 failing', socket: '/s/a' }]);
  assert.equal(d.resumed.length, 0);
});

test('dormant Claude owner (we OWN the resume): resume with the nudge as the intent, memory bound, no sendText (no double delivery)', async () => {
  const dir = realDir();
  const entry = { cwd: dir, agent: 'claude' }; // Claude's buildResume threads the intent
  const d = deps({ message: 'PR #7 failing', entries: { CARD1: entry } }); // has an entry, not live, not resuming
  const mode = await deliverPrNudge(EV, entry, d);
  assert.equal(mode, 'dormant');
  assert.equal(d.resumed.length, 1);
  assert.equal(d.resumed[0].id, 'CARD1');
  assert.deepEqual(d.resumed[0].opts, { intent: 'PR #7 failing' }); // the SAME nudge drives the resume
  assert.deepEqual(d.bound, [{ id: 'CARD1', taskId: null }]);
  assert.equal(d.sent.length, 0); // Claude + owned ⇒ intent carried the nudge ⇒ NO fallback sendText
});

test('dormant Codex owner (we OWN the resume): `codex resume` ignores the intent, so the nudge is delivered via sendText into the resumed pane', async () => {
  const dir = realDir();
  // agent: 'codex' ⇒ resumeCarriesIntent false, so even though we OWN the relaunch the
  // intent is a silent no-op and the nudge must be pasted into the now-live pane.
  const entry = { cwd: dir, agent: 'codex', socket: '/s/cx' };
  const d = deps({ message: 'PR #7 failing', entries: { CARD1: entry }, resumeTmux: 'cx_woken' });
  const mode = await deliverPrNudge(EV, entry, d);
  assert.equal(mode, 'dormant');
  assert.equal(d.resumed.length, 1); // resume WAS called (intent still passed, harmlessly ignored by codex)
  assert.deepEqual(d.resumed[0].opts, { intent: 'PR #7 failing' });
  assert.deepEqual(d.sent, [{ name: 'cx_woken', text: 'PR #7 failing', socket: '/s/cx' }]); // delivered by pane paste, NOT intent
  assert.equal(d.errors.length, 0);
});

test('archived owner (snapshot): never woken (board toast only) — no resume, no sendText', async () => {
  const dir = realDir();
  const entry = { cwd: dir, archivedAt: Date.now() };
  const d = deps({ entries: { CARD1: entry } });
  const mode = await deliverPrNudge(EV, entry, d);
  assert.equal(mode, 'skip');
  assert.equal(d.resumed.length, 0);
  assert.equal(d.sent.length, 0);
});

test('FIX 1 — archive lands DURING the resume await: fresh re-check aborts, NO resurrection (board-toast-only)', async () => {
  // Models the TOCTOU: the snapshot the poll captured is NOT archived (so the initial
  // guard passes), but by the time resolveResumeDir's await yields and we re-read the
  // entry the user's archive WS message has set archivedAt. The fresh entryFor() must
  // catch it and abort — never resume() (which would drop archivedAt and resurrect a
  // session that has left the board).
  const dir = realDir();
  const snapshot = { cwd: dir };                          // not archived at poll time
  const archivedNow = { cwd: dir, archivedAt: Date.now() }; // archived by re-check time
  const d = deps({ entries: { CARD1: archivedNow } });
  const mode = await deliverPrNudge(EV, snapshot, d);
  assert.equal(mode, 'skip');
  assert.equal(d.resumed.length, 0); // never resurrected
  assert.equal(d.sent.length, 0);
  assert.equal(d.errors.length, 0); // an archive race is a deliberate skip, not an error
});

test('gone owner (no entry): never woken — no resume, no sendText', async () => {
  const d = deps({});
  const mode = await deliverPrNudge(EV, null, d);
  assert.equal(mode, 'skip');
  assert.equal(d.resumed.length, 0);
  assert.equal(d.sent.length, 0);
});

test('snoozed owner: never woken by a PR transition (board-toast-only, like archived) — early guard fires BEFORE resolveResumeDir + memory binding', async () => {
  const dir = realDir();
  // A getter on cwd flags when the runner reaches resolveResumeDir's call site
  // (`resolveResumeDir(..., { entryCwd: entry.cwd })`) — the FIRST thing after the
  // early guard. It stays 0 iff the early snooze guard short-circuited before it.
  let cwdReads = 0;
  const entry = {
    snooze: { until: Date.now() + 3_600_000, createdAt: Date.now() },
    get cwd() { cwdReads++; return dir; },
  };
  const d = deps({ entries: { CARD1: entry } });
  const mode = await deliverPrNudge(EV, entry, d);
  assert.equal(mode, 'skip');
  assert.equal(d.resumed.length, 0); // a snooze suppresses the wake entirely
  assert.equal(d.sent.length, 0);
  assert.equal(d.errors.length, 0); // a deliberate skip, not an error
  // The early guard must fire BEFORE any binding/dir work — a snoozed card's memory
  // binding must not be mutated (consistent with archived).
  assert.equal(cwdReads, 0);         // resolveResumeDir call site never reached
  assert.equal(d.bound.length, 0);   // memoryStore.bindSession NEVER called
});

test('snooze lands DURING the resume await: fresh re-check catches it and aborts the wake (board-toast-only)', async () => {
  // Mirror of the FIX-1 archive race: the poll snapshot is NOT snoozed (initial guard
  // passes), but by the time resolveResumeDir's await yields the user has snoozed the
  // card. The fresh entryFor() must catch it and abort — never resume().
  const dir = realDir();
  const snapshot = { cwd: dir };                                                     // not snoozed at poll time
  const snoozedNow = { cwd: dir, snooze: { until: Date.now() + 3_600_000, createdAt: Date.now() } }; // snoozed by re-check time
  const d = deps({ entries: { CARD1: snoozedNow } });
  const mode = await deliverPrNudge(EV, snapshot, d);
  assert.equal(mode, 'skip');
  assert.equal(d.resumed.length, 0); // never woken
  assert.equal(d.sent.length, 0);
  assert.equal(d.errors.length, 0);
});

test('FIX 2 — coalescing JOIN: a resume already in flight ⇒ nudge delivered via post-resume sendText, not silently dropped', async () => {
  // A concurrent manual Resume (no intent) already owns _resuming for this card, so
  // our resume() JOINS it and our intent is ignored by the coalescing. We must detect
  // the join (isResuming true) and deliver the nudge into the now-live pane instead —
  // otherwise diffCheckStatus already consumed the transition and the nudge is lost.
  const dir = realDir();
  const entry = { cwd: dir, socket: '/s/z' };
  const d = deps({ message: 'PR #7 failing', entries: { CARD1: entry }, resuming: true, resumeTmux: 'cc_joined' });
  const mode = await deliverPrNudge(EV, entry, d);
  assert.equal(mode, 'dormant');
  assert.equal(d.resumed.length, 1); // we still called resume() (joined the in-flight one)
  assert.deepEqual(d.sent, [{ name: 'cc_joined', text: 'PR #7 failing', socket: '/s/z' }]); // fallback delivery
  assert.equal(d.errors.length, 0);
});

test('FIX 2 — coalescing JOIN with no resulting pane: nudge failure is surfaced via onError, not dropped', async () => {
  const dir = realDir();
  const entry = { cwd: dir, socket: '/s/z' };
  const d = deps({ message: 'PR #7 failing', entries: { CARD1: entry }, resuming: true, resumeReturnsPane: false });
  const mode = await deliverPrNudge(EV, entry, d);
  assert.equal(mode, 'dormant');
  assert.equal(d.sent.length, 0);      // no pane to deliver into
  assert.equal(d.errors.length, 1);    // so the loss is surfaced, never silent
  assert.match(String(d.errors[0].err.message), /no live pane/);
});

test('FIX 4 — resume failure: surfaced via onError and returns "error" (so the caller does NOT rebuild)', async () => {
  const dir = realDir();
  const entry = { cwd: dir };
  const d = deps({ entries: { CARD1: entry }, resumeThrows: true });
  const mode = await deliverPrNudge(EV, entry, d); // must not throw
  assert.equal(mode, 'error'); // NOT 'dormant' — a failed wake must not trigger rebuild()
  assert.equal(d.errors.length, 1);
  assert.equal(d.errors[0].ev, EV);
  assert.match(String(d.errors[0].err.message), /transcript gone/);
});
