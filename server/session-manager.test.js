import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  archivableExits, forkEntry, buildInnerCommand, SESSIONS_DIR, resolveWorktree, SessionManager, resumePlan,
  resumeEntry, resumeLaunchPlan, RESUME_NO_TRANSCRIPT_MSG, SUSPEND_MIN_SNOOZE_MS, suspendIdleMs, suspendEnabled, suspendableSessions, autoCompactTokensError,
  shouldReloadWorkflowSkill, unreportedDeaths, paneStateOf, EARLY_EXIT_GRACE_MS,
} from './session-manager.js';
import { adapterFor } from './agents/index.js';
import { registerRuntime, unregisterRuntimesFor } from './runtimes/index.js';
import { readBranch } from './state-reader.js';
import { writeConfig } from './config-store.js';
import { DATA_DIR } from './data-dir.js';

const clean = { tmux: 'cc_abc', sessionId: 's1', status: 0, archived: false };

// attachSession/dispatch read config-store's childFullViewByDefault() bare (no
// cfg injection, same as trustCodexLaunchCwd) — so a test asserting the stamped
// value must pin the real shared config.json for its duration and restore it
// after, like config-store.test.js's withConfigRestored. Unlike
// trustCodexLaunchCwd (nobody casually flips that), this setting is exactly
// the one a person trying the new feature live is likely to have toggled —
// confirmed happening mid-development (the real config.json picked up
// `childFullViewByDefault: true` while this feature was being tried out on the
// live board), which is why this isolation exists rather than assuming the
// ambient default.
const CHILD_FULL_VIEW_CONFIG_PATH = path.join(DATA_DIR, 'config.json');
async function withChildFullViewDefault(value, fn) {
  let saved;
  try { saved = fs.readFileSync(CHILD_FULL_VIEW_CONFIG_PATH, 'utf8'); } catch { saved = null; }
  try {
    writeConfig({ childFullViewByDefault: value });
    await fn();
  } finally {
    if (saved === null) { try { fs.rmSync(CHILD_FULL_VIEW_CONFIG_PATH); } catch { /* nothing to restore */ } }
    else fs.writeFileSync(CHILD_FULL_VIEW_CONFIG_PATH, saved);
  }
}

// Scratch dirs for folderless dispatches must live under the data dir, NOT inside
// the wrangler checkout. readBranch walks up to the nearest enclosing repo, so a
// scratch dir inside the source tree made every blank-cwd session report the
// wrangler's own branch — the "branch bleeding between sessions" bug.
test('scratch SESSIONS_DIR follows DATA_DIR (defaulting to ~/.agent-wrangler)', () => {
  assert.equal(SESSIONS_DIR, path.join(DATA_DIR, 'sessions'));
  if (!process.env.AW_DATA_DIR) {
    assert.equal(SESSIONS_DIR, path.join(os.homedir(), '.agent-wrangler', 'sessions'));
  }
});

test('readBranch leaks the enclosing repo branch for a scratch dir nested in a repo', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-repo-'));
  fs.mkdirSync(path.join(repo, '.git'));
  fs.writeFileSync(path.join(repo, '.git', 'HEAD'), 'ref: refs/heads/some-other-branch\n');
  const scratch = path.join(repo, 'sessions', '20260609172450');
  fs.mkdirSync(scratch, { recursive: true });
  assert.equal(await readBranch(scratch), 'some-other-branch');
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-scratch-'));
  assert.equal(await readBranch(outside), null);
});

test('archives a clean exit (owned cc_ tmux, mapped, status 0, not archived)', () => {
  assert.deepEqual(archivableExits([clean]), [clean]);
});

test('keeps a non-zero exit for the existing dead-pane/Resume path', () => {
  assert.deepEqual(archivableExits([{ ...clean, status: 1 }]), []);
  assert.deepEqual(archivableExits([{ ...clean, status: 130 }]), []);
});

test('keeps an unknown (null) exit status — older tmux degrades safely', () => {
  assert.deepEqual(archivableExits([{ ...clean, status: null }]), []);
});

test('skips a session that is already archived', () => {
  assert.deepEqual(archivableExits([{ ...clean, archived: true }]), []);
});

test('skips a dead tmux with no owning session (unmapped corpse)', () => {
  assert.deepEqual(archivableExits([{ ...clean, sessionId: null }]), []);
});

test('unreportedDeaths returns the corpses not yet logged, and nothing once they are', () => {
  assert.deepEqual(unreportedDeaths(new Set(['cc_a', 'cc_b']), new Set(['cc_a'])), ['cc_b']);
  assert.deepEqual(unreportedDeaths(new Set(['cc_a']), new Set(['cc_a'])), []);
  assert.deepEqual(unreportedDeaths(new Set(), new Set(['cc_a'])), []);
});

// Keyed on what was already reported rather than an alive→dead edge: a socket
// blip empties `alive`, so an edge rule would lose the death permanently. Here a
// corpse first SEEN after the blip is still reported.
test('unreportedDeaths reports a corpse whichever scan first sees it', () => {
  assert.deepEqual(unreportedDeaths(new Set(['cc_a']), new Set()), ['cc_a']);
});

test('paneStateOf distinguishes the three ways a resume can find a session', () => {
  const alive = new Set(['cc_live']);
  const dead = new Set(['cc_corpse']);
  assert.equal(paneStateOf('cc_corpse', alive, dead), 'dead');
  assert.equal(paneStateOf('cc_live', alive, dead), 'alive');
  assert.equal(paneStateOf('cc_gone', alive, dead), 'absent');
  assert.equal(paneStateOf(null, alive, dead), 'absent');
});

test('ignores a foreign (non-cc_) tmux even on a clean exit', () => {
  assert.deepEqual(archivableExits([{ ...clean, tmux: 'work' }]), []);
});

test('keeps a clean exit that came within the grace window of a resume', () => {
  const launchedAt = 1_000_000;
  assert.deepEqual(archivableExits([{ ...clean, launchedAt, diedAt: launchedAt + 68_000 }]), []);
});

test('archives a clean exit once the session outlived the grace window', () => {
  const launchedAt = 1_000_000;
  const late = { ...clean, launchedAt, diedAt: launchedAt + EARLY_EXIT_GRACE_MS };
  assert.deepEqual(archivableExits([late]), [late]);
});

test('keeps an instant exit whose whole-second death time reads just before the resume stamp', () => {
  assert.deepEqual(archivableExits([{ ...clean, launchedAt: 1_000_400, diedAt: 1_000_000 }]), []);
});

test('archives a clean exit that appears to predate its resume by more than a second (clock moved back)', () => {
  const skewed = { ...clean, launchedAt: 1_600_000, diedAt: 1_000_000 };
  assert.deepEqual(archivableExits([skewed]), [skewed]);
});

test('archives a clean exit when the death or launch time is unknown', () => {
  assert.deepEqual(archivableExits([{ ...clean, launchedAt: 1_000_000 }]), [{ ...clean, launchedAt: 1_000_000 }]);
  assert.deepEqual(archivableExits([{ ...clean, diedAt: 1_000_000 }]), [{ ...clean, diedAt: 1_000_000 }]);
});

test('picks only the clean owned exits out of a mixed batch', () => {
  const a = { tmux: 'cc_a', sessionId: 'sa', status: 0, archived: false };
  const b = { tmux: 'cc_b', sessionId: 'sb', status: 1, archived: false }; // crash
  const c = { tmux: 'cc_c', sessionId: 'sc', status: 0, archived: true }; // already archived
  const d = { tmux: 'cc_d', sessionId: 'sd', status: 0, archived: false };
  assert.deepEqual(archivableExits([a, b, c, d]), [a, d]);
});

test('forkEntry: inherits parent intent/model, records provenance, no custom name', () => {
  const entry = forkEntry({
    short: 'abcd1234', tmux: 'cc_abcd1234', cwd: '/repo',
    parentEntry: { intent: 'fix the bug', model: 'sonnet' },
    parentId: 'parent-O', name: '', createdAt: 123,
  });
  assert.deepEqual(entry, {
    short: 'abcd1234', tmux: 'cc_abcd1234', cwd: '/repo',
    agent: 'claude',
    intent: 'fix the bug', name: undefined, model: 'sonnet',
    createdAt: 123, forkedFrom: 'parent-O', liveSessionId: undefined, runtime: undefined, runtimeExt: undefined,
    mailCapable: true,
  });
});

test('forkEntry inherits the parent auto-compaction threshold', () => {
  const entry = forkEntry({ short: 'x', tmux: 'cc_x', cwd: '/c', parentEntry: { autoCompactTokens: 250000 }, parentId: 'p', createdAt: 1 });
  assert.equal(entry.autoCompactTokens, 250000);
});

test('forkEntry: a provided title sets a trimmed custom name', () => {
  const entry = forkEntry({
    short: 's', tmux: 'cc_s', cwd: '/repo',
    parentEntry: { intent: 'x', model: null },
    parentId: 'p', name: '  Alt approach  ', createdAt: 1,
  });
  assert.equal(entry.name, 'Alt approach');
});

test('forkEntry: inherits the parent name (marked inherited, shown as [FORK] <name>)', () => {
  const entry = forkEntry({
    short: 's', tmux: 'cc_s', cwd: '/repo',
    parentEntry: { name: 'Snooze sessions', intent: 'x', model: null },
    parentId: 'p', name: '', createdAt: 1,
  });
  assert.equal(entry.name, 'Snooze sessions');
  assert.equal(entry.nameInherited, true);
});

test('forkEntry: an explicit fork title is user-chosen (not marked inherited)', () => {
  const entry = forkEntry({
    short: 's', tmux: 'cc_s', cwd: '/repo',
    parentEntry: { name: 'Parent', intent: 'x', model: null },
    parentId: 'p', name: 'My title', createdAt: 1,
  });
  assert.equal(entry.name, 'My title');
  assert.ok(!entry.nameInherited);
});

test('rename() makes the name user-chosen, clearing the inherited-fork marker', () => {
  const sm = new SessionManager();
  sm._save = () => {};
  sm.map.set('f', { forkedFrom: 'p', name: 'Parent', nameInherited: true });
  sm.rename('f', 'My Fork');
  assert.equal(sm.map.get('f').name, 'My Fork');
  assert.ok(!sm.map.get('f').nameInherited);
});

// `/clear` swaps the agent's live conversation id under us. Without the write-back
// the entry keeps pointing at the abandoned conversation, so the card reverts to its
// pre-clear label once dormant and Resume relaunches the abandoned conversation.
function swapManager(entry = {}) {
  const sm = new SessionManager();
  let saves = 0;
  sm._save = () => { saves += 1; };
  sm.map.clear();
  sm.map.set('card', { agent: 'claude', cwd: '/repo', liveSessionId: 'L1', ...entry });
  return { sm, saves: () => saves };
}
const foundTranscript = { transcriptFor: async () => '/projects/-repo/L2.jsonl' };

test('noteLiveSessionId repoints the entry at the running conversation, keeping the abandoned one', async () => {
  const { sm, saves } = swapManager();
  assert.equal(await sm.noteLiveSessionId('card', 'L2', foundTranscript), true);
  assert.equal(sm.map.get('card').liveSessionId, 'L2');
  assert.deepEqual(sm.map.get('card').priorLiveSessionIds, ['L1']);
  assert.equal(saves(), 1);
});

test('noteLiveSessionId no-ops on the unchanged id every rebuild reports (no save churn)', async () => {
  const { sm, saves } = swapManager();
  assert.equal(await sm.noteLiveSessionId('card', 'L1', foundTranscript), false);
  assert.equal(await sm.noteLiveSessionId('card', '', foundTranscript), false);
  assert.equal(await sm.noteLiveSessionId('missing', 'L2', foundTranscript), false);
  assert.equal(saves(), 0);
});

// Repointing at a conversation whose transcript isn't written yet trades a
// stale-but-resumable card for one _doResume refuses outright; the next rebuild retries.
test('noteLiveSessionId waits for the new transcript to exist, but skips that check for codex', async () => {
  const missing = { transcriptFor: async () => null };
  const { sm } = swapManager();
  assert.equal(await sm.noteLiveSessionId('card', 'L2', missing), false);
  assert.equal(sm.map.get('card').liveSessionId, 'L1');
  const codex = swapManager({ agent: 'codex' }).sm;
  assert.equal(await codex.noteLiveSessionId('card', 'L2', missing), true);
  assert.equal(codex.map.get('card').liveSessionId, 'L2');
});

test('noteLiveSessionId refuses a conversation another card already owns', async () => {
  const { sm } = swapManager();
  sm.map.set('other', { agent: 'claude', liveSessionId: 'L2' });
  assert.equal(await sm.noteLiveSessionId('card', 'L2', foundTranscript), false);
  assert.equal(sm.map.get('card').liveSessionId, 'L1');
  // A legacy entry keyed on the conversation id itself counts as its owner too.
  sm.map.set('L3', { agent: 'claude' });
  assert.equal(await sm.noteLiveSessionId('card', 'L3', foundTranscript), false);
});

test('noteLiveSessionId keeps prior ids deduped and never lists the current one', async () => {
  const { sm } = swapManager({ priorLiveSessionIds: ['L0'] });
  await sm.noteLiveSessionId('card', 'L2', foundTranscript);
  assert.deepEqual(sm.map.get('card').priorLiveSessionIds, ['L0', 'L1']);
  await sm.noteLiveSessionId('card', 'L0', foundTranscript); // swapped back onto an earlier one
  assert.equal(sm.map.get('card').liveSessionId, 'L0');
  assert.deepEqual(sm.map.get('card').priorLiveSessionIds, ['L1', 'L2']);
});

// A headless conversation (a `claude -p` run on a card's behalf) is billed to the
// card by recording it as a prior id: the cost scanners walk priorLiveSessionIds,
// and cardForLive ignores them, so the card pays for it without ever resuming it.
test('recordPriorLiveSessionId bills a headless conversation to the card without repointing it', () => {
  const { sm, saves } = swapManager();
  assert.equal(sm.recordPriorLiveSessionId('card', 'H1'), true);
  assert.equal(sm.map.get('card').liveSessionId, 'L1');
  assert.deepEqual(sm.map.get('card').priorLiveSessionIds, ['H1']);
  assert.equal(sm.cardForLive('H1'), null);
  assert.equal(saves(), 1);
});

test('recordPriorLiveSessionId dedupes, and refuses a missing card, an empty id or the current conversation', () => {
  const { sm, saves } = swapManager({ priorLiveSessionIds: ['L0'] });
  assert.equal(sm.recordPriorLiveSessionId('card', 'L0'), true); // already billed: idempotent, still saves
  assert.deepEqual(sm.map.get('card').priorLiveSessionIds, ['L0']);
  assert.equal(sm.recordPriorLiveSessionId('missing', 'H1'), false);
  assert.equal(sm.recordPriorLiveSessionId('card', ''), false);
  assert.equal(sm.recordPriorLiveSessionId('card', 'L1'), false); // the card's own live conversation is not a prior one
  assert.deepEqual(sm.map.get('card').priorLiveSessionIds, ['L0']);
  assert.equal(saves(), 1);
});

test('forkEntry: falls back to (forked) intent and null model when parent lacks them', () => {
  const entry = forkEntry({
    short: 's', tmux: 'cc_s', cwd: '/repo', parentEntry: undefined,
    parentId: 'p', createdAt: 1,
  });
  assert.equal(entry.intent, '(forked)');
  assert.equal(entry.model, null);
});

test('resumePlan: a normal session resumes in place', () => {
  assert.deepEqual(
    resumePlan({ entry: { liveSessionId: 'L' }, resumeId: 'L', forkLiveExists: true }),
    { mode: 'resume', resumeId: 'L' },
  );
});

test('resumePlan: a fork whose own transcript exists resumes in place', () => {
  assert.deepEqual(
    resumePlan({ entry: { forkedFrom: 'P', liveSessionId: 'F' }, resumeId: 'F', forkLiveExists: true }),
    { mode: 'resume', resumeId: 'F' },
  );
});

test('resumePlan: a never-messaged fork is refused (its branch point was never saved)', () => {
  const plan = resumePlan({ entry: { forkedFrom: 'P', liveSessionId: 'F' }, resumeId: 'F', forkLiveExists: false });
  assert.equal(plan.mode, 'refuse');
  assert.match(plan.message, /never messaged/i);
});

test('resumeLaunchPlan: a missing transcript is refused (never start a blank session in its place)', () => {
  const lp = resumeLaunchPlan({ transcriptFound: false, launchDir: null, launchDirExists: false, fallbackDir: '/home' });
  assert.equal(lp.mode, 'refuse');
  assert.equal(lp.message, RESUME_NO_TRANSCRIPT_MSG);
});

test('resumeLaunchPlan: transcript found relaunches in its own bucket dir, overriding a drifted cwd', () => {
  assert.deepEqual(
    resumeLaunchPlan({ transcriptFound: true, launchDir: '/repo', launchDirExists: true, fallbackDir: '/wrong' }),
    { mode: 'resume', dir: '/repo' },
  );
});

test('resumeLaunchPlan: transcript found but its launch dir is gone falls back to the caller dir', () => {
  // The launch dir was deleted (e.g. a cleaned worktree); the resume-needs-dir prompt
  // owns recreating it, so trust the caller's resolved/recreated dir here.
  assert.deepEqual(
    resumeLaunchPlan({ transcriptFound: true, launchDir: '/gone', launchDirExists: false, fallbackDir: '/recreated' }),
    { mode: 'resume', dir: '/recreated' },
  );
});

test('resumeLaunchPlan: transcript found but launch dir unknown falls back to the caller dir', () => {
  assert.deepEqual(
    resumeLaunchPlan({ transcriptFound: true, launchDir: null, launchDirExists: false, fallbackDir: '/fallback' }),
    { mode: 'resume', dir: '/fallback' },
  );
});

test('resumeEntry carries workflow, worktree, forkedFrom, spawnedBy, parentSession, links, PR-automation toggles, childFullView, and nameInherited across the rebuild', () => {
  const prev = {
    intent: 'fix', name: 'My run', model: 'sonnet', createdAt: 100,
    forkedFrom: 'P', spawnedBy: 'SPAWNER1',
    worktree: { path: '/w', branch: 'b', repoRoot: '/r' },
    addDirs: ['/r/.git'],
    workflow: { issue: 'ENT-1', phase: { label: 'verifying', kind: 'warning', at: 9 }, startedAt: 2 },
    parentSession: 'ORCH1',
    links: [{ type: 'pr', url: 'https://github.com/o/r/pull/1', number: 1 }],
    autoFixPrChecks: false,
    autoMergeOnPass: true,
    childFullView: true,
    autoCompactTokens: 250000,
    nameInherited: true,
    priorLiveSessionIds: ['CLEARED1'],
  };
  const e = resumeEntry(prev, { short: 's', tmux: 'cc_s', cwd: '/w', agent: 'claude', resumeId: 'L', socket: 'sock', now: 999 });
  // A conversation the agent cleared away still holds spend the card is billed for —
  // and once its transcript is deleted, the usage cache keyed on it IS the record.
  assert.deepEqual(e.priorLiveSessionIds, ['CLEARED1']);
  assert.deepEqual(e.workflow, prev.workflow); // the autopilot chip survives resume (8h-suspend recovery)
  assert.deepEqual(e.worktree, prev.worktree);
  assert.deepEqual(e.addDirs, prev.addDirs); // the paths a sandboxed agent was granted outside its cwd
  assert.equal(e.forkedFrom, 'P');
  assert.equal(e.spawnedBy, 'SPAWNER1');
  assert.equal(e.parentSession, 'ORCH1'); // the nesting link is a stable card id — survives resume too
  assert.deepEqual(e.links, prev.links); // a PR/Jira link attached before an idle-suspend must survive resume
  assert.equal(e.autoFixPrChecks, false); // an explicit opt-out must not silently revert to the on-default
  assert.equal(e.autoMergeOnPass, true); // ditto for an explicit opt-in surviving a workflow run's idle-suspend
  assert.equal(e.childFullView, true); // ditto for a child's full-view override
  assert.equal(e.autoCompactTokens, 250000);
  assert.equal(e.nameInherited, true); // the [FORK] marker must survive on a still-unnamed fork
  assert.equal(e.liveSessionId, 'L');
  assert.equal(e.intent, 'fix');
  assert.equal(e.createdAt, 100);
});

