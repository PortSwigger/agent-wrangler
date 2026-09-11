import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deliverMailNotification } from './mailbox-delivery.js';
import { createPaneDeferral } from './pane-deferral.js';

function realDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aw-maild-'));
}

// A timestamp far enough in the past that it can never read as "connected since
// the relaunch we just started" — models the woken card's PREVIOUS process
// having talked to /mcp before it died.
const STALE_MCP_SEEN = 1;

function deps({
  live = {}, entries = {}, resumeThrows = false, resumeTmux = 'cc_joined',
  resuming = false,
  resumeReturnsPane = true, pasteLandsOnAttempt = 1,
  mcpConnectsAfterPolls = 0, mcpSeenStale = false,
} = {}) {
  const sent = [];
  const resumed = [];
  const bound = [];
  const captures = [];
  // Each entry records how many pastes had already gone out when the gate
  // polled, so a test can prove the paste waited rather than merely happened.
  const mcpPolls = [];
  return {
    sent, resumed, bound, captures, mcpPolls,
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
    // The live announcement now goes through paneDeferral (held while the human
    // is mid-prompt). This double records the same shape the direct paste did,
    // so the live-path assertions below are unchanged; pane-deferral.test.js
    // owns the gating behaviour, and the wiring test pins that it is consulted.
    paneDeferral: {
      deliverOrDefer: async ({ text, tmux, socket }) => { sent.push({ name: tmux, text, socket }); return 'sent'; },
    },
    // Models a freshly-resumed pane whose TUI discards pastes until it's ready:
    // before `pasteLandsOnAttempt` pastes have been sent, the pane shows only the
    // paste's own raw terminal echo (real classify() reads that as 'idle', same
    // as the live cooked-mode-echo false positive this test guards against); once
    // landed, the pane shows the "esc to interrupt" working marker classify()
    // actually looks for. pasteLandsOnAttempt: Infinity never lands.
    capturePane: async (name) => {
      captures.push(name);
      const attempts = sent.filter((s) => s.name === name).length;
      if (attempts >= pasteLandsOnAttempt) return 'esc to interrupt';
      return sent.filter((s) => s.name === name).at(-1)?.text ?? '';
    },
    pasteVerifyDelayMs: 0, // real callers wait ~1.5s between attempts; tests don't need to.
    pasteVerifyPollMs: 0,
    // Models the woken agent's MCP client connecting back to this server:
    // `mcpConnectsAfterPolls` polls report nothing, then a fresh timestamp.
    // `mcpSeenStale` reports only the dead process's old connection, which must
    // never satisfy the gate.
    mcpSeenAt: () => {
      mcpPolls.push(sent.length);
      if (mcpSeenStale) return STALE_MCP_SEEN;
      return mcpPolls.length > mcpConnectsAfterPolls ? Date.now() : 0;
    },
    mcpReadyTimeoutMs: 30,
    mcpReadyPollMs: 1,
  };
}

test('live recipient: pastes the notification into the pane, no resume', async () => {
  const d = deps({ live: { CARD1: { tmux: 'cc_one', socket: '/s/a' } } });
  const mode = await deliverMailNotification('CARD1', 'you have mail', d);
  assert.deepEqual(mode, { mode: 'live' });
  assert.deepEqual(d.sent, [{ name: 'cc_one', text: 'you have mail', socket: '/s/a' }]);
  assert.equal(d.resumed.length, 0);
});

test('live recipient archived during its settle window: skip, never paste — lastGraph can still resolve a tmux for an already-killed card', async () => {
  // Models the race: tmuxFor still resolves a target (lastGraph rebuilds
  // every ~4s, slower than the 2s mail sweep), but the mapping entry already
  // has archivedAt set. The spec requires the re-check "immediately before
  // waking OR notifying" — this is the notifying half.
  const d = deps({
    live: { CARD1: { tmux: 'cc_one', socket: '/s/a' } },
    entries: { CARD1: { archivedAt: Date.now() } },
  });
  const mode = await deliverMailNotification('CARD1', 'you have mail', d);
  assert.deepEqual(mode, { mode: 'skip' });
  assert.equal(d.sent.length, 0);
});

test('dormant Claude recipient (we OWN the resume): the notification NEVER rides the resume argv — it is pasted after the wake', async () => {
  // The argv route (`claude --resume … -- <notice>`) auto-submits a turn at
  // process boot, BEFORE the relaunched process's MCP client has connected, so
  // the one turn we woke the session to run has no read_mail in its tool list
  // and the agent reports the whole server as disconnected. Measured live.
  const dir = realDir();
  const entry = { cwd: dir, agent: 'claude', socket: '/s/cc' };
  const d = deps({ entries: { CARD1: entry }, resumeTmux: 'cc_woken' });
  const mode = await deliverMailNotification('CARD1', 'you have mail', d);
  assert.deepEqual(mode, { mode: 'dormant' });
  assert.equal(d.resumed.length, 1);
  assert.equal(d.resumed[0].opts?.intent, undefined, 'no intent: the relaunch must boot idle');
  assert.deepEqual(d.resumed[0].opts, { reason: 'mail' });
  assert.deepEqual(d.bound, [{ id: 'CARD1', taskId: null }]);
  assert.deepEqual(d.sent, [{ name: 'cc_woken', text: 'you have mail', socket: '/s/cc' }]);
});