test('autoCompactTokensError accepts Codex 50k and keeps Claude at its documented minimum', () => {
  assert.equal(autoCompactTokensError(undefined), null);
  assert.equal(autoCompactTokensError(null), null);
  assert.equal(autoCompactTokensError(''), null);
  assert.equal(autoCompactTokensError(100000), null);
  assert.equal(autoCompactTokensError(1000000), null);
  assert.equal(autoCompactTokensError(50000, 'codex'), null);
  assert.match(autoCompactTokensError(50000, 'claude'), /100000/);
  assert.match(autoCompactTokensError(99999), /100000/);
  assert.match(autoCompactTokensError(1000001), /1000000/);
  assert.match(autoCompactTokensError(200000.5), /whole number/);
  assert.match(autoCompactTokensError('200000'), /whole number/);
});

test('dispatch omits a blank auto-compaction threshold from the persisted entry', async () => {
  const sm = smForDispatch();
  const { sessionId } = await sm.dispatch({ cwd: os.tmpdir(), intent: 'x', autoCompactTokens: '' });
  assert.equal(Object.hasOwn(sm.map.get(sessionId), 'autoCompactTokens'), false);
});

test('hasLaunchInFlight covers a dispatch until it settles', async () => {
  const sm = smForDispatch();
  let release;
  const gate = new Promise((r) => { release = r; });
  sm._newSession = async () => { await gate; };
  assert.equal(sm.hasLaunchInFlight(), false);
  const p = sm.dispatch({ cwd: os.tmpdir(), intent: 'x' });
  assert.equal(sm.hasLaunchInFlight(), true);
  release();
  await p;
  assert.equal(sm.hasLaunchInFlight(), false);
});

test('resumeEntry drops archivedAt, snooze, suspendedAt, and suspendPending — resume returns to the board live and un-suspended', () => {
  const prev = {
    intent: 'fix', createdAt: 100,
    archivedAt: 500,
    snooze: { until: 600, createdAt: 100 },
    suspendedAt: 400,
    suspendPending: true,
  };
  const e = resumeEntry(prev, { short: 's', tmux: 'cc_s', cwd: '/w', agent: 'claude', resumeId: 'L', socket: 'sock', now: 999 });
  assert.equal(e.archivedAt, undefined);
  assert.equal(e.snooze, undefined);
  assert.equal(e.suspendedAt, undefined);
  assert.equal(e.suspendPending, undefined);
});

test('archive() records snapshot.reason as archiveReason; a re-archive without one clears it; resumeEntry drops it', () => {
  const sm = new SessionManager();
  sm._save = () => {};
  sm.map.set('s1', { short: 's', tmux: 'cc_s', cwd: '/repo', intent: 'x', createdAt: 1 });
  sm.archive('s1', { cwd: '/repo', reason: 'clean-exit' });
  assert.equal(sm.entryFor('s1').archiveReason, 'clean-exit');
  sm.archive('s1', { cwd: '/repo' });
  assert.equal('archiveReason' in sm.entryFor('s1'), false);
  const e = resumeEntry({ intent: 'x', archivedAt: 5, archiveReason: 'ui' }, { short: 's', tmux: 'cc_s', cwd: '/w', agent: 'claude', resumeId: 'L', socket: '', now: 9 });
  assert.equal(e.archiveReason, undefined);
});

test('reconcileExitedSessions logs the auto-archive, stores reason clean-exit, and kills with reason=auto-archive-exit', async () => {
  const sm = new SessionManager();
  sm._save = () => {};
  sm.map.set('s1', { short: 's', tmux: 'cc_s', cwd: '/repo', intent: 'x', createdAt: 1 });
  sm.dead = new Set(['cc_s']);
  sm.deadStatus = new Map([['cc_s', 0]]);
  const kills = [];
  sm.killForSession = async (id, opts) => { kills.push([id, opts]); return ['cc_s']; };
  const logs = [];
  const orig = console.log;
  console.log = (msg) => logs.push(msg);
  let ids;
  try { ids = await sm.reconcileExitedSessions(); } finally { console.log = orig; }
  assert.deepEqual(ids, ['s1']);
  assert.equal(sm.entryFor('s1').archiveReason, 'clean-exit');
  assert.deepEqual(kills, [['s1', { reason: 'auto-archive-exit' }]]);
  assert.ok(logs.some((l) => l.includes('[session] auto-archived s1 (tmux cc_s) — clean exit (status 0)')));
});

test('reconcileExitedSessions leaves a pane that died right after its resume for the dead-pane path', async () => {
  const sm = new SessionManager();
  sm._save = () => {};
  sm.map.set('s1', { short: 's', tmux: 'cx_s', cwd: '/repo', intent: 'x', createdAt: 1, relaunchedAt: 5_000_000 });
  sm.dead = new Set(['cx_s']);
  sm.deadStatus = new Map([['cx_s', 0]]);
  sm.deadTime = new Map([['cx_s', 5_068_000]]);
  sm.killForSession = async () => { throw new Error('must not kill'); };
  assert.deepEqual(await sm.reconcileExitedSessions(), []);
  assert.equal(sm.isArchived('s1'), false);
});

for (const [label, relaunchedAt] of [['fresh dispatch', undefined], ['resume outside startup grace', 4_820_000]]) {
  test(`reconcileExitedSessions preserves a completed Codex update after ${label}`, async () => {
    const sm = new SessionManager();
    sm._save = () => {};
    sm.map.set('s1', { tmux: 'cx_update', agent: 'codex', socket: 'update-test', relaunchedAt });
    sm.dead = new Set(['cx_update']);
    sm.deadStatus = new Map([['cx_update', 0]]);
    sm.deadTime = new Map([['cx_update', 5_000_000]]);
    sm._tmux = async (socket, args) => {
      assert.equal(socket, 'update-test');
      assert.equal(args[0], 'capture-pane');
      assert.equal(args[args.indexOf('-t') + 1], 'cx_update');
      return { stdout: '🎉 Update ran successfully! Please restart Codex.\nPane is dead (status 0, Thu Oct 8 10:19:02 2026)' };
    };
    const killed = [];
    sm.killForSession = async (id) => { killed.push(id); return ['cx_update']; };
    assert.deepEqual(await sm.reconcileExitedSessions(), []);
    assert.equal(sm.isArchived('s1'), false);
    assert.equal(sm.deadTmuxNameFor('s1'), 'cx_update');
    assert.deepEqual(killed, []);
  });
}

test('reconcileExitedSessions preserves recognized updater output with a custom dead-pane trailer', async () => {
  const sm = new SessionManager();
  sm._save = () => {};
  sm.map.set('s1', { tmux: 'cx_update', agent: 'codex' });
  sm.dead = new Set(['cx_update']);
  sm.deadStatus = new Map([['cx_update', 0]]);
  sm._tmux = async () => ({ stdout: 'Updating Codex via `brew upgrade --cask codex`...\n🎉 Update ran successfully! Please restart Codex.\nProcess finished (exit 0)' });
  sm.killForSession = async () => { throw new Error('must not kill'); };
  assert.deepEqual(await sm.reconcileExitedSessions(), []);
  assert.equal(sm.isArchived('s1'), false);
  assert.equal(sm.deadTmuxNameFor('s1'), 'cx_update');
});

test('reconcileExitedSessions still archives an ordinary clean Codex exit', async () => {
  const sm = new SessionManager();
  sm._save = () => {};
  sm.map.set('s1', { tmux: 'cx_exit', agent: 'codex', socket: 'exit-test' });
  sm.dead = new Set(['cx_exit']);
  sm.deadStatus = new Map([['cx_exit', 0]]);
  sm._tmux = async () => ({ stdout: 'Bye!\nPane is dead (status 0, Thu Oct 8 10:19:02 2026)' });
  const killed = [];
  sm.killForSession = async (id) => { killed.push(id); return ['cx_exit']; };
  assert.deepEqual(await sm.reconcileExitedSessions(), ['s1']);
  assert.equal(sm.isArchived('s1'), true);
  assert.deepEqual(killed, ['s1']);
});

test('reconcileExitedSessions does not archive a replacement launched during the exit capture', async () => {
  const sm = new SessionManager();
  sm._save = () => {};
  sm.map.set('s1', { tmux: 'cx_old', agent: 'codex' });
  sm.dead = new Set(['cx_old']);
  sm.deadStatus = new Map([['cx_old', 0]]);
  sm._tmux = async () => {
    sm.map.set('s1', { tmux: 'cx_new', agent: 'codex' });
    return { stdout: 'Bye!' };
  };
  const killed = [];
  sm.killForSession = async (id) => { killed.push(id); return []; };
  assert.deepEqual(await sm.reconcileExitedSessions(), []);
  assert.equal(sm.entryFor('s1').tmux, 'cx_new');
  assert.equal(sm.isArchived('s1'), false);
  assert.deepEqual(killed, []);
});

for (const [label, output, archived] of [
  ['update exit', '🎉 Update ran successfully! Please restart Codex.', []],
  ['ordinary exit', 'Bye!', ['s1']],
]) {
  test(`reconcileExitedSessions defers a failed capture and retries the ${label}`, async () => {
    const sm = new SessionManager();
    sm._save = () => {};
    sm.map.set('s1', { tmux: 'cx_capture', agent: 'codex' });
    sm.dead = new Set(['cx_capture']);
    sm.deadStatus = new Map([['cx_capture', 0]]);
    let captures = 0;
    sm._tmux = async () => {
      if (++captures === 1) throw new Error('tmux socket unavailable');
      return { stdout: output };
    };
    const killed = [];
    sm.killForSession = async (id) => { killed.push(id); return ['cx_capture']; };
    assert.deepEqual(await sm.reconcileExitedSessions(), []);
    assert.equal(sm.isArchived('s1'), false);
    assert.deepEqual(killed, []);
    assert.deepEqual(await sm.reconcileExitedSessions(), archived);
    assert.equal(sm.isArchived('s1'), archived.length > 0);
    assert.deepEqual(killed, archived);
  });
}

test('reconcileExitedSessions leaves a resume in flight alone after capture', async () => {
  const sm = new SessionManager();
  sm._save = () => {};
  sm.map.set('s1', { tmux: 'cx_resuming', agent: 'codex' });
  sm.dead = new Set(['cx_resuming']);
  sm.deadStatus = new Map([['cx_resuming', 0]]);
  sm._tmux = async () => {
    sm._resuming.set('s1', Promise.resolve());
    return { stdout: 'Bye!' };
  };
  const killed = [];
  sm.killForSession = async (id) => { killed.push(id); return []; };
  assert.deepEqual(await sm.reconcileExitedSessions(), []);
  assert.equal(sm.isArchived('s1'), false);
  assert.deepEqual(killed, []);
});

test('refreshAlive records each dead pane\'s death time from pane_dead_time', async () => {
  const sm = new SessionManager();
  sm.scanSockets = () => [''];
  sm._tmux = async () => ({ stdout: 'cx_s\x1f1\x1f0\x1f1791187425\ncc_live\x1f0\x1f\x1f\n' });
  await sm.refreshAlive();
  assert.equal(sm.deadTime.get('cx_s'), 1791187425000);
  assert.equal(sm.deadStatus.get('cx_s'), 0);
  assert.equal(sm.deadTime.has('cc_live'), false);
});

test('reconcileExitedSessions still archives a fresh, never-resumed session quit straight away', async () => {
  const sm = new SessionManager();
  sm._save = () => {};
  sm.map.set('s1', { short: 's', tmux: 'cc_s', cwd: '/repo', intent: 'x', createdAt: 5_000_000 });
  sm.dead = new Set(['cc_s']);
  sm.deadStatus = new Map([['cc_s', 0]]);
  sm.deadTime = new Map([['cc_s', 5_010_000]]);
  sm.killForSession = async () => ['cc_s'];
  const orig = console.log;
  console.log = () => {};
  try { assert.deepEqual(await sm.reconcileExitedSessions(), ['s1']); } finally { console.log = orig; }
  assert.equal(sm.entryFor('s1').archiveReason, 'clean-exit');
});

// viaTaskArchive is archive-only bookkeeping (see SessionManager.archive) — like
// archivedAt/task/lastLabel, it must not survive a resume, or a session resumed
// on its own would still look cascade-linked to a task it's no longer archived
// under.
test('resumeEntry drops viaTaskArchive and the task snapshot', () => {
  const prev = { intent: 'fix', createdAt: 100, viaTaskArchive: 'T1', task: { id: 'T1', name: 'Login' }, lastLabel: 'Old label' };
  const e = resumeEntry(prev, { short: 's', tmux: 'cc_s', cwd: '/w', agent: 'claude', resumeId: 'L', socket: '', now: 999 });
  assert.equal(e.viaTaskArchive, undefined);
  assert.equal(e.task, undefined);
  assert.equal(e.lastLabel, undefined);
});

test('archive() stamps viaTaskArchive only when the caller passes it; isArchived reflects archivedAt', () => {
  const sm = new SessionManager();
  sm._save = () => {};
  sm.map.set('s1', { short: 's', tmux: 'cc_s', cwd: '/repo', intent: 'x', createdAt: 1 });
  sm.map.set('s2', { short: 't', tmux: 'cc_t', cwd: '/repo', intent: 'y', createdAt: 1 });
  assert.equal(sm.isArchived('s1'), false);
  sm.archive('s1', { cwd: '/repo', task: { id: 'T1', name: 'Login' }, viaTaskArchive: 'T1' });
  sm.archive('s2', { cwd: '/repo', task: { id: 'T1', name: 'Login' } });
  assert.equal(sm.isArchived('s1'), true);
  assert.equal(sm.entryFor('s1').viaTaskArchive, 'T1');
  // Plain solo archive (no viaTaskArchive passed): the key is absent, not undefined.
  assert.equal('viaTaskArchive' in sm.entryFor('s2'), false);
});

// archive()'s fire-and-forget review side effect (server/archive-review-runner.js)
// is a seam precisely so a test never needs to spawn a real `claude -p`
// subprocess to assert this wiring — same reasoning as _ensureCodexTrust.
test('archive() calls the _archiveReview seam once, with the task snapshot, on a fresh archive', async () => {
  const sm = new SessionManager();
  sm._save = () => {};
  sm.map.set('s1', { short: 's', tmux: 'cc_s', cwd: '/repo', intent: 'x', createdAt: 1 });
  const calls = [];
  sm._archiveReview = async (sessionId, entry, task) => { calls.push({ sessionId, entry, task }); return 'written'; };
  sm.archive('s1', { cwd: '/repo', task: { id: 'T1', name: 'Login' } });
  // Unawaited in archive() itself — give its promise a tick to run.
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].sessionId, 's1');
  assert.equal(calls[0].task.id, 'T1');
  assert.equal(calls[0].entry, sm.entryFor('s1'));
});

test('archive() does NOT call _archiveReview again for a re-archive of an already-archived session', async () => {
  const sm = new SessionManager();
  sm._save = () => {};
  sm.map.set('s1', { short: 's', tmux: 'cc_s', cwd: '/repo', intent: 'x', createdAt: 1 });
  let count = 0;
  sm._archiveReview = async () => { count += 1; return 'written'; };
  sm.archive('s1', { cwd: '/repo', task: { id: 'T1', name: 'Login' } });
  await new Promise((r) => setTimeout(r, 0));
  sm.archive('s1', { cwd: '/repo', task: { id: 'T1', name: 'Login' } }); // still archived — resume() was never called
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(count, 1);
});

test('_archiveReview\'s onStamp records priorLiveSessionIds and archiveReviewedAt (only on success)', async () => {
  const sm = new SessionManager();
  sm._save = () => {};
  sm.map.set('s1', { short: 's', tmux: 'cc_s', cwd: '/repo', intent: 'x', createdAt: 1 });
  sm._archiveReview = async (sessionId, entry, task, { onStamp }) => {
    onStamp({ reviewLiveSessionId: 'REVIEW1', advanceReviewedAt: true });
    return 'written';
  };
  sm.archive('s1', { cwd: '/repo', task: { id: 'T1', name: 'Login' } });
  await new Promise((r) => setTimeout(r, 0));
  const entry = sm.entryFor('s1');
  assert.deepEqual(entry.priorLiveSessionIds, ['REVIEW1']);
  assert.ok(typeof entry.archiveReviewedAt === 'number');
});

test('a default (unstubbed) _archiveReview is an inert no-op — every existing archive test stays unaffected', async () => {
  const sm = new SessionManager();
  sm._save = () => {};
  sm.map.set('s1', { short: 's', tmux: 'cc_s', cwd: '/repo', intent: 'x', createdAt: 1 });
  assert.doesNotThrow(() => sm.archive('s1', { cwd: '/repo' }));
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(sm.entryFor('s1').priorLiveSessionIds, undefined);
});

test('resumeEntry defaults a missing intent/createdAt and leaves workflow/parentSession undefined for a plain entry', () => {
  const e = resumeEntry(undefined, { short: 's', tmux: 'cc_s', cwd: '/w', agent: 'claude', resumeId: 'L', socket: '', now: 999 });
  assert.equal(e.intent, '(resumed)');
  assert.equal(e.createdAt, 999);
  assert.equal(e.workflow, undefined);
  assert.equal(e.parentSession, undefined);
});

test('resumeEntry carries runtime; forkEntry inherits parent runtime', () => {
  const r = resumeEntry({ runtime: 'devcontainer', cwd: '/x' }, { short: 's', tmux: 't', cwd: '/x', agent: 'claude', resumeId: 'L', socket: '', now: 1 });
  assert.equal(r.runtime, 'devcontainer');
  const f = forkEntry({ short: 's', tmux: 't', cwd: '/x', parentEntry: { runtime: 'devcontainer' }, parentId: 'p', createdAt: 1 });
  assert.equal(f.runtime, 'devcontainer');
});

test('shouldReloadWorkflowSkill: true only for a genuine orchestrator marker', () => {
  assert.equal(shouldReloadWorkflowSkill({ issue: 'ENT-1', phase: { label: 'planning' }, startedAt: 1 }), true);
  assert.equal(shouldReloadWorkflowSkill({ issue: 'ENT-1' }), true); // any orchestrator field is enough
  assert.equal(shouldReloadWorkflowSkill(null), false);
  assert.equal(shouldReloadWorkflowSkill(undefined), false);
});

test('shouldReloadWorkflowSkill: false for a legacy pre-migration worker marker ({parent}, no issue/phase/startedAt)', () => {
  // A worker session suspended before this migration still has entry.workflow =
  // {parent: <orch id>} in mappings.json — resuming it must NOT reload the
  // issue-to-pr skill plugin as if it were the orchestrator itself.
  assert.equal(shouldReloadWorkflowSkill({ parent: 'ORCH1' }), false);
});

test('buildInnerCommand injects identity + the launch context\'s env and grants, intent trailing', () => {
  const sessionId = 'sid-123';
  // What the task-memory extension's hook answers: memory.md inside the
  // per-session symlink, and that same per-session dir as the one --add-dir
  // (scoped — not the whole memory tree).
  const launchContext = {
    env: { AW_TASK_MEMORY: `/m/by-session/${sessionId}/memory.md` },
    addDirs: [`/m/by-session/${sessionId}`],
  };
  const cmd = buildInnerCommand({
    args: ['--session-id', sessionId, '--permission-mode', 'auto'],
    intent: 'fix the bug',
    sessionId,
    launchContext,
  });
  assert.match(cmd, /AW_SESSION_ID='sid-123'/);
  assert.ok(cmd.includes(`AW_TASK_MEMORY='/m/by-session/${sessionId}/memory.md'`));
  assert.ok(cmd.includes(`'--add-dir' '/m/by-session/${sessionId}'`));
  // memory/links are wrangler-meta skills now, loaded via --plugin-dir; the
  // appended system prompt on a plain, non-worktree launch carries only the
  // task-memory mandatory-skill nudge, not the worktree guardrail.
  assert.match(cmd, /--append-system-prompt/);
  assert.doesNotMatch(cmd, /already running inside a dedicated git worktree/);
  assert.match(cmd, /'--plugin-dir' '[^']*\/agent-skills'/);
  // Env assignments lead — the extension's first, core's after, so core wins a
  // collision — the binary is `claude`, and the intent trails last.
  assert.match(cmd, /^AW_TASK_MEMORY=.* AW_SESSION_ID=.* claude /);
  assert.ok(cmd.trimEnd().endsWith(`'fix the bug'`));
});

test('buildInnerCommand with NO launch context carries no env var and no grant from any extension', () => {
  const cmd = buildInnerCommand({ args: ['--permission-mode', 'auto'], sessionId: 'sid-1' });
  assert.doesNotMatch(cmd, /AW_TASK_MEMORY='/);
  assert.doesNotMatch(cmd, /--add-dir/);
  assert.match(cmd, /^AW_SESSION_ID='sid-1' /);
});

test('buildInnerCommand: a launch-context env var cannot override core\'s AW_SESSION_ID (core assigns last)', () => {
  const cmd = buildInnerCommand({ args: [], sessionId: 'real', launchContext: { env: { AW_SESSION_ID: 'forged' }, addDirs: [] } });
  assert.ok(cmd.indexOf("AW_SESSION_ID='forged'") < cmd.indexOf("AW_SESSION_ID='real'"));
});

test('buildInnerCommand injects AW_SPAWNER_SESSION_ID when spawnedBy is set', () => {
  const sessionId = 'sid-child';
  const cmd = buildInnerCommand({
    args: ['--session-id', sessionId, '--permission-mode', 'auto'],
    sessionId,
    spawnedBy: 'sid-parent',
  });
  assert.match(cmd, /AW_SPAWNER_SESSION_ID='sid-parent'/);
});

test('buildInnerCommand omits AW_SPAWNER_SESSION_ID when spawnedBy is absent', () => {
  const sessionId = 'sid-child';
  const cmd = buildInnerCommand({
    args: ['--session-id', sessionId, '--permission-mode', 'auto'],
    sessionId,
  });
  assert.doesNotMatch(cmd, /AW_SPAWNER_SESSION_ID/);
});

test('buildInnerCommand omits a trailing arg when intent is blank (resume path)', () => {
  const cmd = buildInnerCommand({
    args: ['--resume', 'sid-123', '--fork-session', '--permission-mode', 'auto'],
    sessionId: 'sid-123',
  });
  assert.match(cmd, /'--resume' 'sid-123' '--fork-session'/);
  // The command ends at the appended memory flags — no empty trailing intent token.
  assert.doesNotMatch(cmd, /''\s*$/);
});

test('archivableExits sweeps cx_ (codex) clean exits too', () => {
  const got = archivableExits([
    { tmux: 'cx_abcd', sessionId: 's1', archived: false, status: 0 },
    { tmux: 'cc_ef01', sessionId: 's2', archived: false, status: 0 },
    { tmux: 'foreign', sessionId: 's3', archived: false, status: 0 },
  ]);
  assert.deepEqual(got.map((d) => d.tmux).sort(), ['cc_ef01', 'cx_abcd']);
});

test('forkEntry carries the parent agent', () => {
  const e = forkEntry({ short: 'x', tmux: 'cx_x', cwd: '/c', parentEntry: { agent: 'codex', model: 'gpt-5.5-codex' }, parentId: 'p', createdAt: 1 });
  assert.equal(e.agent, 'codex');
});
test('forkEntry defaults agent to claude when parent has none', () => {
  const e = forkEntry({ short: 'x', tmux: 'cc_x', cwd: '/c', parentEntry: {}, parentId: 'p', createdAt: 1 });
  assert.equal(e.agent, 'claude');
});

test('fork() gives Claude a distinct, real live id (no phantom) so the fork is resumable', async () => {
  const sm = new SessionManager();
  let captured = '';
  sm._newSession = async (_t, _d, inner) => { captured = inner; };
  sm._save = () => {};
  sm.refreshAlive = async () => {};
  const { sessionId: cardId } = await sm.fork({
    sourceId: 'SRC', parentId: 'PARENT',
    parentEntry: { agent: 'claude', cwd: os.tmpdir() },
    cwd: os.tmpdir(),
  });
  const entry = sm.map.get(cardId);
  const m = captured.match(/'--session-id' '([^']+)'/);
  assert.ok(m, 'fork command carries a preset --session-id');
  assert.equal(entry.liveSessionId, m[1]); // recorded live id == the id the conversation lives under
  assert.notEqual(entry.liveSessionId, cardId); // not the phantom card id
  assert.notEqual(entry.liveSessionId, 'SRC'); // a fresh fork id, not the source
});

test('fork: a devcontainer parent forks into a devcontainer-wrapped launch', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-dc-fork-'));
  const sm = new SessionManager();
  sm.map.clear();
  sm._save = () => {};
  sm.refreshAlive = async () => {};
  let captured;
  sm._newSession = async (_tmux, _dir, inner) => { captured = inner; };
  await sm.fork({ sourceId: 'L0', parentId: 'p', parentEntry: { agent: 'claude', runtime: 'devcontainer' }, cwd: dir });
  assert.match(captured, /devcontainer up --workspace-folder/);
  assert.ok(captured.includes(dir));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('fork() re-threads the parent entry\'s effort into buildFork', async () => {
  const sm = new SessionManager();
  let captured = '';
  sm._newSession = async (_t, _d, inner) => { captured = inner; };
  sm._save = () => {};
  sm.refreshAlive = async () => {};
  await sm.fork({
    sourceId: 'SRC', parentId: 'PARENT',
    parentEntry: { agent: 'claude', cwd: os.tmpdir(), effort: 'low' },
    cwd: os.tmpdir(),
  });
  assert.match(captured, /'--effort' 'low'/);
});

test('fork() keeps a Codex self-title set before the fork card is registered', async () => {
  const sm = new SessionManager();
  sm._newSession = async () => {};
  sm._save = () => {};
  sm.refreshAlive = async () => {};
  sm._ensureCodexTrust = () => {};
  sm._resolveLiveId = async (_adapter, { sessionId }) => {
    sm.rename(sessionId, 'Review the fork');
    return 'live-fork';
  };
  const { sessionId } = await sm.fork({ sourceId: 'SOURCE', parentId: 'PARENT', parentEntry: { agent: 'codex', name: 'Parent title', intent: 'Parent task' }, cwd: os.tmpdir() });
  const entry = sm.entryFor(sessionId);
  assert.equal(entry.name, 'Review the fork');
  assert.equal(entry.nameInherited, undefined);
  assert.equal(entry.forkedFrom, 'PARENT');
  assert.equal(entry.liveSessionId, 'live-fork');
});

test('fork() keeps the user-provided fork title over an early agent suggestion', async () => {
  const sm = new SessionManager();
  sm._newSession = async () => {};
  sm._save = () => {};
  sm.refreshAlive = async () => {};
  sm._ensureCodexTrust = () => {};
  sm._resolveLiveId = async (_adapter, { sessionId }) => {
    sm.rename(sessionId, 'Agent suggestion');
    return 'live-fork';
  };
  const { sessionId } = await sm.fork({ sourceId: 'SOURCE', parentId: 'PARENT', parentEntry: { agent: 'codex', name: 'Parent title' }, cwd: os.tmpdir(), name: 'My fork title' });
  assert.equal(sm.entryFor(sessionId).name, 'My fork title');
  assert.equal(sm.entryFor(sessionId).nameInherited, undefined);
});

test('fork() re-threads the parent auto-compaction threshold into buildFork', async () => {
  const sm = new SessionManager();
  let captured = '';
  sm._newSession = async (_t, _d, inner) => { captured = inner; };
  sm._save = () => {};
  sm.refreshAlive = async () => {};
  const { sessionId } = await sm.fork({
    sourceId: 'SRC', parentId: 'PARENT',
    parentEntry: { agent: 'claude', cwd: os.tmpdir(), autoCompactTokens: 300000 },
    cwd: os.tmpdir(),
  });
  assert.match(captured, /'--autocompact' '300000'/);
  assert.equal(sm.map.get(sessionId).autoCompactTokens, 300000);
});

// Trust is no longer part of the launch command (verified against the real
// Codex binary that a `-c projects.<path>.trust_level` override is silently
// ignored by its interactive trust dialog) — fork() instead calls
// this._ensureCodexTrust (codex-trust.js) to persist it before launch. That
// call is a seam precisely so a test never needs to touch the real
// ~/.codex/config.toml to assert this wiring.
test('fork() threads trustCodexLaunchCwd into ensureCodexTrust for a codex parent, keyed on the parent worktree repoRoot when present', async () => {
  const sm = new SessionManager();
  sm._newSession = async () => {};
  sm._save = () => {};
  sm.refreshAlive = async () => {};
  let trusted = [];
  sm._ensureCodexTrust = (p) => trusted.push(p);
  await sm.fork({
    sourceId: 'SRC', parentId: 'PARENT',
    parentEntry: { agent: 'codex', cwd: os.tmpdir() },
    cwd: os.tmpdir(),
  });
  // Default config.json has no trustCodexLaunchCwd override — reads the on
  // default, so the fork's cwd is trusted (no worktree on this parent).
  assert.deepEqual(trusted, [os.tmpdir()]);

  trusted = [];
  await sm.fork({
    sourceId: 'SRC', parentId: 'PARENT',
    parentEntry: { agent: 'codex', cwd: '/wt', worktree: { path: '/wt', branch: 'b', repoRoot: '/repo' } },
    cwd: '/wt',
  });
  // A worktree parent trusts the worktree's MAIN checkout, not the worktree
  // path itself — Codex resolves a linked worktree's trust to that root.
  assert.deepEqual(trusted, ['/repo']);
});

// Codex's sandbox grants filesystem write only to the workspace roots it's
// launched with; a linked worktree's common git-dir (the main checkout's own
// `.git`) lives in a SIBLING directory that's never one of them, so `git add`/
// `git commit` fails (index.lock, then object writes, then ref updates —
// verified against the real binary) unless it's added explicitly (see
// linkedWorktreeCommonGitDir in worktree.js). Claude has no OS sandbox and
// needs no such grant.
function realWorktreeRepo(rawRoot) {
  const root = fs.realpathSync(rawRoot); // macOS: /var -> /private/var, same as git's own resolution
  const repo = path.join(root, 'proj');
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, 'f.txt'), 'x');
  const git = (...a) => execFileSync('git', ['-C', repo, ...a], { stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'i');
  const wt = path.join(root, 'proj-worktree-feature');
  git('worktree', 'add', '-q', wt, '-b', 'feature');
  return { repo, worktreePath: wt, gitDir: path.join(repo, '.git') };
}

test('fork() adds the linked worktree common git-dir via --add-dir for a codex parent', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-fork-wt-'));
  const { worktreePath, gitDir } = realWorktreeRepo(root);
  const worktreeGitDir = execFileSync('git', ['-C', worktreePath, 'rev-parse', '--path-format=absolute', '--git-dir'], { encoding: 'utf8' }).trim();
  const sm = new SessionManager();
  sm._newSession = async () => {};
  sm._save = () => {};
  sm.refreshAlive = async () => {};
  sm._ensureCodexTrust = () => {};
  let captured = '';
  sm._newSession = async (_t, _d, inner) => { captured = inner; };
  await sm.fork({
    sourceId: 'SRC', parentId: 'PARENT',
    parentEntry: { agent: 'codex', cwd: worktreePath, worktree: { path: worktreePath, branch: 'feature', repoRoot: path.dirname(worktreePath) } },
    cwd: worktreePath,
  });
  assert.ok(captured.includes(`'--add-dir' '${gitDir}'`), captured);
  assert.ok(captured.includes(`'--add-dir' '${worktreeGitDir}'`), captured);
  fs.rmSync(root, { recursive: true, force: true });
});

test('fork() does not add a worktree common git-dir for a claude parent (no OS sandbox to feed)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-fork-wt2-'));
  const { worktreePath, gitDir } = realWorktreeRepo(root);
  const sm = new SessionManager();
  sm._save = () => {};
  sm.refreshAlive = async () => {};
  let captured = '';
  sm._newSession = async (_t, _d, inner) => { captured = inner; };
  await sm.fork({
    sourceId: 'SRC', parentId: 'PARENT',
    parentEntry: { agent: 'claude', cwd: worktreePath, worktree: { path: worktreePath, branch: 'feature', repoRoot: path.dirname(worktreePath) } },
    cwd: worktreePath,
  });
  assert.ok(!captured.includes(gitDir), captured);
  fs.rmSync(root, { recursive: true, force: true });
});

test('fork() never calls ensureCodexTrust for a claude parent', async () => {
  const sm = new SessionManager();
  sm._newSession = async () => {};
  sm._save = () => {};
  sm.refreshAlive = async () => {};
  let called = false;
  sm._ensureCodexTrust = () => { called = true; };
  await sm.fork({
    sourceId: 'SRC', parentId: 'PARENT',
    parentEntry: { agent: 'claude', cwd: os.tmpdir() },
    cwd: os.tmpdir(),
  });
  assert.equal(called, false);
});

test('resume() refuses (does not launch) when a Claude transcript is nowhere on disk', async () => {
  const sm = new SessionManager();
  sm.map.clear();
  let launched = false;
  let killed = false;
  sm.killForSession = async () => { killed = true; return []; };
  sm._newSession = async () => { launched = true; };
  sm._save = () => {};
  sm.refreshAlive = async () => {};
  // A modern Claude entry whose live id has no transcript anywhere under ~/.claude.
  const cardId = 'card-no-transcript';
  sm.map.set(cardId, { agent: 'claude', cwd: os.tmpdir(), liveSessionId: '00000000-dead-beef-0000-000000000000' });
  await assert.rejects(() => sm.resume(cardId, os.tmpdir()), (e) => e.message === RESUME_NO_TRANSCRIPT_MSG);
  assert.equal(launched, false); // never spawned a blank session in place of the lost one
  assert.equal(killed, false, 'a refused resume leaves any live pane running');
});

test('dispatch refuses a devcontainer with no config before any side effect (native error, no pane)', async () => {
  const sm = new SessionManager();
  let launched = false;
  sm._newSession = async () => { launched = true; };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-dc-nocfg-'));
  await assert.rejects(() => sm.dispatch({ runtime: 'devcontainer', cwd: dir, intent: 'x' }), /No devcontainer config/);
  assert.equal(launched, false); // preflight threw before launch — no dead pane
});

test('_doResume: devcontainer skips the host transcript guard and wraps in a devcontainer pane script', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-dc-resume-'));
  const sm = new SessionManager();
  sm.map.clear();
  sm.killForSession = async () => [];
  sm._save = () => {};
  sm.refreshAlive = async () => {};
  let captured;
  sm._newSession = async (_tmux, _dir, inner) => { captured = inner; };
  // A devcontainer entry whose live id has NO host transcript — the host guard would
  // normally refuse (RESUME_NO_TRANSCRIPT_MSG). skipsHostResumeGuard must bypass it.
  sm.map.set('c1', { agent: 'claude', runtime: 'devcontainer', liveSessionId: '00000000-0000-4000-8000-000000000000', cwd: dir });
  await sm._doResume('c1', dir, {});   // must NOT throw
  assert.match(captured, /devcontainer up --workspace-folder/); // wrapped, not raw claude
  assert.ok(captured.includes(dir));                            // workspace = the resume dir
  fs.rmSync(dir, { recursive: true, force: true });
});