test('the paste waits for the woken process to connect its MCP client, so the turn it starts can actually call read_mail', async () => {
  const dir = realDir();
  const entry = { cwd: dir, agent: 'claude', socket: '/s/cc' };
  const d = deps({ entries: { CARD1: entry }, resumeTmux: 'cc_woken', mcpConnectsAfterPolls: 3 });
  const mode = await deliverMailNotification('CARD1', 'you have mail', d);
  assert.deepEqual(mode, { mode: 'dormant' });
  assert.ok(d.mcpPolls.length >= 4, 'gate polled until the client connected');
  // Nothing had been pasted at any poll before the one that saw the connection.
  assert.deepEqual(d.mcpPolls.slice(0, 4), [0, 0, 0, 0]);
  assert.equal(d.sent.length, 1);
});

test('only a connection made SINCE the relaunch opens the gate — the dead process\'s old one does not', async () => {
  // A bare "has this card ever reached /mcp" would answer yes for any card that
  // was live an hour ago, reinstating the bug it exists to prevent.
  const dir = realDir();
  const entry = { cwd: dir, agent: 'claude', socket: '/s/cc' };
  const d = deps({ entries: { CARD1: entry }, resumeTmux: 'cc_woken', mcpSeenStale: true });
  const mode = await deliverMailNotification('CARD1', 'you have mail', d);
  assert.deepEqual(mode, { mode: 'dormant' });
  assert.ok(d.mcpPolls.length > 1, 'kept waiting rather than accepting the stale timestamp');
  // Bounded: a client that never connects still gets the mail rather than
  // stranding it — a late paste beats a lost notification.
  assert.equal(d.sent.length, 1);
});

test('live recipient: the readiness gate is not consulted at all — its process booted long ago', async () => {
  const d = deps({ live: { CARD1: { tmux: 'cc_one', socket: '/s/a' } } });
  await deliverMailNotification('CARD1', 'you have mail', d);
  assert.equal(d.mcpPolls.length, 0);
});

test('dormant Codex recipient: resume ignores the intent, so the notification is pasted into the resumed pane', async () => {
  const dir = realDir();
  const entry = { cwd: dir, agent: 'codex', socket: '/s/cx' };
  const d = deps({ entries: { CARD1: entry }, resumeTmux: 'cx_woken' });
  const mode = await deliverMailNotification('CARD1', 'you have mail', d);
  assert.deepEqual(mode, { mode: 'dormant' });
  assert.deepEqual(d.sent, [{ name: 'cx_woken', text: 'you have mail', socket: '/s/cx' }]);
});

test('dormant Codex recipient: TUI not ready on the first paste — retries until it actually lands, still reports dormant success', async () => {
  const dir = realDir();
  const entry = { cwd: dir, agent: 'codex', socket: '/s/cx' };
  const d = deps({ entries: { CARD1: entry }, resumeTmux: 'cx_woken', pasteLandsOnAttempt: 3 });
  const mode = await deliverMailNotification('CARD1', 'you have mail', d);
  assert.deepEqual(mode, { mode: 'dormant' });
  // Re-pasted (not just re-checked) on every attempt — a not-yet-ready TUI
  // discards the bytes rather than queuing them, so only re-sending works.
  assert.equal(d.sent.length, 3);
  assert.ok(d.sent.every((s) => s.name === 'cx_woken' && s.text === 'you have mail'));
});

test('dormant Codex recipient: a pane merely ECHOING the pasted text (cooked-mode terminal echo, before the TUI has grabbed raw mode) is NOT mistaken for real delivery', async () => {
  const dir = realDir();
  const entry = { cwd: dir, agent: 'codex', socket: '/s/cx' };
  const d = deps({ entries: { CARD1: entry }, resumeTmux: 'cx_woken' });
  // Override the fixture's landing signal: the pane always shows the paste's own
  // raw echo (a substring match on the notification text), but NEVER the "esc to
  // interrupt" working marker — i.e. the TUI never actually reads it as a turn.
  // Confirmed live (against a real Codex resume): a plain substring check on the
  // pane false-positives on exactly this, reporting delivery success for a
  // message that in fact sat unread.
  d.capturePane = async () => 'you have mail';
  const mode = await deliverMailNotification('CARD1', 'you have mail', d);
  assert.equal(mode.mode, 'error');
  assert.match(mode.error, /may still be starting up/);
});

test('dormant Codex recipient: TUI never becomes ready — reported as error (never silently marked delivered), never throws', async () => {
  const dir = realDir();
  const entry = { cwd: dir, agent: 'codex', socket: '/s/cx' };
  const d = deps({ entries: { CARD1: entry }, resumeTmux: 'cx_woken', pasteLandsOnAttempt: Infinity });
  const mode = await deliverMailNotification('CARD1', 'you have mail', d);
  assert.equal(mode.mode, 'error');
  assert.match(mode.error, /may still be starting up/);
  assert.equal(d.sent.length, 5); // PASTE_VERIFY_ATTEMPTS — bounded, not an infinite loop
});