test('_doResume: automatic discards a relaunch when the card was archived mid-launch', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-keep-arch-'));
  const sm = new SessionManager();
  sm.map.clear();
  sm.killForSession = async () => [];
  const tmuxCalls = [];
  sm._tmux = async (socket, args) => { tmuxCalls.push(args); };
  sm._save = () => {};
  sm.refreshAlive = async () => {};
  let launched;
  sm._newSession = async (tmux) => { launched = tmux; sm.map.get('c1').archivedAt = 5; };
  sm.map.set('c1', { agent: 'claude', runtime: 'devcontainer', liveSessionId: '00000000-0000-4000-8000-000000000000', cwd: dir });
  await assert.rejects(() => sm._doResume('c1', dir, { automatic: true }), /archived or snoozed during resume/);
  assert.equal(sm.map.get('c1').archivedAt, 5);
  assert.deepEqual(tmuxCalls, [['kill-session', '-t', launched]]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('_doResume: automatic discards a relaunch when a snooze appeared mid-launch and keeps it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-keep-snz-'));
  const sm = new SessionManager();
  sm.map.clear();
  sm.killForSession = async () => [];
  const tmuxCalls = [];
  sm._tmux = async (socket, args) => { tmuxCalls.push(args); };
  sm._save = () => {};
  sm.refreshAlive = async () => {};
  const snooze = { until: Date.now() + 3600_000, createdAt: 1, comment: 'recheck' };
  sm._newSession = async () => { sm.map.get('c1').snooze = snooze; };
  sm.map.set('c1', { agent: 'claude', runtime: 'devcontainer', liveSessionId: '00000000-0000-4000-8000-000000000000', cwd: dir });
  await assert.rejects(() => sm._doResume('c1', dir, { automatic: true }), /archived or snoozed during resume/);
  assert.deepEqual(sm.map.get('c1').snooze, snooze);
  assert.equal(tmuxCalls.length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('_doResume: a devcontainer workflow session resumes with the issue-to-pr skill copied in', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-dc-wf-resume-'));
  const sm = new SessionManager();
  sm.map.clear();
  sm.killForSession = async () => [];
  sm._save = () => {};
  sm.refreshAlive = async () => {};
  let captured;
  sm._newSession = async (_tmux, _dir, inner) => { captured = inner; };
  // An orchestrator-marked entry (issue/phase/startedAt) resuming under the
  // devcontainer runtime: shouldReloadWorkflowSkill(prev.workflow) must be
  // threaded into wrapLaunch so the issue-to-pr skill is copied back in.
  sm.map.set('c1', {
    agent: 'claude', runtime: 'devcontainer',
    liveSessionId: '00000000-0000-4000-8000-000000000000', cwd: dir,
    workflow: { issue: 'https://x/1', phase: { label: 'p', kind: 'run', at: 1 }, startedAt: 1 },
  });
  await sm._doResume('c1', dir, {});     // must NOT throw
  assert.match(captured, /devcontainer up --workspace-folder/);       // wrapped
  assert.match(captured, /"\$CID":'\/tmp\/aw-c1\/issue-to-pr'/);       // workflow skill copied in
  fs.rmSync(dir, { recursive: true, force: true });
});

// A codex entry whose liveSessionId differs from the card id resumes with no
// transcript/rollout IO (discover-id agent, cached live id trusted), so these
// coalescing tests exercise the guard around killForSession + _newSession
// without needing a real ~/.claude transcript on disk.
// A codex card with no cached live id falls back to discovering one from its launch
// directory. That fallback must be bounded by when the card was created: a rollout
// written before the card existed cannot be its conversation, and the resolved id is
// persisted (resumeEntry), so one bad guess binds the card to the wrong conversation
// for good. Unbounded, the newest cwd-matching rollout of ANY age won — reviving a
// months-old session in a directory that has since been reused.
function codexSessionsFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cx-resume-'));
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'cx-proj-'));
  const write = (day, uuid, mtimeMs) => {
    const dir = path.join(root, day);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `rollout-${day.replaceAll('/', '-')}T09-00-00-${uuid}.jsonl`);
    fs.writeFileSync(file, JSON.stringify({ type: 'session_meta', payload: { id: uuid, cwd: fs.realpathSync(proj) } }) + '\n');
    fs.utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
  };
  // Like `write`, but minted at an arbitrary real Date rather than a fixed
  // 09:00:00 on a fixed day — needed whenever a test's minted timestamp has to
  // sit relative to `Date.now()` (the mintedAfter floor is always launchedAt-
  // relative), rather than to a hardcoded past day that ages out of that floor
  // as real time passes.
  const writeAt = (uuid, mintedDate, mtimeMs) => {
    const pad = (n) => String(n).padStart(2, '0');
    const day = `${mintedDate.getFullYear()}/${pad(mintedDate.getMonth() + 1)}/${pad(mintedDate.getDate())}`;
    const dir = path.join(root, day);
    fs.mkdirSync(dir, { recursive: true });
    const name = `rollout-${mintedDate.getFullYear()}-${pad(mintedDate.getMonth() + 1)}-${pad(mintedDate.getDate())}T${pad(mintedDate.getHours())}-${pad(mintedDate.getMinutes())}-${pad(mintedDate.getSeconds())}-${uuid}.jsonl`;
    const file = path.join(dir, name);
    fs.writeFileSync(file, JSON.stringify({ type: 'session_meta', payload: { id: uuid, cwd: fs.realpathSync(proj) } }) + '\n');
    fs.utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
  };
  return { root, proj, write, writeAt };
}

for (const otherRollout of [false, true]) {
  test(`codex Resume restarts a first-launch updater ${otherRollout ? 'without adopting another conversation' : 'with no conversation to resume'}`, async (t) => {
    const { root, proj, writeAt } = codexSessionsFixture();
    t.after(() => {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(proj, { recursive: true, force: true });
    });
    const other = '77777777-7777-4777-8777-777777777777';
    const createdAt = Date.now() - 60_000;
    if (otherRollout) writeAt(other, new Date(createdAt + 10_000), Date.now());
    const sm = new SessionManager();
    sm.map.clear();
    sm.map.set('updating-card', {
      agent: 'codex', tmux: 'cx_update', socket: 'update-test', cwd: proj,
      name: 'My card', intent: '', createdAt, model: 'gpt-6.1', effort: 'high',
      autoCompactTokens: 120000, addDirs: ['/extra'], parentSession: 'parent-card',
    });
    if (otherRollout) sm.map.set('other-card', { agent: 'codex', cwd: proj, liveSessionId: other });
    sm.dead = new Set(['cx_update']);
    sm._save = () => {};
    sm.refreshAlive = async () => {};
    sm._tmux = async (socket, args) => {
      assert.equal(socket, 'update-test');
      assert.deepEqual(args, ['capture-pane', '-t', 'cx_update', '-p', '-S', '-60']);
      return { stdout: '🎉 Update ran successfully! Please restart Codex.' };
    };
    const kills = [];
    sm.killForSession = async (id) => { kills.push(id); return ['cx_update']; };
    let command;
    let launchDir;
    sm._newSession = async (_tmux, dir, cmd) => { command = cmd; launchDir = dir; };
    const codex = adapterFor('codex');
    const discover = codex.discoverLiveId;
    codex.discoverLiveId = (opts) => discover.call(codex, { ...opts, sessionsDir: root });
    t.after(() => { codex.discoverLiveId = discover; });
    await sm.resume('updating-card', proj);
    assert.match(command, /AW_SESSION_ID='updating-card'/);
    assert.doesNotMatch(command, /codex 'resume'|77777777-7777-4777-8777-777777777777/);
    assert.match(command, /'-m' 'gpt-6.1'/);
    assert.match(command, /'model_reasoning_effort=high'/);
    assert.match(command, /'model_auto_compact_token_limit=120000'/);
    assert.match(command, /'--add-dir' '\/extra'/);
    assert.equal(launchDir, proj);
    assert.deepEqual(kills, ['updating-card']);
    const entry = sm.entryFor('updating-card');
    assert.equal(entry.name, 'My card');
    assert.equal(entry.createdAt, createdAt);
    assert.equal(entry.intent, '');
    assert.equal(entry.parentSession, 'parent-card');
    assert.equal(entry.liveSessionId, undefined);
    assert.notEqual(entry.tmux, 'cx_update');
    if (otherRollout) assert.equal(sm.entryFor('other-card').liveSessionId, other);
  });
}

test('codex Resume keeps an existing conversation after an updater exit', async () => {
  const sm = resumableCodex('existing-update');
  sm.map.get('existing-update').tmux = 'cx_update';
  sm.dead = new Set(['cx_update']);
  sm.killForSession = async () => [];
  let command;
  sm._newSession = async (_tmux, _dir, cmd) => { command = cmd; };
  await sm.resume('existing-update', os.tmpdir());
  assert.match(command, /codex 'resume' 'live-abc'/);
  assert.equal(sm.entryFor('existing-update').liveSessionId, 'live-abc');
});

test('codex Resume retries a failed exit capture and records the fresh conversation', async (t) => {
  const { root, proj, writeAt } = codexSessionsFixture();
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(proj, { recursive: true, force: true });
  });
  const sm = new SessionManager();
  sm.map.clear();
  sm.map.set('capture-retry', { agent: 'codex', tmux: 'cx_update', cwd: proj, intent: 'Original task', createdAt: Date.now() - 60_000 });
  sm.dead = new Set(['cx_update']);
  sm._save = () => {};
  sm.refreshAlive = async () => {};
  let captures = 0;
  sm._tmux = async () => {
    if (++captures === 1) throw new Error('capture unavailable');
    return { stdout: '🎉 Update ran successfully! Please restart Codex.' };
  };
  const fresh = '88888888-8888-4888-8888-888888888888';
  let command;
  const kills = [];
  sm.killForSession = async (id) => { kills.push(id); return ['cx_update']; };
  sm._newSession = async (_tmux, _dir, cmd) => {
    command = cmd;
    writeAt(fresh, new Date(), Date.now());
  };
  const codex = adapterFor('codex');
  const discover = codex.discoverLiveId;
  codex.discoverLiveId = (opts) => discover.call(codex, { ...opts, sessionsDir: root });
  t.after(() => { codex.discoverLiveId = discover; });
  await assert.rejects(sm.resume('capture-retry', proj), /Could not read Codex exit output/);
  assert.deepEqual(kills, []);
  assert.equal(command, undefined);
  assert.equal(sm.entryFor('capture-retry').tmux, 'cx_update');
  await sm.resume('capture-retry', proj);
  assert.match(command, / 'Original task'$/);
  assert.doesNotMatch(command, /codex 'resume'/);
  assert.deepEqual(kills, ['capture-retry']);
  assert.equal(sm.entryFor('capture-retry').liveSessionId, fresh);
});

test('codex Resume leaves a replacement alone when the pane changes during exit capture', async () => {
  const sm = new SessionManager();
  sm.map.clear();
  sm.map.set('changed-update', { agent: 'codex', tmux: 'cx_update', cwd: os.tmpdir() });
  sm.dead = new Set(['cx_update']);
  sm._tmux = async () => {
    sm.map.set('changed-update', { agent: 'codex', tmux: 'cx_replacement', liveSessionId: 'live-replacement' });
    return { stdout: '🎉 Update ran successfully! Please restart Codex.' };
  };
  sm.killForSession = async () => { throw new Error('must not kill replacement'); };
  sm._newSession = async () => { throw new Error('must not launch'); };
  await assert.rejects(sm.resume('changed-update', os.tmpdir()), /Codex pane changed/);
  assert.equal(sm.entryFor('changed-update').tmux, 'cx_replacement');
  assert.equal(sm.entryFor('changed-update').liveSessionId, 'live-replacement');
});

for (const [label, state] of [
  ['archived', { archivedAt: 5 }],
  ['snoozed', { snooze: { until: 9_000_000, createdAt: 1, comment: 'later' } }],
]) {
  test(`automatic Codex update recovery preserves a card ${label} during conversation lookup`, async (t) => {
    const sm = new SessionManager();
    sm.map.clear();
    sm.map.set('automatic-update', { agent: 'codex', tmux: 'cx_update', cwd: os.tmpdir() });
    sm.dead = new Set(['cx_update']);
    sm.killForSession = async () => [];
    let launched;
    sm._newSession = async (tmux) => { launched = tmux; };
    const discarded = [];
    sm._tmux = async (_socket, args) => {
      if (args[0] === 'capture-pane') return { stdout: '🎉 Update ran successfully! Please restart Codex.' };
      assert.equal(args[0], 'kill-session');
      discarded.push(args[args.indexOf('-t') + 1]);
    };
    t.mock.method(adapterFor('codex'), 'discoverLiveId', async () => {
      Object.assign(sm.entryFor('automatic-update'), state);
      return 'live-fresh';
    });
    await assert.rejects(sm.resume('automatic-update', os.tmpdir(), { automatic: true }), /archived or snoozed during resume/);
    for (const [key, value] of Object.entries(state)) assert.deepEqual(sm.entryFor('automatic-update')[key], value);
    assert.equal(sm.entryFor('automatic-update').liveSessionId, undefined);
    assert.deepEqual(discarded, [launched]);
  });
}

test('codex resume never binds a card to a rollout older than the card itself', async () => {
  const { root, proj, write } = codexSessionsFixture();
  const stale = '11111111-1111-4111-8111-111111111111';
  const mine = '22222222-2222-4222-8222-222222222222';
  const cardCreatedAt = new Date(2026, 5, 1).getTime(); // card minted June; the stale rollout is from January
  // Same directory, reused months apart. The stale rollout is deliberately given the
  // NEWER mtime — resuming an old conversation rewrites its file, which is exactly how
  // a superseded rollout becomes the best mtime match for everything in that directory.
  write('2026/01/05', stale, cardCreatedAt + 5_000);
  write('2026/06/10', mine, cardCreatedAt + 1_000);

  const sm = new SessionManager();
  sm.map.clear();
  sm.map.set('card-old', { agent: 'codex', cwd: proj, createdAt: cardCreatedAt });
  sm._save = () => {};
  sm.refreshAlive = async () => {};
  sm.killForSession = async () => [];
  let launched = '';
  sm._newSession = async (_tmux, _dir, cmd) => { launched = cmd; };

  const codex = adapterFor('codex');
  const original = codex.discoverLiveId;
  // Bind the real discovery to the fixture tree; the floor under test is the one the
  // resume path chooses, which is what this asserts.
  codex.discoverLiveId = (opts) => original.call(codex, { ...opts, sessionsDir: root });
  try {
    await sm._doResume('card-old', proj, {});
  } finally {
    codex.discoverLiveId = original;
  }

  assert.doesNotMatch(launched, new RegExp(stale), 'resumed a rollout predating the card');
  assert.match(launched, new RegExp(mine), 'should resume the rollout written after the card was created');
  assert.equal(sm.map.get('card-old').liveSessionId, mine, 'and must not persist the stale id');
});

test('codex resume with no createdAt still refuses nothing it can already resolve', async () => {
  // Legacy entries predate createdAt. They keep the old unbounded behaviour rather
  // than becoming unresumable — documented, not accidental.
  const { root, proj, write } = codexSessionsFixture();
  const only = '33333333-3333-4333-8333-333333333333';
  write('2026/01/05', only, 1_000_000);

  const sm = new SessionManager();
  sm.map.clear();
  sm.map.set('card-legacy', { agent: 'codex', cwd: proj });
  sm._save = () => {};
  sm.refreshAlive = async () => {};
  sm.killForSession = async () => [];
  let launched = '';
  sm._newSession = async (_tmux, _dir, cmd) => { launched = cmd; };

  const codex = adapterFor('codex');
  const original = codex.discoverLiveId;
  codex.discoverLiveId = (opts) => original.call(codex, { ...opts, sessionsDir: root });
  try {
    await sm._doResume('card-legacy', proj, {});
  } finally {
    codex.discoverLiveId = original;
  }
  assert.match(launched, new RegExp(only));
});

// dispatch/fork's initial discovery had no equivalent of the resume guard above:
// a nested child spawned into the SAME cwd as its still-live parent matches the
// parent's rollout on cwd too, and the parent's rollout — actively being written
// to as the parent keeps chatting — wins the newest-mtime race even though it
// was minted long before this dispatch. That handed the child's card the
// parent's conversation id, which is what made the chat view show one session's
// transcript under the other's card (terminal read stayed correct because it's
// keyed by tmux name, not liveSessionId).
test('dispatch does not bind a fresh codex card to a concurrently-active sibling rollout in the same cwd', async () => {
  const { root, proj, writeAt } = codexSessionsFixture();
  const sibling = '11111111-1111-4111-8111-111111111111';
  const mine = '22222222-2222-4222-8222-222222222222';

  const now = Date.now();
  // The sibling was minted an hour before this dispatch — an already-running
  // peer sharing the same cwd — but its file keeps getting touched because it's
  // still actively chatting, so its mtime is the newest thing in the directory.
  writeAt(sibling, new Date(now - 3_600_000), now + 10);
  // This dispatch's own rollout: minted just now, touched once, older mtime.
  writeAt(mine, new Date(now + 1), now + 5);

  const sm = smForDispatch();
  sm._ensureCodexTrust = () => {};
  const codex = adapterFor('codex');
  const original = codex.discoverLiveId;
  codex.discoverLiveId = (opts) => original.call(codex, { ...opts, sessionsDir: root });
  let sessionId;
  try {
    ({ sessionId } = await sm.dispatch({ cwd: proj, intent: 'x', agent: 'codex' }));
  } finally {
    codex.discoverLiveId = original;
  }
  assert.equal(sm.map.get(sessionId).liveSessionId, mine, "must not adopt the actively-writing sibling's rollout");
});

// mintedAfter alone narrows the race but doesn't close it: two dispatches into
// the same cwd within the discovery window can both have rollouts that are
// "new enough". The actual invariant is ownership — noteLiveSessionId already
// refuses to repoint a card onto a conversation another card owns (cardForLive,
// above) — and _resolveLiveId's first discovery needs the same check, not just
// a time floor. This pins that directly: the owned rollout is the newer file,
// so a time-only guard would still pick it.
test('dispatch never adopts a rollout another card already owns, even when it is the newer match', async () => {
  const { root, proj, writeAt } = codexSessionsFixture();
  const owned = '11111111-1111-4111-8111-111111111111';
  const mine = '22222222-2222-4222-8222-222222222222';
  const now = Date.now();
  const mintedAt = new Date(now); // both minted "now" — only ownership tells them apart
  writeAt(owned, mintedAt, now + 10); // newer mtime — would win without the ownership check
  writeAt(mine, mintedAt, now + 5);

  const sm = smForDispatch();
  sm._ensureCodexTrust = () => {};
  sm.map.set('other-card', { agent: 'codex', cwd: proj, liveSessionId: owned });
  const codex = adapterFor('codex');
  const original = codex.discoverLiveId;
  codex.discoverLiveId = (opts) => original.call(codex, { ...opts, sessionsDir: root });
  let sessionId;
  try {
    ({ sessionId } = await sm.dispatch({ cwd: proj, intent: 'x', agent: 'codex' }));
  } finally {
    codex.discoverLiveId = original;
  }
  assert.equal(sm.map.get(sessionId).liveSessionId, mine, "must not double-bind another card's conversation");
});

// fork() shares _resolveLiveId with dispatch() and needs the same coverage —
// a forked codex session landing in its parent's cwd is exactly the nested-
// worker shape the ownership check exists for.
test('fork() never adopts a rollout another card already owns', async () => {
  const { root, proj, writeAt } = codexSessionsFixture();
  const owned = '33333333-3333-4333-8333-333333333333';
  const mine = '44444444-4444-4444-8444-444444444444';
  const now = Date.now();
  const mintedAt = new Date(now);
  writeAt(owned, mintedAt, now + 10);
  writeAt(mine, mintedAt, now + 5);

  const sm = new SessionManager();
  sm.map.clear();
  sm._newSession = async () => {};
  sm._save = () => {};
  sm.refreshAlive = async () => {};
  sm.map.set('other-card', { agent: 'codex', cwd: proj, liveSessionId: owned });
  const codex = adapterFor('codex');
  const original = codex.discoverLiveId;
  codex.discoverLiveId = (opts) => original.call(codex, { ...opts, sessionsDir: root });
  let sessionId;
  try {
    ({ sessionId } = await sm.fork({
      sourceId: 'SRC', parentId: 'other-card',
      parentEntry: { agent: 'codex', cwd: proj },
      cwd: proj,
    }));
  } finally {
    codex.discoverLiveId = original;
  }
  assert.equal(sm.map.get(sessionId).liveSessionId, mine, "must not double-bind another card's conversation");
});

function resumableCodex(cardId = 'card-race') {
  const sm = new SessionManager();
  sm.map.clear();
  sm.map.set(cardId, { agent: 'codex', cwd: os.tmpdir(), liveSessionId: 'live-abc' });
  sm._save = () => {};
  sm.refreshAlive = async () => {};
  return sm;
}

test('resume() coalesces two concurrent resumes of the same session into one kill+relaunch', async () => {
  // The cross-path race review finding #2 missed: the manual WS resume, the schedule
  // runner, and the snooze auto-wake sweep all call resume(cardId) — a second call
  // arriving while the first is still spawning its tmux would killForSession the
  // freshly-booted pane (losing its note) and double-relaunch. The guard makes the
  // second call JOIN the in-flight promise instead.
  const sm = resumableCodex('card-race');
  let kills = 0;
  let launches = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  sm.killForSession = async () => { kills += 1; return []; };
  sm._newSession = async () => { launches += 1; await gate; }; // held open so the two calls overlap

  const p1 = sm.resume('card-race', os.tmpdir(), { intent: 'note' });
  const p2 = sm.resume('card-race', os.tmpdir()); // arrives mid-boot, no intent (manual path)
  assert.equal(p1, p2, 'the second concurrent resume joins the in-flight promise');
  release();
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(kills, 1, 'exactly one killForSession — the second call never re-killed mid-boot');
  assert.equal(launches, 1, 'exactly one relaunch — no double-relaunch');
  assert.deepEqual(r1, r2); // both callers see the identical result...
  assert.ok(r1.tmux, '...carrying the { tmux } shape a coalesced caller expects');
  assert.equal(sm._resuming.size, 0, 'the guard is released once the resume settles');
});

test('resume() sequential resumes each relaunch (guard released after settle)', async () => {
  const sm = resumableCodex('card-seq');
  let launches = 0;
  sm.killForSession = async () => [];
  sm._newSession = async () => { launches += 1; };
  await sm.resume('card-seq', os.tmpdir());
  await sm.resume('card-seq', os.tmpdir()); // after the first settled — a fresh kill+relaunch
  assert.equal(launches, 2, 'sequential resumes are unaffected by the guard');
});

test('resume() shares a rejection with joined callers and clears the guard so a later resume retries', async () => {
  const sm = resumableCodex('card-reject');
  let launches = 0;
  let boom = true;
  let release;
  const gate = new Promise((r) => { release = r; });
  sm.killForSession = async () => [];
  sm._newSession = async () => { await gate; if (boom) throw new Error('spawn failed'); launches += 1; };

  const p1 = sm.resume('card-reject', os.tmpdir(), { intent: 'note' });
  const p2 = sm.resume('card-reject', os.tmpdir()); // joins the in-flight (about-to-reject) resume
  assert.equal(p1, p2);
  release();
  await assert.rejects(() => p1, /spawn failed/);
  await assert.rejects(() => p2, /spawn failed/); // both joined callers see the same rejection
  assert.equal(sm._resuming.size, 0, 'the finally clears the entry even when the resume throws');

  boom = false; // the transient failure is gone; a later resume must be able to retry
  const { tmux } = await sm.resume('card-reject', os.tmpdir());
  assert.equal(launches, 1);
  assert.ok(tmux);
});

test('resume() re-threads the persisted entry.effort into buildResume (effort is per-invocation, not transcript-restored)', async () => {
  const sm = resumableCodex('card-effort');
  sm.map.get('card-effort').effort = 'medium';
  let captured = '';
  sm.killForSession = async () => [];
  sm._newSession = async (_t, _d, inner) => { captured = inner; };
  await sm.resume('card-effort', os.tmpdir());
  assert.match(captured, /'model_reasoning_effort=medium'/);
});

// End to end for the grants: a sandboxed agent given reach outside its cwd must
// still have it after an idle-suspend + resume, or the resumed session silently
// loses access to paths its work depends on.
test('resume() re-grants the persisted entry.addDirs, and keeps them on the rebuilt entry', async () => {
  const sm = resumableCodex('card-git-access');
  sm.map.get('card-git-access').addDirs = ['/projects/main/.git'];
  let captured = '';
  sm.killForSession = async () => [];
  sm._newSession = async (_t, _d, inner) => { captured = inner; };
  await sm.resume('card-git-access', os.tmpdir());
  assert.ok(captured.includes("'--add-dir' '/projects/main/.git'"));
  assert.deepEqual(sm.map.get('card-git-access').addDirs, ['/projects/main/.git']);
});

test('resume() re-threads the persisted auto-compaction threshold into buildResume', async () => {
  const sm = resumableCodex('card-compact');
  sm.map.get('card-compact').autoCompactTokens = 400000;
  let captured = '';
  sm.killForSession = async () => [];
  sm._newSession = async (_t, _d, inner) => { captured = inner; };
  await sm.resume('card-compact', os.tmpdir());
  assert.match(captured, /'model_auto_compact_token_limit=400000'/);
  assert.equal(sm.map.get('card-compact').autoCompactTokens, 400000);
});

// Trust is no longer part of the launch command (verified against the real
// Codex binary that a `-c projects.<path>.trust_level` override is silently
// ignored by its interactive trust dialog) — resume() instead calls
// this._ensureCodexTrust (codex-trust.js) to persist it before relaunch.
test('resume() threads trustCodexLaunchCwd into ensureCodexTrust, keyed on the entry worktree repoRoot when present', async () => {
  const sm = resumableCodex('card-trust');
  sm.killForSession = async () => [];
  sm._newSession = async () => {};
  let trusted = [];
  sm._ensureCodexTrust = (p) => trusted.push(p);
  await sm.resume('card-trust', os.tmpdir());
  // Default config.json has no trustCodexLaunchCwd override — reads the on
  // default, so the resume dir is trusted (no worktree on this entry).
  assert.deepEqual(trusted, [os.tmpdir()]);

  const sm2 = new SessionManager();
  sm2.map.set('card-trust-wt', { agent: 'codex', cwd: '/wt', liveSessionId: 'live-wt', worktree: { path: '/wt', branch: 'b', repoRoot: '/repo' } });
  sm2._save = () => {};
  sm2.refreshAlive = async () => {};
  sm2.killForSession = async () => [];
  sm2._newSession = async () => {};
  trusted = [];
  sm2._ensureCodexTrust = (p) => trusted.push(p);
  await sm2.resume('card-trust-wt', '/wt');
  // A worktree entry trusts the worktree's MAIN checkout, not the worktree
  // path itself — Codex resolves a linked worktree's trust to that root.
  assert.deepEqual(trusted, ['/repo']);
});

test('resume() adds the linked worktree common git-dir via --add-dir for a codex entry', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-resume-wt-'));
  const { worktreePath, gitDir } = realWorktreeRepo(root);
  const worktreeGitDir = execFileSync('git', ['-C', worktreePath, 'rev-parse', '--path-format=absolute', '--git-dir'], { encoding: 'utf8' }).trim();
  const sm = new SessionManager();
  sm.map.clear();
  sm.map.set('card-wt', {
    agent: 'codex', cwd: worktreePath, liveSessionId: 'live-wt',
    worktree: { path: worktreePath, branch: 'feature', repoRoot: path.dirname(worktreePath) },
  });
  sm._save = () => {};
  sm.refreshAlive = async () => {};
  sm.killForSession = async () => [];
  sm._ensureCodexTrust = () => {};
  let captured = '';
  sm._newSession = async (_t, _d, inner) => { captured = inner; };
  await sm.resume('card-wt', worktreePath);
  assert.ok(captured.includes(`'--add-dir' '${gitDir}'`), captured);
  assert.ok(captured.includes(`'--add-dir' '${worktreeGitDir}'`), captured);
  fs.rmSync(root, { recursive: true, force: true });
});

test('resolveWorktree creates a worktree and returns its path + branch', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-disp-'));
  const repo = path.join(root, 'proj');
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, 'f.txt'), 'x');
  const git = (...a) => execFileSync('git', ['-C', repo, ...a], { stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'i');

  const res = await resolveWorktree({
    cwd: repo, intent: 'fix the bug', branch: '', folderName: '', auto: true, short: 'abcd1234',
  });
  assert.equal(res.branch, 'fix-bug');
  assert.equal(path.basename(res.cwd), 'proj-worktree-fix-bug');
  assert.equal(res.worktree.path, res.cwd);
});

test('resolveWorktree sanitizes a branch to [A-Za-z0-9-]', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-san-'));
  const repo = path.join(root, 'proj');
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, 'f.txt'), 'x');
  const git = (...a) => execFileSync('git', ['-C', repo, ...a], { stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'i');

  const res = await resolveWorktree({ cwd: repo, branch: 'feat/spaces & stuff', auto: false });
  assert.match(res.branch, /^[A-Za-z0-9-]+$/);
});

test('resolveWorktree branches from an explicit base, and refuses one git would not take', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-base-'));
  const repo = path.join(root, 'proj');
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, 'f.txt'), 'x');
  const git = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8', stdio: 'pipe' }).trim();
  git('init', '-q', '-b', 'main');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'i');
  const base = git('rev-parse', 'HEAD');
  git('update-ref', 'refs/remotes/origin/main', base);
  // Local main moves on; the base must win, or a job branches off whatever the
  // human happened to leave in their checkout.
  fs.writeFileSync(path.join(repo, 'local-only.txt'), 'local work');
  git('add', 'local-only.txt');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'local only');

  const res = await resolveWorktree({ cwd: repo, branch: 'from-base', auto: true, base: 'refs/remotes/origin/main' });
  assert.equal(execFileSync('git', ['-C', res.cwd, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), base);
  assert.equal(fs.existsSync(path.join(res.cwd, 'local-only.txt')), false);

  // A revision EXPRESSION is not a ref: refused here rather than handed to
  // `git worktree add`, where it would read as a commit-ish to be interpreted.
  await assert.rejects(
    () => resolveWorktree({ cwd: repo, branch: 'bad-base', auto: true, base: 'HEAD~1' }),
    (e) => /not a valid base ref/.test(e.message),
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test('resolveWorktree refuses a blank or scratch-dir cwd (no silent skip)', async () => {
  await assert.rejects(
    () => resolveWorktree({ cwd: '', intent: 'x', auto: true, short: 'ab' }),
    (e) => /scratch|real git/i.test(e.message),
  );
  await assert.rejects(
    () => resolveWorktree({ cwd: path.join(SESSIONS_DIR, '20260101120000', 'sub'), intent: 'x', auto: true, short: 'ab' }),
    (e) => /scratch|real git/i.test(e.message),
  );
});

test('renameWorktreeBranch renames the git branch and syncs entry.worktree.branch', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-ren-'));
  const repo = path.join(root, 'proj');
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, 'f.txt'), 'x');
  const git = (...a) => execFileSync('git', ['-C', repo, ...a], { stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'i');
  const wt = await resolveWorktree({ cwd: repo, intent: 'placeholder', auto: false });

  const sm = new SessionManager();
  sm.map.clear();
  let saved = 0; sm._save = () => { saved += 1; };
  sm.map.set('CARD1', { short: 'a', tmux: 'cc_a', createdAt: 1, worktree: wt.worktree });

  const branch = await sm.renameWorktreeBranch('CARD1', 'Improve Branch Names!');
  assert.equal(branch, 'improve-branch-names');
  assert.equal(sm.map.get('CARD1').worktree.branch, 'improve-branch-names');
  assert.equal(await readBranch(wt.cwd), 'improve-branch-names');
  assert.ok(saved >= 1);
});

test('renameWorktreeBranch throws for a session with no wrangler-created worktree', async () => {
  const sm = new SessionManager();
  sm.map.clear();
  sm._save = () => {};
  sm.map.set('CARD2', { short: 'b', tmux: 'cc_b', createdAt: 1 });
  await assert.rejects(() => sm.renameWorktreeBranch('CARD2', 'whatever'), /no wrangler-created worktree/);
  await assert.rejects(() => sm.renameWorktreeBranch('nope', 'whatever'), /Unknown session/);
});

// The constructor _load()s the real mappings file; clear it and stub _save so
// these tests neither depend on nor mutate ~/.agent-wrangler/mappings.json.
function freshManager() {
  const sm = new SessionManager();
  sm.map.clear();
  sm._save = () => {};
  return sm;
}

test('setSnooze adopts an unmapped session and stores until + createdAt', () => {
  const sm = freshManager();
  sm.setSnooze('sess-new', 1_000_000, { cwd: '/x', intent: 'hi' });
  const e = sm.entryFor('sess-new');
  assert.equal(e.snooze.until, 1_000_000);
  assert.equal(typeof e.snooze.createdAt, 'number');
  assert.equal(e.cwd, '/x'); // adopted from snapshot
  // Serializes the way _save persists it (Object.fromEntries -> JSON).
  const round = JSON.parse(JSON.stringify(Object.fromEntries(sm.map)));
  assert.equal(round['sess-new'].snooze.until, 1_000_000);
});

test('setSnooze stores a trimmed comment on the snooze object when one is given', () => {
  const sm = freshManager();
  sm.setSnooze('sess-c', 1_000_000, { cwd: '/x', comment: '  finish the migration  ' });
  assert.equal(sm.entryFor('sess-c').snooze.comment, 'finish the migration');
  // Rides the same persistence as until/createdAt.
  const round = JSON.parse(JSON.stringify(Object.fromEntries(sm.map)));
  assert.equal(round['sess-c'].snooze.comment, 'finish the migration');
});

test('setSnooze omits the comment key when blank, whitespace-only, or absent', () => {
  const sm = freshManager();
  sm.setSnooze('a', 1_000_000, { cwd: '/x' });
  sm.setSnooze('b', 1_000_000, { cwd: '/x', comment: '   ' });
  sm.setSnooze('c', 1_000_000, { cwd: '/x', comment: '' });
  assert.equal('comment' in sm.entryFor('a').snooze, false);
  assert.equal('comment' in sm.entryFor('b').snooze, false);
  assert.equal('comment' in sm.entryFor('c').snooze, false);
});

test('clearSnooze drops a stored comment along with the snooze', () => {
  const sm = freshManager();
  sm.setSnooze('sess-c', 2_000_000, { cwd: '/y', comment: 'a note' });
  assert.equal(sm.entryFor('sess-c').snooze.comment, 'a note');
  sm.clearSnooze('sess-c');
  assert.equal(sm.entryFor('sess-c').snooze, undefined);
});

test('setSnooze on an existing entry keeps the rest of the entry', () => {
  const sm = freshManager();
  sm.map.set('sess-x', { short: 'ab', tmux: 'cc_x', cwd: '/y', intent: 'k', createdAt: 1 });
  sm.setSnooze('sess-x', 2_000_000);
  assert.equal(sm.entryFor('sess-x').snooze.until, 2_000_000);
  assert.equal(sm.entryFor('sess-x').tmux, 'cc_x'); // untouched
});

test('clearSnooze removes the field but keeps the entry', () => {
  const sm = freshManager();
  sm.setSnooze('sess-x', 2_000_000, { cwd: '/y' });
  assert.equal(sm.clearSnooze('sess-x'), true);
  assert.equal(sm.entryFor('sess-x').snooze, undefined);
  assert.ok(sm.entryFor('sess-x')); // entry itself stays
  assert.equal(sm.clearSnooze('sess-x'), false); // no-op second time
});

test('detachSession clears parentSession, keeping the rest of the entry', () => {
  const sm = new SessionManager();
  sm._save = () => {};
  sm.map.set('child', { short: 's', tmux: 'cc_c', parentSession: 'parent', name: 'Kept' });
  assert.equal(sm.detachSession('child'), true);
  assert.deepEqual(sm.map.get('child'), { short: 's', tmux: 'cc_c', name: 'Kept' });
});

test('detachSession is a no-op (false) for an unmapped session', () => {
  const sm = new SessionManager();
  sm._save = () => {};
  assert.equal(sm.detachSession('ghost'), false);
});

test('attachSession sets parentSession to the given target', () => {
  const sm = new SessionManager();
  sm._save = () => {};
  sm.map.set('child', { short: 's', tmux: 'cc_c' });
  sm.map.set('newparent', { short: 'p', tmux: 'cc_p' });
  assert.equal(sm.attachSession('child', 'newparent'), true);
  assert.equal(sm.map.get('child').parentSession, 'newparent');
});

test('attachSession is a no-op (false) when the child is unmapped', () => {
  const sm = new SessionManager();
  sm._save = () => {};
  sm.map.set('newparent', { short: 'p', tmux: 'cc_p' });
  assert.equal(sm.attachSession('ghost', 'newparent'), false);
});

test('attachSession is a no-op (false) when the target parent is unmapped', () => {
  const sm = new SessionManager();
  sm._save = () => {};
  sm.map.set('child', { short: 's', tmux: 'cc_c' });
  assert.equal(sm.attachSession('child', 'ghost'), false);
  assert.equal(sm.map.get('child').parentSession, undefined);
});

// "New child sessions show full view by default" is a CREATION-time snapshot,
// not a live rule (see config-store.js childFullViewByDefault) — attachSession
// stamps it in once, the first time a session becomes a child.
test('attachSession stamps entry.childFullView from the current default the first time a session becomes a child', async () => {
  await withChildFullViewDefault(false, () => {
    const sm = new SessionManager();
    sm._save = () => {};
    sm.map.set('child', { short: 's', tmux: 'cc_c' });
    sm.map.set('newparent', { short: 'p', tmux: 'cc_p' });
    sm.attachSession('child', 'newparent');
    assert.equal(sm.map.get('child').childFullView, false);
  });
  await withChildFullViewDefault(true, () => {
    const sm = new SessionManager();
    sm._save = () => {};
    sm.map.set('child2', { short: 's', tmux: 'cc_c' });
    sm.map.set('newparent2', { short: 'p', tmux: 'cc_p' });
    sm.attachSession('child2', 'newparent2');
    assert.equal(sm.map.get('child2').childFullView, true);
  });
});

test('attachSession does not overwrite an already-stamped childFullView on re-attach', () => {
  const sm = new SessionManager();
  sm._save = () => {};
  sm.map.set('child', { short: 's', tmux: 'cc_c', childFullView: true }); // explicit prior choice
  sm.map.set('newparent', { short: 'p', tmux: 'cc_p' });
  sm.attachSession('child', 'newparent');
  assert.equal(sm.map.get('child').childFullView, true);
});

test('setWorkflowPhase adopts an unmapped session and stamps a timestamped phase', () => {
  const sm = freshManager();
  sm.setWorkflowPhase('wf-new', { label: 'planning', kind: 'active' }, { cwd: '/x' });
  const e = sm.entryFor('wf-new');
  assert.equal(e.workflow.phase.label, 'planning');
  assert.equal(e.workflow.phase.kind, 'active');
  assert.equal(typeof e.workflow.phase.at, 'number');
  assert.equal(e.cwd, '/x'); // adopted from snapshot, mirroring setSnooze
});

test('setWorkflowPhase preserves issue/startedAt across a phase change', () => {
  const sm = freshManager();
  sm.map.set('wf', { short: 'a', tmux: 'cc_a', createdAt: 1, workflow: { issue: 'ENT-1', startedAt: 5, phase: { label: 'starting', kind: 'active', at: 5 } } });
  sm.setWorkflowPhase('wf', { label: 'implementing', kind: 'active' });
  const wf = sm.entryFor('wf').workflow;
  assert.equal(wf.issue, 'ENT-1');
  assert.equal(wf.startedAt, 5);
  assert.equal(wf.phase.label, 'implementing');
});

// dispatch() runs tmux/save/refresh; stub those side effects like the fork test.
function smForDispatch() {
  const sm = new SessionManager();
  sm.map.clear();
  sm._newSession = async () => {};
  sm._save = () => {};
  sm.refreshAlive = async () => {};
  return sm;
}

// Nothing else records the grants, so an unstamped entry is a resume that cannot
// re-grant them. Only what the caller asked for is stored: the codex git-dir is
// re-derived from the cwd per launch, and persisting it would double the flag.
test('dispatch stamps the addDirs it was asked for onto the entry, and nothing else', async () => {
  const sm = smForDispatch();
  const granted = await sm.dispatch({ cwd: os.tmpdir(), intent: 'x', addDirs: [os.tmpdir()] });
  assert.deepEqual(sm.map.get(granted.sessionId).addDirs, [os.tmpdir().replace(/(?!^)\/+$/, '')]);
  const none = await sm.dispatch({ cwd: os.tmpdir(), intent: 'x' });
  assert.equal(sm.map.get(none.sessionId).addDirs, undefined);
});