test('archived recipient: never woken — no resume, no paste (resurrection-by-mail must not happen)', async () => {
  const dir = realDir();
  const entry = { cwd: dir, archivedAt: Date.now() };
  const d = deps({ entries: { CARD1: entry } });
  const mode = await deliverMailNotification('CARD1', 'you have mail', d);
  assert.deepEqual(mode, { mode: 'skip' });
  assert.equal(d.resumed.length, 0);
  assert.equal(d.sent.length, 0);
});

test('archive lands DURING the resume await: the fresh re-check aborts, never resume()', async () => {
  const dir = realDir();
  const entries = { CARD1: { cwd: dir, archivedAt: Date.now() } }; // archived by the time the sync block re-reads it
  const d = deps({ entries });
  const mode = await deliverMailNotification('CARD1', 'you have mail', d);
  assert.deepEqual(mode, { mode: 'skip' });
  assert.equal(d.resumed.length, 0);
});

test('gone recipient (no mapping entry): skip, never resumed', async () => {
  const d = deps({});
  const mode = await deliverMailNotification('CARD1', 'you have mail', d);
  assert.deepEqual(mode, { mode: 'skip' });
  assert.equal(d.resumed.length, 0);
});

test('coalescing JOIN: a resume already in flight ⇒ notification delivered via post-resume paste', async () => {
  const dir = realDir();
  const entry = { cwd: dir, socket: '/s/z' };
  const d = deps({ entries: { CARD1: entry }, resuming: true, resumeTmux: 'cc_joined' });
  const mode = await deliverMailNotification('CARD1', 'you have mail', d);
  assert.deepEqual(mode, { mode: 'dormant' });
  assert.deepEqual(d.sent, [{ name: 'cc_joined', text: 'you have mail', socket: '/s/z' }]);
});

test('coalescing JOIN: the readiness gate is SKIPPED — the relaunch is not ours, so waiting on it would stall the whole sweep', async () => {
  // A joined resume was launched by someone else, possibly seconds before we
  // asked: its process may well have connected its MCP client BEFORE our own
  // `since`, and "connected since `since`" would then never come true. The gate
  // would burn its full timeout inside a sweep that serializes every other
  // dormant recipient behind it. Joining already meant an immediate paste before
  // this gate existed, so skipping it here is exactly the old behaviour.
  const dir = realDir();
  const entry = { cwd: dir, agent: 'claude', socket: '/s/z' };
  const d = deps({ entries: { CARD1: entry }, resuming: true, resumeTmux: 'cc_joined', mcpSeenStale: true });
  const mode = await deliverMailNotification('CARD1', 'you have mail', d);
  assert.deepEqual(mode, { mode: 'dormant' });
  assert.equal(d.mcpPolls.length, 0, 'never polled the gate for a relaunch we do not own');
  assert.deepEqual(d.sent, [{ name: 'cc_joined', text: 'you have mail', socket: '/s/z' }]);
});

test('coalescing JOIN with no resulting pane: reported as error, not silently dropped, and carries the real reason', async () => {
  const dir = realDir();
  const entry = { cwd: dir };
  const d = deps({ entries: { CARD1: entry }, resuming: true, resumeReturnsPane: false });
  const mode = await deliverMailNotification('CARD1', 'you have mail', d);
  assert.equal(mode.mode, 'error');
  assert.match(mode.error, /no live pane/);
});

test('resume failure: returns error (with the real failure message, never undefined), never throws', async () => {
  const dir = realDir();
  const entry = { cwd: dir };
  const d = deps({ entries: { CARD1: entry }, resumeThrows: true });
  const mode = await deliverMailNotification('CARD1', 'you have mail', d);
  assert.equal(mode.mode, 'error');
  assert.match(mode.error, /transcript gone/);
});

// Wiring, not gating logic (that lives in pane-deferral.test.js): the live
// announcement must go through the gate, so a "you've got mail" line can never
// be spliced into a prompt the human is half-way through typing.
test('live recipient mid-prompt: the announcement is held, not spliced into the draft', async () => {
  const pasted = [];
  const d = deps({ live: { CARD1: { tmux: 'cc_one', socket: '' } } });
  const pd = createPaneDeferral({
    tmuxFor: d.tmuxFor,
    socketFor: d.socketFor,
    capture: async () => `${'\x1b'}[39m❯ half a question`,
    sendText: async (name, text, socket) => { pasted.push({ name, text, socket }); },
  });
  d.paneDeferral = pd;

  const res = await deliverMailNotification('CARD1', '[Agent Wrangler] 📬 New mail', d);

  assert.equal(res.mode, 'live', 'the mail is notified-as-live; only the tap on the shoulder waits');
  assert.deepEqual(pasted, [], 'nothing pasted on top of the draft');
  assert.deepEqual(pd.pending('CARD1'), ['[Agent Wrangler] 📬 New mail']);
});