test('dispatch stamps entry.workflow from the workflow opt', async () => {
  const sm = smForDispatch();
  const wf = { issue: 'ENT-9', phase: { label: 'starting', kind: 'active', at: 1 }, startedAt: 1 };
  const { sessionId } = await sm.dispatch({ cwd: os.tmpdir(), intent: 'x', workflow: wf });
  assert.deepEqual(sm.map.get(sessionId).workflow, wf);
});

test('dispatch merges onto an entry an early setWorkflowPhase adopted, without clobbering it', async () => {
  const sm = smForDispatch();
  // No workflow opt, but a phase is reported pre-map.set via the launch-context
  // seam (which fires before the entry is written) — it must survive the dispatch
  // write, while the real launch fields win over the adopted stub's placeholders.
  sm._launchContext = async ({ sid }) => { sm.setWorkflowPhase(sid, { label: 'planning', kind: 'active' }); return { env: {}, addDirs: [] }; };
  const { sessionId } = await sm.dispatch({ cwd: os.tmpdir(), intent: 'hello' });
  const e = sm.map.get(sessionId);
  assert.equal(e.workflow.phase.label, 'planning'); // adopted phase preserved
  assert.equal(e.intent, 'hello');
  assert.ok(e.tmux.startsWith('cc_'));
});

test('dispatch: the launch workflow opt wins over an early adopted phase', async () => {
  const sm = smForDispatch();
  const wf = { issue: 'ENT-9', phase: { label: 'starting', kind: 'active', at: 1 }, startedAt: 1 };
  sm._launchContext = async ({ sid }) => { sm.setWorkflowPhase(sid, { label: 'planning' }); return { env: {}, addDirs: [] }; };
  const { sessionId } = await sm.dispatch({ cwd: os.tmpdir(), intent: 'x', workflow: wf });
  assert.deepEqual(sm.map.get(sessionId).workflow, wf);
});

test('dispatch: an orchestrator run loads the issue-to-pr skill; a plain/child dispatch (no workflow opt) does not', async () => {
  // Capture the inner command handed to the launcher to see whether the plugin was loaded.
  const inners = [];
  const sm = smForDispatch();
  sm._newSession = async (_tmux, _dir, inner) => { inners.push(inner); };

  const orch = await sm.dispatch({ cwd: os.tmpdir(), intent: 'x', workflow: { issue: 'ENT-9', startedAt: 1 } });
  assert.match(inners[0], /\/skills\/issue-to-pr/);
  assert.ok(sm.map.get(orch.sessionId).workflow.issue); // still an orchestrator marker

  const worker = await sm.dispatch({ cwd: os.tmpdir(), intent: 'y', parentSession: 'ORCH' });
  assert.doesNotMatch(inners[1], /\/skills\/issue-to-pr/); // a worker is briefed via intent, not the skill
  assert.equal(sm.map.get(worker.sessionId).parentSession, 'ORCH'); // but it's still linked
  assert.equal(sm.map.get(worker.sessionId).workflow, undefined); // workers never carry `workflow` now
});

test('dispatch stores parentSession when passed', async () => {
  const sm = smForDispatch();
  const { sessionId } = await sm.dispatch({ cwd: os.tmpdir(), intent: 'x', parentSession: 'ORCH1' });
  assert.equal(sm.map.get(sessionId).parentSession, 'ORCH1');
});

test('dispatch leaves parentSession undefined when not passed', async () => {
  const sm = smForDispatch();
  const { sessionId } = await sm.dispatch({ cwd: os.tmpdir(), intent: 'x' });
  assert.equal(sm.map.get(sessionId).parentSession, undefined);
});

// A `nest:true` spawn sets parentSession directly in dispatch() — the session
// IS a child from creation, so this is the same creation-time stamp as
// attachSession (see the comment there).
test('dispatch stamps entry.childFullView from the current default when parentSession is passed', async () => {
  await withChildFullViewDefault(false, async () => {
    const sm = smForDispatch();
    const { sessionId } = await sm.dispatch({ cwd: os.tmpdir(), intent: 'y', parentSession: 'ORCH1' });
    assert.equal(sm.map.get(sessionId).childFullView, false);
  });
  await withChildFullViewDefault(true, async () => {
    const sm = smForDispatch();
    const { sessionId } = await sm.dispatch({ cwd: os.tmpdir(), intent: 'z', parentSession: 'ORCH2' });
    assert.equal(sm.map.get(sessionId).childFullView, true);
  });
});

test('dispatch leaves entry.childFullView undefined for a non-nested dispatch', async () => {
  const sm = smForDispatch();
  const { sessionId } = await sm.dispatch({ cwd: os.tmpdir(), intent: 'x' });
  assert.equal(sm.map.get(sessionId).childFullView, undefined);
});

test('dispatch persists entry.effort and passes it to buildLaunch', async () => {
  const sm = smForDispatch();
  let captured = '';
  sm._newSession = async (_t, _d, inner) => { captured = inner; };
  const { sessionId } = await sm.dispatch({ cwd: os.tmpdir(), intent: 'x', effort: 'high' });
  assert.equal(sm.map.get(sessionId).effort, 'high');
  assert.match(captured, /--effort' 'high'/);
});

test('dispatch persists auto-compaction threshold and passes it to buildLaunch', async () => {
  const sm = smForDispatch();
  let captured = '';
  sm._newSession = async (_t, _d, inner) => { captured = inner; };
  const { sessionId } = await sm.dispatch({ cwd: os.tmpdir(), intent: 'x', autoCompactTokens: 200000 });
  assert.equal(sm.map.get(sessionId).autoCompactTokens, 200000);
  assert.match(captured, /'--autocompact' '200000'/);
});

test('dispatch rejects an invalid auto-compaction threshold before launching', async () => {
  const sm = smForDispatch();
  let launched = false;
  sm._newSession = async () => { launched = true; };
  await assert.rejects(() => sm.dispatch({ cwd: os.tmpdir(), intent: 'x', autoCompactTokens: 90000 }), /100000/);
  assert.equal(launched, false);
});

test('dispatch builds the command from whatever the launch context answered, for Codex too', async () => {
  const sm = smForDispatch();
  sm._resolveLiveId = async () => 'codex-live';
  let captured = '';
  sm._newSession = async (_t, _d, inner) => { captured = inner; };
  const memoryDir = path.join(os.tmpdir(), 'aw-memory', 'tasks', 'T1');
  const memoryPath = path.join(memoryDir, 'memory.md');
  // The extension's hook is told agent:'codex' and answers the resolved real path.
  const asked = [];
  sm._launchContext = async (ctx) => { asked.push(ctx); return { env: { AW_TASK_MEMORY: memoryPath }, addDirs: [memoryDir] }; };
  await sm.dispatch({ cwd: os.tmpdir(), intent: 'x', agent: 'codex', taskId: 'T1' });
  assert.equal(asked.length, 1);
  assert.deepEqual({ ...asked[0], sid: undefined }, { sid: undefined, task: { id: 'T1' }, agent: 'codex', runtime: 'local', reason: 'dispatch' });
  assert.match(captured, new RegExp(`AW_TASK_MEMORY='${memoryPath}'`));
  assert.ok(captured.includes(`'--add-dir' '${memoryDir}'`));
  assert.doesNotMatch(captured, /by-session/);
});

// Trust is no longer part of the launch command (verified against the real
// Codex binary that a `-c projects.<path>.trust_level` override is silently
// ignored by its interactive trust dialog) — dispatch() instead calls
// this._ensureCodexTrust (codex-trust.js) to persist it before launch. The
// worktree-vs-plain-cwd key selection is identical to resume()/fork() (see
// those tests for the worktree-repoRoot case); this covers dispatch's own
// wiring plus the agent gate.
test('dispatch threads trustCodexLaunchCwd into ensureCodexTrust for a codex session', async () => {
  const sm = smForDispatch();
  let trusted = [];
  sm._ensureCodexTrust = (p) => trusted.push(p);
  await sm.dispatch({ cwd: os.tmpdir(), intent: 'x', agent: 'codex' });
  // Default config.json has no trustCodexLaunchCwd override — reads the on
  // default, so the launch cwd is trusted.
  assert.deepEqual(trusted, [os.tmpdir()]);
});

test('dispatch: worktree mode adds the linked worktree common git-dir via --add-dir for codex', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aw-dispatch-wt-'))); // macOS: /var -> /private/var
  const repo = path.join(root, 'proj');
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, 'f.txt'), 'x');
  const git = (...a) => execFileSync('git', ['-C', repo, ...a], { stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'i');

  const sm = smForDispatch();
  sm._ensureCodexTrust = () => {};
  let captured = '';
  let launchedCwd = '';
  sm._newSession = async (_t, cwd, inner) => { launchedCwd = cwd; captured = inner; };
  await sm.dispatch({
    cwd: repo, intent: 'fix the bug', agent: 'codex', worktree: true, worktreeAuto: true,
  });
  assert.ok(captured.includes(`'--add-dir' '${path.join(repo, '.git')}'`), captured);
  const worktreeGitDir = execFileSync('git', ['-C', launchedCwd, 'rev-parse', '--path-format=absolute', '--git-dir'], { encoding: 'utf8' }).trim();
  assert.ok(captured.includes(`'--add-dir' '${worktreeGitDir}'`), captured);
  fs.rmSync(root, { recursive: true, force: true });
});

test('dispatch: worktree mode does not add a common-git-dir --add-dir for claude (no OS sandbox to feed)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-dispatch-wt2-'));
  const repo = path.join(root, 'proj');
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, 'f.txt'), 'x');
  const git = (...a) => execFileSync('git', ['-C', repo, ...a], { stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'i');

  const sm = smForDispatch();
  let captured = '';
  sm._newSession = async (_t, _d, inner) => { captured = inner; };
  await sm.dispatch({ cwd: repo, intent: 'fix the bug', worktree: true, worktreeAuto: true }); // default agent: claude
  assert.doesNotMatch(captured, /worktrees/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('dispatch never calls ensureCodexTrust for a claude session', async () => {
  const sm = smForDispatch();
  let called = false;
  sm._ensureCodexTrust = () => { called = true; };
  await sm.dispatch({ cwd: os.tmpdir(), intent: 'x' }); // default agent: claude
  assert.equal(called, false);
});

test('dispatch stores effort:null when none is given', async () => {
  const sm = smForDispatch();
  const { sessionId } = await sm.dispatch({ cwd: os.tmpdir(), intent: 'x' });
  assert.equal(sm.map.get(sessionId).effort, null);
});

test('dispatch creates a nonexistent user-typed cwd (mkdir -p) so tmux does not fall back to $HOME', async () => {
  const sm = smForDispatch();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-cwd-'));
  const target = path.join(base, 'does-not-exist-yet', 'nested');
  assert.equal(fs.existsSync(target), false);
  let launchedDir;
  sm._newSession = async (_tmux, dir) => { launchedDir = dir; };
  const { sessionId } = await sm.dispatch({ cwd: target, intent: 'x' });
  assert.equal(fs.existsSync(target), true); // created before launch
  assert.equal(launchedDir, target); // and the session launches in it, not $HOME
  assert.equal(sm.map.get(sessionId).cwd, target);
  fs.rmSync(base, { recursive: true, force: true });
});

// The pane-death log's two real hazards, end to end through refreshAlive: it must
// not repeat on the 4s rebuild, and a socket that fails to scan must not erase the
// death (the first draft's alive→dead edge lost it permanently, silently).
function smForPanes(panes) {
  const sm = new SessionManager();
  sm.scanSockets = () => [''];
  sm._tmux = async () => {
    const next = panes.shift();
    if (next === 'FAIL') throw new Error('no server running on that socket');
    return { stdout: next };
  };
  return sm;
}

function captureWarn(fn) {
  const lines = [];
  const orig = console.warn;
  console.warn = (msg) => lines.push(msg);
  return fn().then((r) => { console.warn = orig; return { lines, result: r }; },
    (e) => { console.warn = orig; throw e; });
}

test('a pane death is logged once, not on every rebuild', async () => {
  const sm = smForPanes(['cc_a\x1f0\x1f', 'cc_a\x1f1\x1f1', 'cc_a\x1f1\x1f1', 'cc_a\x1f1\x1f1']);
  await sm.refreshAlive();                                    // alive
  const { lines } = await captureWarn(() => sm.refreshAlive()); // dies
  assert.equal(lines.length, 1);
  assert.match(lines[0], /pane died .* \(tmux cc_a\) — exit 1/);
  const { lines: again } = await captureWarn(async () => { await sm.refreshAlive(); await sm.refreshAlive(); });
  assert.deepEqual(again, []);
});

test('a corpse already dead at startup is seeded silently — it predates this process', async () => {
  const sm = smForPanes(['cc_old\x1f1\x1f0', 'cc_old\x1f1\x1f0']);
  const { lines } = await captureWarn(async () => { await sm.refreshAlive(); await sm.refreshAlive(); });
  assert.deepEqual(lines, []);
});

test('a death during a socket blip is still reported on the next successful scan', async () => {
  // The blind poll sees nothing at all; the pane is already a corpse by the time
  // the socket answers again, so there is no alive→dead edge left to detect.
  const sm = smForPanes(['cc_a\x1f0\x1f', 'FAIL', 'cc_a\x1f1\x1f1']);
  await sm.refreshAlive();
  const { lines: duringBlip } = await captureWarn(() => sm.refreshAlive());
  assert.deepEqual(duringBlip, []);
  const { lines } = await captureWarn(() => sm.refreshAlive());
  assert.equal(lines.length, 1);
  assert.match(lines[0], /pane died .* \(tmux cc_a\)/);
});

test('a blip does not forget a corpse already reported, so it is not re-logged', async () => {
  const sm = smForPanes(['cc_a\x1f0\x1f', 'cc_a\x1f1\x1f1', 'FAIL', 'cc_a\x1f1\x1f1']);
  await sm.refreshAlive();
  await captureWarn(() => sm.refreshAlive());          // reported here
  const { lines } = await captureWarn(async () => { await sm.refreshAlive(); await sm.refreshAlive(); });
  assert.deepEqual(lines, []);
});

// Liveness is read while a refresh is in flight (the 4s rebuild, an MCP tool, a
// lifecycle decision), and a half-built snapshot reads as "every pane is dead" —
// so the new sets are published only once tmux has answered for every socket.
test('refreshAlive holds the previous snapshot until the whole scan is published', async () => {
  const sm = new SessionManager();
  sm.scanSockets = () => [''];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  sm._tmux = async () => {
    if (++calls === 2) await gate; // the second scan parks inside tmux
    return { stdout: 'cc_a\x1f0\x1f\ncc_b\x1f1\x1f1' };
  };
  await sm.refreshAlive();
  const inFlight = sm.refreshAlive();
  assert.deepEqual([...sm.alive], ['cc_a']);
  assert.deepEqual([...sm.dead], ['cc_b']);
  assert.equal(sm.deadStatus.get('cc_b'), 1);
  assert.equal(sm.socketOf('cc_a'), '');
  release();
  await inFlight;
  assert.deepEqual([...sm.alive], ['cc_a']);
});

// The log must never assert a teardown that did not happen: killForSession adds
// the RECORDED tmux name to its targets unconditionally, so a dormant card whose
// tmux died in a reboot has a target nothing can kill.
test('killForSession logs only confirmed kills, never a stale recorded name', async () => {
  const sm = new SessionManager();
  sm.map.set('CARD', { tmux: 'cc_gone', socket: '' });
  sm.scanSockets = () => [''];
  sm.refreshAlive = async () => {};
  sm._tmux = async (_socket, a) => {
    if (a[0] === 'kill-session') throw new Error("can't find session: cc_gone");
    if (a[0] === 'has-session') throw new Error("can't find session: cc_gone");
    return { stdout: '' };
  };
  const logs = [];
  const orig = console.log;
  console.log = (msg) => logs.push(msg);
  try {
    await sm.killForSession('CARD', { reason: 'archive' });
  } finally {
    console.log = orig;
  }
  assert.deepEqual(logs, []);
});

test('killForSession logs the kill it did make', async () => {
  const sm = new SessionManager();
  sm.map.set('CARD', { tmux: 'cc_live', socket: '' });
  sm.scanSockets = () => [''];
  sm.refreshAlive = async () => {};
  sm._tmux = async (_socket, a) => {
    if (a[0] === 'has-session') throw new Error('gone now');
    return { stdout: '' };
  };
  const logs = [];
  const orig = console.log;
  console.log = (msg) => logs.push(msg);
  try {
    await sm.killForSession('CARD', { reason: 'archive' });
  } finally {
    console.log = orig;
  }
  assert.equal(logs.length, 1);
  assert.match(logs[0], /killed CARD \(tmux cc_live\) — reason=archive/);
});

// A kill that failed already warns "left … alive"; claiming it was killed in the
// next breath would make the record contradict itself.
test('killForSession says nothing about a target that survived the kill', async () => {
  const sm = new SessionManager();
  sm.map.set('CARD', { tmux: 'cc_stuck', socket: '' });
  sm.scanSockets = () => [''];
  sm.refreshAlive = async () => {};
  sm._tmux = async () => ({ stdout: '' }); // kill "succeeds", has-session still finds it
  const logs = [];
  const orig = console.log;
  console.log = (msg) => logs.push(msg);
  const origWarn = console.warn;
  console.warn = () => {};
  try {
    await sm.killForSession('CARD', { reason: 'archive' });
  } finally {
    console.log = orig;
    console.warn = origWarn;
  }
  assert.deepEqual(logs, []);
});

test('_newSession cd\'s into the dir inside the pane command, not just via tmux -c', async () => {
  // A tmux server with a deleted cwd ignores `-c` and starts panes in the dead dir,
  // which kills a devcontainer launch outright (process.cwd() at CLI module load).
  const sm = new SessionManager();
  let args;
  sm._tmux = async (_socket, a) => { args = args || a; return { stdout: '' }; };
  await sm._newSession('cc_abc', "/tmp/aw dir'x", 'launch --me', '');
  assert.deepEqual(args.slice(0, 6), ['new-session', '-d', '-s', 'cc_abc', '-c', "/tmp/aw dir'x"]);
  assert.equal(args[6], `cd '/tmp/aw dir'\\''x' && launch --me`);
});

test('worktree dispatch does NOT create a nonexistent cwd (fails as a non-repo, no stray dir)', async () => {
  const sm = smForDispatch();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-wt-cwd-'));
  const target = path.join(base, 'does-not-exist-yet');
  assert.equal(fs.existsSync(target), false);
  // Worktree mode requires a real git repo; a nonexistent path must fail (as it
  // did before the mkdir was added) rather than being created and then rejected.
  await assert.rejects(() => sm.dispatch({ cwd: target, intent: 'x', worktree: true, worktreeAuto: true }));
  assert.equal(fs.existsSync(target), false); // no stray empty dir left behind
  fs.rmSync(base, { recursive: true, force: true });
});

test('dispatch: devcontainer runtime wraps launch and records entry.runtime', async () => {
  const sm = smForDispatch();
  let captured;
  sm._newSession = async (_tmux, _dir, inner) => { captured = inner; };
  // The dispatch preflight refuses a repo with no devcontainer config, so give the
  // target one before dispatching (preflight itself is covered in devcontainer.test.js).
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-dc-dispatch-'));
  fs.mkdirSync(path.join(repo, '.devcontainer'));
  fs.writeFileSync(path.join(repo, '.devcontainer', 'devcontainer.json'), '{}');
  const { sessionId } = await sm.dispatch({ cwd: repo, runtime: 'devcontainer', agent: 'claude' });
  assert.match(captured, /devcontainer up --workspace-folder/);
  assert.match(captured, /devcontainer exec --workspace-folder/);
  assert.equal(sm.map.get(sessionId).runtime, 'devcontainer');
});

test('dispatch: local runtime is unchanged (no runtime field, raw claude command)', async () => {
  const sm = smForDispatch();
  let captured;
  sm._newSession = async (_tmux, _dir, inner) => { captured = inner; };
  const { sessionId } = await sm.dispatch({ cwd: os.tmpdir(), agent: 'claude' });
  assert.match(captured, /^env .*claude /);
  // "Raw" = NOT wrapped in the devcontainer bring-up. Match the wrapper tokens
  // (`devcontainer up`/`exec`, as the devcontainer dispatch test asserts) rather
  // than the bare word, which a checkout path containing "devcontainer" (e.g. a
  // worktree dir named for this feature) would otherwise trip on.
  assert.doesNotMatch(captured, /devcontainer (up|exec)/);
  assert.equal(sm.map.get(sessionId).runtime, undefined);
});

test('session links: setLinks adopts an unmapped session, getLinks reads it back', () => {
  const sm = freshManager();
  assert.deepEqual(sm.getLinks('CARD1'), []);
  assert.equal(sm.setLinks('CARD1', [{ type: 'jira', key: 'ENT-1' }], { cwd: '/a' }), true);
  assert.deepEqual(sm.getLinks('CARD1'), [{ type: 'jira', key: 'ENT-1' }]);
});

test('session links replace and survive serialization', () => {
  const sm = freshManager();
  sm.setLinks('CARD1', [{ type: 'jira', key: 'ENT-1' }]);
  sm.setLinks('CARD1', [{ type: 'jira', key: 'ENT-2' }]);
  // Serializes the way _save persists it (Object.fromEntries -> JSON).
  const round = JSON.parse(JSON.stringify(Object.fromEntries(sm.map)));
  assert.deepEqual(round['CARD1'].links, [{ type: 'jira', key: 'ENT-2' }]);
});

test('prLinks lists pr links with their session id', () => {
  const mgr = freshManager();
  mgr.setLinks('CARD1', [
    { type: 'pr', url: 'https://github.com/a/b/pull/7', repo: 'a/b', number: 7 },
  ]);
  assert.deepEqual(mgr.prLinks(), [{ ownerId: 'CARD1', url: 'https://github.com/a/b/pull/7', number: 7, checkStatus: undefined, headSha: undefined, dirty: undefined, unresolvedCount: undefined }]);
});

test('updateLinkStatus writes checkStatus/headSha/dirty onto the matching session pr link', () => {
  const mgr = freshManager();
  mgr.setLinks('CARD1', [{ type: 'pr', url: 'https://github.com/a/b/pull/7', repo: 'a/b', number: 7 }]);
  assert.equal(mgr.updateLinkStatus('CARD1', 'https://github.com/a/b/pull/7', 'failing', true, '2026-06-16T00:00:00Z', undefined, '293558cba987'), true);
  assert.equal(mgr.getLinks('CARD1')[0].checkStatus, 'failing');
  assert.equal(mgr.getLinks('CARD1')[0].headSha, '293558cba987');
  assert.equal(mgr.getLinks('CARD1')[0].dirty, true);
  assert.equal(mgr.updateLinkStatus('CARD1', 'https://github.com/a/b/pull/7', 'failing', true, '2026-06-16T01:00:00Z'), false);
  assert.equal(mgr.getLinks('CARD1')[0].headSha, '293558cba987');
  assert.equal(mgr.updateLinkStatus('CARD1', 'https://github.com/a/b/pull/999', 'passing', false, 'x'), false);
});

test('updateLinkStatus returns false when checkStatus AND dirty are unchanged (timestamp still bumped)', () => {
  const mgr = freshManager();
  mgr.setLinks('CARD1', [{ type: 'pr', url: 'https://github.com/a/b/pull/7', repo: 'a/b', number: 7 }]);
  assert.equal(mgr.updateLinkStatus('CARD1', 'https://github.com/a/b/pull/7', 'failing', false, '2026-06-16T00:00:00Z'), true);
  assert.equal(mgr.updateLinkStatus('CARD1', 'https://github.com/a/b/pull/7', 'failing', false, '2026-06-16T02:00:00Z'), false);
  assert.equal(mgr.getLinks('CARD1')[0].checkStatusFetchedAt, '2026-06-16T02:00:00Z');
});

test('updateLinkStatus returns true when only dirty changes (checkStatus stable)', () => {
  const mgr = freshManager();
  mgr.setLinks('CARD1', [{ type: 'pr', url: 'https://github.com/a/b/pull/7', repo: 'a/b', number: 7 }]);
  assert.equal(mgr.updateLinkStatus('CARD1', 'https://github.com/a/b/pull/7', 'pending', false, 'x'), true);
  assert.equal(mgr.updateLinkStatus('CARD1', 'https://github.com/a/b/pull/7', 'pending', true, 'y'), true);
});

test('updateLinkStatus writes unresolvedCount but excludes it from the changed check (renders nowhere, so it must not force a graph rebuild)', () => {
  const mgr = freshManager();
  mgr.setLinks('CARD1', [{ type: 'pr', url: 'https://github.com/a/b/pull/7', repo: 'a/b', number: 7 }]);
  assert.equal(mgr.updateLinkStatus('CARD1', 'https://github.com/a/b/pull/7', 'pending', false, 'x', 2), true);
  assert.equal(mgr.getLinks('CARD1')[0].unresolvedCount, 2);
  // same checkStatus/dirty, unresolvedCount alone changes -> still written, but NOT reported changed
  assert.equal(mgr.updateLinkStatus('CARD1', 'https://github.com/a/b/pull/7', 'pending', false, 'y', 5), false);
  assert.equal(mgr.getLinks('CARD1')[0].unresolvedCount, 5);
  // a genuine checkStatus change alongside a stable unresolvedCount still reports changed
  assert.equal(mgr.updateLinkStatus('CARD1', 'https://github.com/a/b/pull/7', 'failing', false, 'z', 5), true);
});


const cand = (over = {}) => ({
  sessionId: 's', managed: true, attached: false, status: 'idle',
  suspendPending: false, lastActivity: 0, ...over,
});

test('SUSPEND_MIN_SNOOZE_MS is one hour', () => {
  assert.equal(SUSPEND_MIN_SNOOZE_MS, 60 * 60 * 1000);
});

test('suspendIdleMs: absent config defaults to 8h (on by default)', () => {
  assert.equal(suspendIdleMs({}), 8 * 60 * 60 * 1000);
  assert.equal(suspendIdleMs(), 8 * 60 * 60 * 1000);
});

test('suspendIdleMs: explicit 0 disables the timer (null)', () => {
  assert.equal(suspendIdleMs({ suspendIdleHours: 0 }), null);
});

test('suspendIdleMs: a positive number is hours in ms', () => {
  assert.equal(suspendIdleMs({ suspendIdleHours: 2 }), 2 * 60 * 60 * 1000);
});

test('suspendIdleMs: a fractional hour is honoured (documents the contract)', () => {
  assert.equal(suspendIdleMs({ suspendIdleHours: 0.5 }), 30 * 60 * 1000);
});

test('suspendIdleMs: a negative number is treated as absent (defaults to 8h)', () => {
  assert.equal(suspendIdleMs({ suspendIdleHours: -1 }), 8 * 60 * 60 * 1000);
});

test('suspendEnabled: on by default, only an explicit false disables it', () => {
  assert.equal(suspendEnabled(), true);
  assert.equal(suspendEnabled({}), true);
  assert.equal(suspendEnabled({ suspendEnabled: true }), true);
  assert.equal(suspendEnabled({ suspendEnabled: false }), false);
});

test('reconcileSuspend bails entirely when suspending is globally disabled', async () => {
  const sm = new SessionManager();
  sm._save = () => {};
  let killed = false;
  sm.attachedSessions = async () => new Set();
  sm.killForSession = async () => { killed = true; };
  sm.map.set('s', { tmux: 'cc_s' });
  const sessions = [{ sessionId: 's', tmux: 'cc_s', status: 'idle', lastActivity: 0 }];
  const out = await sm.reconcileSuspend(sessions, { suspendEnabled: false });
  assert.deepEqual(out, []);
  assert.equal(killed, false);
});


test('suspendable: idle past the threshold and unattached qualifies', () => {
  const now = 10 * 60 * 60 * 1000;
  const out = suspendableSessions([cand({ lastActivity: now - 5 * 60 * 60 * 1000 })],
    { idleMs: 4 * 60 * 60 * 1000, now });
  assert.equal(out.length, 1);
});

test('suspendable: idle but under the threshold does not qualify', () => {
  const now = 10 * 60 * 60 * 1000;
  const out = suspendableSessions([cand({ lastActivity: now - 1 * 60 * 60 * 1000 })],
    { idleMs: 4 * 60 * 60 * 1000, now });
  assert.deepEqual(out, []);
});

test('suspendable: never suspends working or needs-you on the timer', () => {
  const now = 99 * 60 * 60 * 1000;
  for (const status of ['working', 'needs-you', 'unknown']) {
    assert.deepEqual(
      suspendableSessions([cand({ status, lastActivity: 0 })], { idleMs: 1, now }), [],
      `${status} must not auto-suspend`);
  }
});

test('suspendable: an attached terminal is never suspended', () => {
  const now = 99 * 60 * 60 * 1000;
  assert.deepEqual(
    suspendableSessions([cand({ attached: true, lastActivity: 0 })], { idleMs: 1, now }), []);
});

// A RELAUNCH is activity. lastActivity is transcript/rollout-sourced, so a session
// resumed but not yet prompted still reports the age of the conversation it reopened
// — 17h in the live case this fixes, against a pane 46s old — and a booting pane
// classifies idle, so the 60s sweep tore down every fresh resume. Agent-agnostic: a
// manually resumed Claude card was observed killed 13s after its relaunch.
test('suspendable: a freshly relaunched session is not suspended on the timer', () => {
  const now = 20 * 60 * 60 * 1000;
  const out = suspendableSessions(
    [cand({ lastActivity: now - 17 * 60 * 60 * 1000, relaunchedAt: now - 46 * 1000 })],
    { idleMs: 60 * 60 * 1000, now });
  assert.deepEqual(out, []);
});

test('suspendable: a relaunched session qualifies again once the relaunch itself is stale', () => {
  const now = 20 * 60 * 60 * 1000;
  const out = suspendableSessions(
    [cand({ lastActivity: now - 17 * 60 * 60 * 1000, relaunchedAt: now - 2 * 60 * 60 * 1000 })],
    { idleMs: 60 * 60 * 1000, now });
  assert.equal(out.length, 1);
});

// A fork's transcript REPLAYS its parent's history (same timestamps), so a
// seconds-old fork inherits an ancient lastActivity. createdAt covers it — and
// dispatch — without either constructor needing its own stamp.
test('suspendable: a freshly created card is not suspended on an inherited lastActivity', () => {
  const now = 20 * 60 * 60 * 1000;
  const out = suspendableSessions(
    [cand({ lastActivity: now - 17 * 60 * 60 * 1000, createdAt: now - 5 * 1000 })],
    { idleMs: 60 * 60 * 1000, now });
  assert.deepEqual(out, []);
});

// An explicit suspend is a human decision and must still fire immediately — the
// floor above is only about the idle TIMER mistaking a relaunch for staleness.
test('suspendPending: fires on a freshly relaunched session regardless of the floor', () => {
  const now = 1000;
  const out = suspendableSessions(
    [cand({ suspendPending: true, relaunchedAt: now, lastActivity: now })],
    { idleMs: null, now });
  assert.equal(out.length, 1);
});

test('resumeEntry stamps relaunchedAt so the idle timer restarts at the relaunch', () => {
  const e = resumeEntry({ intent: 'x', createdAt: 5 }, {
    short: 'a', tmux: 'cc_a', cwd: '/tmp', agent: 'claude', resumeId: 'r', socket: 's', now: 4242,
  });
  assert.equal(e.relaunchedAt, 4242);
  assert.equal(e.createdAt, 5, 'createdAt stays the card birth, not the relaunch');
});

test('suspendable: a dormant (no tmux) candidate is skipped', () => {
  const now = 99 * 60 * 60 * 1000;
  assert.deepEqual(
    suspendableSessions([cand({ managed: false, lastActivity: 0 })], { idleMs: 1, now }), []);
});

test('suspendPending: suspends as soon as idle, regardless of age or disabled timer', () => {
  const now = 1000;
  const out = suspendableSessions([cand({ suspendPending: true, lastActivity: now })],
    { idleMs: null, now });
  assert.equal(out.length, 1);
});

test('suspendPending: still waits for idle (a pending+working session is not suspended)', () => {
  const out = suspendableSessions([cand({ suspendPending: true, status: 'working' })],
    { idleMs: null, now: 0 });
  assert.deepEqual(out, []);
});

test('suspendable: a live background shell blocks the idle timer (avoids the noisy resume)', () => {
  const now = 99 * 60 * 60 * 1000;
  assert.deepEqual(
    suspendableSessions([cand({ hasBackgroundShell: true, lastActivity: 0 })], { idleMs: 1, now }), []);
});

test('suspendable: a live background shell blocks even an explicit suspendPending', () => {
  const now = 1000;
  const out = suspendableSessions(
    [cand({ hasBackgroundShell: true, suspendPending: true, lastActivity: now })],
    { idleMs: null, now });
  assert.deepEqual(out, []);
});

test('suspendable: once the background shell clears, the same candidate qualifies again', () => {
  const now = 99 * 60 * 60 * 1000;
  const out = suspendableSessions(
    [cand({ hasBackgroundShell: false, lastActivity: now - 5 * 60 * 60 * 1000 })],
    { idleMs: 4 * 60 * 60 * 1000, now });
  assert.equal(out.length, 1);
});

// Characterization guard: the login screen classifies as needs-you (tmux-scraper.js
// classify), and the existing status!=='idle' filter already excludes it here — this
// locks that guarantee so the two can never drift apart (a login-waiting session must
// never be auto-suspended out from under the user).
test('suspendableSessions never includes a needs-you (login-waiting) session', () => {
  const cands = [cand({ status: 'needs-you', hasBackgroundShell: false })];
  assert.equal(suspendableSessions(cands, { idleMs: 1, now: 0 }).length, 0);
});

// A SessionManager with one mapped entry and a stubbed killForSession, so we can
// assert entry mutations without touching tmux.
function smWithEntry(entry) {
  const sm = new SessionManager();
  sm.map.clear(); // constructor _load()s the real mappings file; isolate the test
  sm.map.set('sid', { short: 'a', tmux: 'cc_a', cwd: '/x', createdAt: 1, ...entry });
  sm.killForSession = async () => ['cc_a'];   // stub: no real tmux
  sm._save = () => {};                          // stub: no disk write
  return sm;
}

test('suspend: kills the session tmux and stamps suspendedAt, clearing pending', async () => {
  const sm = smWithEntry({ suspendPending: true });
  let killed = null;
  sm.killForSession = async (id) => { killed = id; return []; };
  const ok = await sm.suspend('sid');
  assert.equal(ok, true);
  assert.equal(killed, 'sid');
  const e = sm.entryFor('sid');
  assert.equal(typeof e.suspendedAt, 'number');
  assert.equal(e.suspendPending, undefined);
});

test('suspend: returns false for an unknown session', async () => {
  const sm = smWithEntry({});
  assert.equal(await sm.suspend('nope'), false);
});

test('suspend preserves entry.workflow so the autopilot chip survives an idle suspend', async () => {
  const workflow = { issue: 'ENT-1', phase: { label: 'implementing', kind: 'active', at: 1 }, startedAt: 1 };
  const sm = smWithEntry({ workflow });
  await sm.suspend('sid');
  assert.deepEqual(sm.entryFor('sid').workflow, workflow);
});

test('markSuspendPending: flags the entry, returns false when unmapped', () => {
  const sm = smWithEntry({});
  assert.equal(sm.markSuspendPending('sid'), true);
  assert.equal(sm.entryFor('sid').suspendPending, true);
  assert.equal(sm.markSuspendPending('nope'), false);
});

test('clearSnooze: also drops a pending suspend', () => {
  const sm = smWithEntry({ snooze: { until: 1, createdAt: 1 }, suspendPending: true });
  assert.equal(sm.clearSnooze('sid'), true);
  const e = sm.entryFor('sid');
  assert.equal(e.snooze, undefined);
  assert.equal(e.suspendPending, undefined);
});

// A SessionManager wired so reconcileSuspend can run without real tmux: stubbed
// attachedSessions + killForSession, recording which ids get suspended.
function smForReconcile(entries, attachedNames = []) {
  const sm = new SessionManager();
  sm.map.clear();
  for (const e of entries) sm.map.set(e.sessionId, { short: 'a', tmux: e.tmux ?? `cc_${e.sessionId}`, cwd: '/x', createdAt: 1, ...e });
  sm._save = () => {};
  sm.attachedSessions = async () => new Set(attachedNames);
  sm.suspended = [];
  sm.killForSession = async (id) => { sm.suspended.push(id); return []; };
  return sm;
}

test('reconcileSuspend: suspends an idle-past-threshold session and returns its id', async () => {
  const now = 100 * 60 * 60 * 1000;
  const sm = smForReconcile([{ sessionId: 's1' }]);
  const sessions = [{ sessionId: 's1', tmux: 'cc_s1', status: 'idle', lastActivity: now - 5 * 60 * 60 * 1000 }];
  const ids = await sm.reconcileSuspend(sessions, { suspendIdleHours: 4 });
  assert.deepEqual(ids, ['s1']);
  assert.deepEqual(sm.suspended, ['s1']);
});

test('reconcileSuspend: skips an attached session and a working one', async () => {
  const sm = smForReconcile([{ sessionId: 'att' }, { sessionId: 'busy' }], ['cc_att']);
  const sessions = [
    { sessionId: 'att', tmux: 'cc_att', status: 'idle', lastActivity: 0 },
    { sessionId: 'busy', tmux: 'cc_busy', status: 'working', lastActivity: 0 },
  ];
  const ids = await sm.reconcileSuspend(sessions, { suspendIdleHours: 4 });
  assert.deepEqual(ids, []);
});

test('reconcileSuspend: fires a pending suspend once idle even with the timer disabled', async () => {
  const sm = smForReconcile([{ sessionId: 'p1', suspendPending: true }]);
  const sessions = [{ sessionId: 'p1', tmux: 'cc_p1', status: 'idle', lastActivity: 0 }];
  const ids = await sm.reconcileSuspend(sessions, { suspendIdleHours: 0 });
  assert.deepEqual(ids, ['p1']);
});

test('reconcileSuspend: skips a session with a live background shell, pending or on the timer', async () => {
  const now = 100 * 60 * 60 * 1000;
  const sm = smForReconcile([{ sessionId: 'bg' }, { sessionId: 'bg2', suspendPending: true }]);
  const sessions = [
    { sessionId: 'bg', tmux: 'cc_bg', status: 'idle', lastActivity: now - 5 * 60 * 60 * 1000, hasBackgroundShell: true },
    { sessionId: 'bg2', tmux: 'cc_bg2', status: 'idle', lastActivity: now, hasBackgroundShell: true },
  ];
  const ids = await sm.reconcileSuspend(sessions, { suspendIdleHours: 4 });
  assert.deepEqual(ids, []);
});

test('syncNotesToContainer: docker cp -L notes for a live devcontainer session; no-op for local', async () => {
  const calls = [];
  const run = async (c, a) => { calls.push([c, ...a]); return { stdout: 'cid1\n' }; };
  const sm = new SessionManager();
  sm.map.clear();
  sm.map.set('d', { runtime: 'devcontainer', cwd: '/repo' });
  sm.map.set('h', { cwd: '/repo' }); // local (no runtime)
  await sm.syncNotesToContainer('d', { run, addDirs: ['/host/notes'] });
  await sm.syncNotesToContainer('h', { run, addDirs: ['/host/notes'] });
  await sm.syncNotesToContainer('d', { run }); // nothing granted -> nothing to copy
  const cps = calls.filter((c) => c[0] === 'docker' && c[1] === 'cp');
  assert.equal(cps.length, 1);                       // only the devcontainer entry copies
  assert.ok(cps[0].join(' ').includes('/host/notes cid1:/tmp/aw-d/launch-dirs/0')); // into the same place launch put it
});

// The git-dir grant keys off the LAUNCH CWD, not off a wrangler-made worktree
// entry: a Codex worker handed a pre-existing linked worktree as plain `cwd`
// (no `worktree` field on its entry) has exactly the same sandbox problem, and
// so does a plain checkout — Codex keeps `<root>/.git` read-only inside every
// writable root, so `git commit` there fails on index.lock too (verified
// against codex-cli 0.156.1) unless the git-dir is granted as its own root.
test('dispatch: a codex cwd that is a pre-existing linked worktree (no worktree mode) gets the common git-dir via --add-dir', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-dispatch-cwd-wt-'));
  const { worktreePath, gitDir } = realWorktreeRepo(root);
  const sm = smForDispatch();
  sm._ensureCodexTrust = () => {};
  let captured = '';
  sm._newSession = async (_t, _d, inner) => { captured = inner; };
  const r = await sm.dispatch({ cwd: worktreePath, intent: 'fix the bug', agent: 'codex' });
  assert.ok(captured.includes(`'--add-dir' '${gitDir}'`), captured);
  assert.equal(sm.map.get(r.sessionId).worktree, undefined);
  assert.equal(sm.map.get(r.sessionId).addDirs, undefined);
  fs.rmSync(root, { recursive: true, force: true });
});

test('dispatch: a codex cwd that is a plain checkout gets its own .git via --add-dir', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-dispatch-cwd-repo-'));
  const { repo, gitDir } = realWorktreeRepo(root);
  const sm = smForDispatch();
  sm._ensureCodexTrust = () => {};
  let captured = '';
  sm._newSession = async (_t, _d, inner) => { captured = inner; };
  await sm.dispatch({ cwd: repo, intent: 'fix the bug', agent: 'codex' });
  assert.ok(captured.includes(`'--add-dir' '${gitDir}'`), captured);
  fs.rmSync(root, { recursive: true, force: true });
});

test('dispatch: a git-dir already in the requested addDirs is granted once', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-dispatch-cwd-dup-'));
  const { worktreePath, gitDir } = realWorktreeRepo(root);
  const sm = smForDispatch();
  sm._ensureCodexTrust = () => {};
  let captured = '';
  sm._newSession = async (_t, _d, inner) => { captured = inner; };
  await sm.dispatch({ cwd: worktreePath, intent: 'fix the bug', agent: 'codex', addDirs: [gitDir] });
  assert.equal(captured.split(`'--add-dir' '${gitDir}'`).length - 1, 1, captured);
  fs.rmSync(root, { recursive: true, force: true });
});

test('dispatch: a claude cwd that is a plain checkout gets no .git --add-dir (no OS sandbox to feed)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-dispatch-cwd-claude-'));
  const { repo, gitDir } = realWorktreeRepo(root);
  const sm = smForDispatch();
  let captured = '';
  sm._newSession = async (_t, _d, inner) => { captured = inner; };
  await sm.dispatch({ cwd: repo, intent: 'fix the bug', agent: 'claude' });
  assert.ok(!captured.includes(gitDir), captured);
  fs.rmSync(root, { recursive: true, force: true });
});

test('resume() grants the common git-dir from the entry cwd even without a worktree field', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-resume-cwd-wt-'));
  const { worktreePath, gitDir } = realWorktreeRepo(root);
  const sm = new SessionManager();
  sm.map.clear();
  sm.map.set('card-cwd-wt', { agent: 'codex', cwd: worktreePath, liveSessionId: 'live-cwd-wt' });
  sm._save = () => {};
  sm.refreshAlive = async () => {};
  sm.killForSession = async () => [];
  sm._ensureCodexTrust = () => {};
  let captured = '';
  sm._newSession = async (_t, _d, inner) => { captured = inner; };
  await sm.resume('card-cwd-wt', worktreePath);
  assert.ok(captured.includes(`'--add-dir' '${gitDir}'`), captured);
  fs.rmSync(root, { recursive: true, force: true });
});

test('fork() grants the common git-dir from the fork cwd even without a parent worktree field', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-fork-cwd-wt-'));
  const { worktreePath, gitDir } = realWorktreeRepo(root);
  const sm = new SessionManager();
  sm._save = () => {};
  sm.refreshAlive = async () => {};
  sm._ensureCodexTrust = () => {};
  let captured = '';
  sm._newSession = async (_t, _d, inner) => { captured = inner; };
  await sm.fork({
    sourceId: 'SRC', parentId: 'PARENT',
    parentEntry: { agent: 'codex', cwd: worktreePath },
    cwd: worktreePath,
  });
  assert.ok(captured.includes(`'--add-dir' '${gitDir}'`), captured);
  fs.rmSync(root, { recursive: true, force: true });
});

// ── the session.launchContext seam ───────────────────────────────────────────
// Asked by dispatch/resume/fork BEFORE the command is built, with the reason,
// the agent/runtime and the task; its answer is what lands in the command.

function recordingContext(sm) {
  const asked = [];
  sm._launchContext = async (ctx) => { asked.push(ctx); return { env: { AW_X: 'from-ctx' }, addDirs: ['/granted'] }; };
  return asked;
}

test('dispatch asks the launch context with the card id, the task, agent, runtime and the dispatch reason', async () => {
  const sm = smForDispatch();
  const asked = recordingContext(sm);
  let inner = '';
  sm._newSession = async (_t, _d, i) => { inner = i; };
  const { sessionId } = await sm.dispatch({ cwd: os.tmpdir(), intent: 'x', taskId: 'T7' });
  assert.deepEqual(asked, [{ sid: sessionId, task: { id: 'T7' }, agent: 'claude', runtime: 'local', reason: 'dispatch' }]);
  assert.ok(inner.includes("AW_X='from-ctx'") && inner.includes("'--add-dir' '/granted'"));
});

test('dispatch without a task asks with task:null, and a spawn passes its own reason', async () => {
  const sm = smForDispatch();
  const asked = recordingContext(sm);
  await sm.dispatch({ cwd: os.tmpdir(), intent: 'x', launchReason: 'spawn' });
  assert.equal(asked[0].task, null);
  assert.equal(asked[0].reason, 'spawn');
});

test('the launch context is awaited before the launch command is built', async () => {
  const sm = smForDispatch();
  const order = [];
  sm._launchContext = async () => { await new Promise((r) => setTimeout(r, 10)); order.push('context'); return { env: {}, addDirs: [] }; };
  sm._newSession = async () => { order.push('launch'); };
  await sm.dispatch({ cwd: os.tmpdir(), intent: 'x' });
  assert.deepEqual(order, ['context', 'launch']);
});

test('resume asks with the session\'s current task and the resume reason (message / snooze-wake pass through)', async () => {
  for (const [reason, want] of [['message', 'message'], ['snooze-wake', 'snooze-wake'], ['schedule', 'resume'], [undefined, 'resume']]) {
    const sm = resumableCodex('card-ctx');
    sm.killForSession = async () => [];
    sm._taskFor = (sid) => (sid === 'card-ctx' ? { id: 'T3', name: 'n' } : null);
    const asked = recordingContext(sm);
    let inner = '';
    sm._newSession = async (_t, _d, i) => { inner = i; };
    await sm.resume('card-ctx', os.tmpdir(), reason ? { reason } : {});
    assert.deepEqual(asked, [{ sid: 'card-ctx', task: { id: 'T3', name: 'n' }, agent: 'codex', runtime: 'local', reason: want }]);
    assert.ok(inner.includes("AW_X='from-ctx'") && inner.includes("'--add-dir' '/granted'"));
  }
});

test('fork asks for the FORK\'s new card id but the PARENT\'s task, with reason fork', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-ctx-fork-'));
  const sm = smForDispatch();
  sm._resolveLiveId = async () => 'live';
  sm._taskFor = (sid) => (sid === 'parent' ? { id: 'TP', name: 'p' } : null);
  const asked = recordingContext(sm);
  const { sessionId } = await sm.fork({ sourceId: 'L0', parentId: 'parent', parentEntry: { agent: 'claude' }, cwd: dir });
  assert.equal(asked.length, 1);
  assert.deepEqual(asked[0], { sid: sessionId, task: { id: 'TP', name: 'p' }, agent: 'claude', runtime: 'local', reason: 'fork' });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('launchContext(): a non-launch ask (assign / adopt) resolves agent, runtime and task from the mapping', async () => {
  const sm = smForDispatch();
  sm.map.set('S1', { agent: 'codex', runtime: 'devcontainer', cwd: '/r' });
  sm._taskFor = () => ({ id: 'T1', name: 'n' });
  const asked = recordingContext(sm);
  const out = await sm.launchContext('S1', 'assign');
  assert.deepEqual(asked, [{ sid: 'S1', task: { id: 'T1', name: 'n' }, agent: 'codex', runtime: 'devcontainer', reason: 'assign' }]);
  assert.deepEqual(out.addDirs, ['/granted']);
  await sm.launchContext('S1', 'adopt', { task: null });
  assert.equal(asked[1].task, null, 'an explicit task:null overrides the lookup');
});

// ── Extension-contributed runtimes ──
// Registered RAW here (server/index.js binds them to a façade and narrows `ext`
// in production), so each test sees exactly what dispatch/resume hand a runtime.
async function withRuntime(rt, extId, fn) {
  registerRuntime(rt, extId);
  try { return await fn(); } finally { unregisterRuntimesFor(extId); }
}
const CLOUDISH = { id: 'cloudt', label: '☁ Cloud', resumable: false };

test('dispatch: a wrapLaunch extension runtime decorates the adapter\'s command', async () => {
  const sm = smForDispatch();
  let captured = '';
  sm._newSession = async (_t, _d, inner) => { captured = inner; };
  await withRuntime({ id: 'toyrt', label: 'Toy', wrapLaunch: async ({ inner }) => `echo hi && ${inner}` }, 'toy', async () => {
    const { sessionId } = await sm.dispatch({ cwd: os.tmpdir(), intent: 'x', runtime: 'toyrt' });
    assert.match(captured, /^echo hi && .*claude '--session-id'/);
    const entry = sm.map.get(sessionId);
    assert.equal(entry.runtime, 'toyrt');
    assert.equal(entry.runtimeExt, 'toy');
    assert.equal(entry.mailCapable, true);
    assert.ok(entry.liveSessionId, 'a wrapped Claude still presets its conversation id');
  });
});

test('dispatch: a wrapLaunch runtime with deliver stores the card as not mail-capable', async () => {
  const sm = smForDispatch();
  await withRuntime({ id: 'toyrt', label: 'Toy', wrapLaunch: async ({ inner }) => inner, deliver: async () => ({ ok: true }) }, 'toy', async () => {
    const { sessionId } = await sm.dispatch({ cwd: os.tmpdir(), intent: 'x', runtime: 'toyrt' });
    assert.equal(sm.map.get(sessionId).mailCapable, false);
  });
});

test('dispatch: a buildLaunch runtime REPLACES the command, gets ext and the card id, and stores no live id', async () => {
  const sm = smForDispatch();
  let captured = '';
  let seen;
  sm._newSession = async (_t, _d, inner) => { captured = inner; };
  sm._resolveLiveId = async () => { throw new Error('must not discover a live id for a buildLaunch runtime'); };
  const bag = { cloud: { environmentId: 'env_1' } };
  await withRuntime({ ...CLOUDISH, buildLaunch: async (args) => { seen = args; return 'echo handed-off'; } }, 'cloud', async () => {
    const { sessionId } = await sm.dispatch({ cwd: os.tmpdir(), intent: 'do it', model: 'opus', runtime: 'cloudt', ext: bag });
    assert.equal(captured, 'echo handed-off');
    assert.deepEqual(seen, { phase: 'dispatch', intent: 'do it', cwd: os.tmpdir(), sessionId, model: 'opus', ext: bag });
    const entry = sm.map.get(sessionId);
    assert.equal(entry.liveSessionId, undefined);
    assert.equal(entry.runtime, 'cloudt');
    assert.equal(entry.runtimeExt, 'cloud');
    assert.equal(entry.mailCapable, false);
  });
});

test('dispatch: preflight gets the widened bag, and a refusal throws before any dir or worktree is touched', async () => {
  const sm = smForDispatch();
  let launched = false;
  let seen;
  sm._newSession = async () => { launched = true; };
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-rt-preflight-'));
  const target = path.join(base, 'not-yet');
  await withRuntime({ id: 'toyrt', label: 'Toy', wrapLaunch: async ({ inner }) => inner, preflight: async (args) => { seen = args; return 'Toy refuses worktrees'; } }, 'toy', async () => {
    await assert.rejects(
      () => sm.dispatch({ cwd: target, intent: 'x', runtime: 'toyrt', agent: 'claude', worktree: true, workflow: { issue: 1 }, ext: { toy: { a: 1 } } }),
      /Toy refuses worktrees/,
    );
  });
  assert.deepEqual(seen, { cwd: target, agent: 'claude', workflow: true, worktree: true, ext: { toy: { a: 1 } } });
  assert.equal(launched, false);
  assert.equal(fs.existsSync(target), false, 'no directory was created for a refused dispatch');
  assert.equal(sm.map.size, 0);
  fs.rmSync(base, { recursive: true, force: true });
});

test('resume and fork of a resumable:false card refuse with the runtime\'s label and leave its pane alone', async () => {
  const sm = smForDispatch();
  let killed = false;
  let launched = false;
  sm.killForSession = async () => { killed = true; return []; };
  sm._newSession = async () => { launched = true; };
  const entry = { agent: 'claude', runtime: 'cloudt', runtimeExt: 'cloud', tmux: 'cc_held', cwd: os.tmpdir() };
  sm.map.set('c1', entry);
  await withRuntime({ ...CLOUDISH, buildLaunch: async () => 'x' }, 'cloud', async () => {
    await assert.rejects(() => sm.resume('c1', os.tmpdir()), { message: '"☁ Cloud" sessions can\'t be resumed or forked' });
    await assert.rejects(() => sm.fork({ sourceId: 'c1', parentId: 'c1', parentEntry: entry, cwd: os.tmpdir() }), /can't be resumed or forked/);
  });
  assert.equal(killed, false, 'a refused resume must not kill the held pane');
  assert.equal(launched, false);
  assert.equal(sm.map.size, 1, 'a refused fork registers no card');
});

test('resume of a card whose extension is gone names the extension to re-enable', async () => {
  const sm = smForDispatch();
  let killed = false;
  sm.killForSession = async () => { killed = true; return []; };
  sm.map.set('c1', { agent: 'claude', runtime: 'cloudt', runtimeExt: 'cloud', tmux: 'cc_held', cwd: os.tmpdir() });
  await assert.rejects(() => sm.resume('c1', os.tmpdir()), /needs the "cloud" extension\. Enable it in Settings → Extensions\./);
  assert.equal(killed, false);
});

test('noteLiveSessionId no-ops for a resumable:false runtime, and keeps the guard (not a throw) for a missing one', async () => {
  await withRuntime({ ...CLOUDISH, buildLaunch: async () => 'x' }, 'cloud', async () => {
    const { sm, saves } = swapManager({ runtime: 'cloudt', liveSessionId: undefined });
    assert.equal(await sm.noteLiveSessionId('card', 'LOCAL-CLIENT', foundTranscript), false);
    assert.equal(sm.map.get('card').liveSessionId, undefined, 'the local client\'s own id is never adopted');
    assert.equal(saves(), 0);
  });
  const { sm } = swapManager({ runtime: 'cloudt' });
  assert.equal(await sm.noteLiveSessionId('card', 'L2', { transcriptFor: async () => null }), false, 'guarded: no transcript yet');
  assert.equal(await sm.noteLiveSessionId('card', 'L2', foundTranscript), true);
});

for (const agent of ['claude', 'codex']) {
  test(`fork inherits additional folders for ${agent} and persists them for resume`, async () => {
    const sm = freshManager();
    sm.refreshAlive = async () => {};
    sm._ensureCodexTrust = () => {};
    let command;
    sm._newSession = async (_t, _d, cmd) => { command = cmd; };
    const parentEntry = { agent, addDirs: ['/repo one', '/repo two'] };
    const result = await sm.fork({ sourceId: 'SRC', parentId: 'PARENT', parentEntry, cwd: os.tmpdir() });
    assert.ok(command.includes("'--add-dir' '/repo one'"));
    assert.ok(command.includes("'--add-dir' '/repo two'"));
    assert.deepEqual(sm.entryFor(result.sessionId).addDirs, ['/repo one', '/repo two']);
  });
}

test('dispatch validates additional folders before creating the working directory', async () => {
  const sm = freshManager();
  sm._newSession = async () => {};
  sm.refreshAlive = async () => {};
  const cwd = path.join(os.tmpdir(), `aw-no-create-${Date.now()}`);
  for (const addDirs of [['relative'], ['/nonexistent-aw-extra-folder'], [42], '/tmp']) {
    await assert.rejects(sm.dispatch({ cwd, addDirs }), /Additional folder/);
    assert.equal(fs.existsSync(cwd), false);
  }
});

test('dispatch normalizes and deduplicates folder grants', async () => {
  const sm = freshManager();
  sm.refreshAlive = async () => {};
  sm._newSession = async () => {};
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-grants-'));
  try {
    const result = await sm.dispatch({ cwd: os.tmpdir(), addDirs: [` ${dir}/ `, dir] });
    assert.deepEqual(sm.entryFor(result.sessionId).addDirs, [dir]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('dispatch refuses host folder grants in devcontainers', async () => {
  const sm = freshManager();
  await assert.rejects(sm.dispatch({ cwd: os.tmpdir(), runtime: 'devcontainer', addDirs: [os.tmpdir()] }), /Additional folders.*local/);
});

for (const mode of ['buildLaunch', 'wrapLaunch']) {
  test(`dispatch refuses additional folder grants for an extension ${mode} runtime before launch`, async () => {
    const sm = smForDispatch();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-runtime-grants-'));
    const cwd = path.join(root, 'new');
    const runtime = mode === 'buildLaunch'
      ? { id: 'grant-test', label: 'Test', resumable: false, buildLaunch: async () => 'echo test' }
      : { id: 'grant-test', label: 'Test', wrapLaunch: async ({ inner }) => inner };
    try {
      await withRuntime(runtime, 'grant-test', async () => {
        await assert.rejects(sm.dispatch({ cwd, runtime: 'grant-test', addDirs: [os.tmpdir()] }), /Additional folders.*local/);
        assert.equal(fs.existsSync(cwd), false);
      });
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
}
