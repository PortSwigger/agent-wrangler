import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  archivableExits, forkEntry, buildInnerCommand, SESSIONS_DIR, resolveWorktree, SessionManager, resumePlan,
  resumeEntry, resumeLaunchPlan, RESUME_NO_TRANSCRIPT_MSG, SUSPEND_MIN_SNOOZE_MS, suspendIdleMs, suspendEnabled, suspendableSessions,
  shouldReloadWorkflowSkill,
} from './session-manager.js';
import { readBranch } from './state-reader.js';
import { linkPathFor, addDirFor } from './memory-store.js';
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
test('scratch SESSIONS_DIR lives under ~/.agent-wrangler, outside the checkout', () => {
  assert.equal(SESSIONS_DIR, path.join(os.homedir(), '.agent-wrangler', 'sessions'));
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

test('ignores a foreign (non-cc_) tmux even on a clean exit', () => {
  assert.deepEqual(archivableExits([{ ...clean, tmux: 'work' }]), []);
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
    createdAt: 123, forkedFrom: 'parent-O', liveSessionId: undefined, runtime: undefined,
    mailCapable: true,
  });
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
    workflow: { issue: 'ENT-1', phase: { label: 'verifying', kind: 'warning', at: 9 }, startedAt: 2 },
    parentSession: 'ORCH1',
    links: [{ type: 'pr', url: 'https://github.com/o/r/pull/1', number: 1 }],
    autoFixPrChecks: false,
    autoMergeOnPass: true,
    childFullView: true,
    nameInherited: true,
    priorLiveSessionIds: ['CLEARED1'],
  };
  const e = resumeEntry(prev, { short: 's', tmux: 'cc_s', cwd: '/w', agent: 'claude', resumeId: 'L', socket: 'sock', now: 999 });
  // A conversation the agent cleared away still holds spend the card is billed for —
  // and once its transcript is deleted, the usage cache keyed on it IS the record.
  assert.deepEqual(e.priorLiveSessionIds, ['CLEARED1']);
  assert.deepEqual(e.workflow, prev.workflow); // the autopilot chip survives resume (8h-suspend recovery)
  assert.deepEqual(e.worktree, prev.worktree);
  assert.equal(e.forkedFrom, 'P');
  assert.equal(e.spawnedBy, 'SPAWNER1');
  assert.equal(e.parentSession, 'ORCH1'); // the nesting link is a stable card id — survives resume too
  assert.deepEqual(e.links, prev.links); // a PR/Jira link attached before an idle-suspend must survive resume
  assert.equal(e.autoFixPrChecks, false); // an explicit opt-out must not silently revert to the on-default
  assert.equal(e.autoMergeOnPass, true); // ditto for an explicit opt-in surviving a workflow run's idle-suspend
  assert.equal(e.childFullView, true); // ditto for a child's full-view override
  assert.equal(e.nameInherited, true); // the [FORK] marker must survive on a still-unnamed fork
  assert.equal(e.liveSessionId, 'L');
  assert.equal(e.intent, 'fix');
  assert.equal(e.createdAt, 100);
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

test('buildInnerCommand injects identity + scoped memory access, intent trailing', () => {
  const sessionId = 'sid-123';
  const cmd = buildInnerCommand({
    args: ['--session-id', sessionId, '--permission-mode', 'auto'],
    intent: 'fix the bug',
    sessionId,
    taskMemory: true, // pin so the nudge assertion doesn't depend on the live config.json
  });
  assert.match(cmd, /AW_SESSION_ID='sid-123'/);
  // AW_TASK_MEMORY is memory.md inside the per-session symlink; --add-dir is that
  // same per-session dir (scoped — not the whole memory tree).
  assert.ok(cmd.includes(`AW_TASK_MEMORY='${linkPathFor(sessionId)}'`));
  assert.ok(cmd.includes(`'--add-dir' '${addDirFor(sessionId)}'`));
  // memory/links are wrangler-meta skills now, loaded via --plugin-dir; the
  // appended system prompt on a plain, non-worktree launch carries only the
  // task-memory mandatory-skill nudge, not the worktree guardrail.
  assert.match(cmd, /--append-system-prompt/);
  assert.doesNotMatch(cmd, /already running inside a dedicated git worktree/);
  assert.match(cmd, /'--plugin-dir' '[^']*\/agent-skills'/);
  // Env assignments lead, the binary is `claude`, and the intent trails last.
  assert.match(cmd, /^AW_SESSION_ID=.* AW_TASK_MEMORY=.* claude /);
  assert.ok(cmd.trimEnd().endsWith(`'fix the bug'`));
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
  await sm.fork({ sourceId: 'L0', parentId: 'p', parentEntry: { agent: 'claude', runtime: 'devcontainer' }, cwd: dir, bindMemory() {} });
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

test('fork() threads trustCodexLaunchCwd into buildFork for a codex parent', async () => {
  const sm = new SessionManager();
  let captured = '';
  sm._newSession = async (_t, _d, inner) => { captured = inner; };
  sm._save = () => {};
  sm.refreshAlive = async () => {};
  await sm.fork({
    sourceId: 'SRC', parentId: 'PARENT',
    parentEntry: { agent: 'codex', cwd: os.tmpdir() },
    cwd: os.tmpdir(),
  });
  // Default config.json has no trustCodexLaunchCwd override — reads the on
  // default, so the fork's cwd is threaded through as trusted.
  assert.match(captured, /trust_level="trusted"/);
});

test('resume() refuses (does not launch) when a Claude transcript is nowhere on disk', async () => {
  const sm = new SessionManager();
  sm.map.clear();
  let launched = false;
  sm.killForSession = async () => [];
  sm._newSession = async () => { launched = true; };
  sm._save = () => {};
  sm.refreshAlive = async () => {};
  // A modern Claude entry whose live id has no transcript anywhere under ~/.claude.
  const cardId = 'card-no-transcript';
  sm.map.set(cardId, { agent: 'claude', cwd: os.tmpdir(), liveSessionId: '00000000-dead-beef-0000-000000000000' });
  await assert.rejects(() => sm.resume(cardId, os.tmpdir()), (e) => e.message === RESUME_NO_TRANSCRIPT_MSG);
  assert.equal(launched, false); // never spawned a blank session in place of the lost one
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

test('resume() threads trustCodexLaunchCwd into buildResume', async () => {
  const sm = resumableCodex('card-trust');
  sm.killForSession = async () => [];
  let captured = '';
  sm._newSession = async (_t, _d, inner) => { captured = inner; };
  await sm.resume('card-trust', os.tmpdir());
  // Default config.json has no trustCodexLaunchCwd override — reads the on
  // default, so the resume dir is threaded through as trusted.
  assert.match(captured, /trust_level="trusted"/);
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

test('dispatch stamps entry.workflow from the workflow opt', async () => {
  const sm = smForDispatch();
  const wf = { issue: 'ENT-9', phase: { label: 'starting', kind: 'active', at: 1 }, startedAt: 1 };
  const { sessionId } = await sm.dispatch({ cwd: os.tmpdir(), intent: 'x', workflow: wf });
  assert.deepEqual(sm.map.get(sessionId).workflow, wf);
});

test('dispatch merges onto an entry an early setWorkflowPhase adopted, without clobbering it', async () => {
  const sm = smForDispatch();
  // No workflow opt, but a phase is reported pre-map.set via the bindMemory hook
  // (which fires before the entry is written) — it must survive the dispatch write,
  // while the real launch fields win over the adopted stub's placeholders.
  const { sessionId } = await sm.dispatch({
    cwd: os.tmpdir(), intent: 'hello',
    bindMemory: (sid) => sm.setWorkflowPhase(sid, { label: 'planning', kind: 'active' }),
  });
  const e = sm.map.get(sessionId);
  assert.equal(e.workflow.phase.label, 'planning'); // adopted phase preserved
  assert.equal(e.intent, 'hello');
  assert.ok(e.tmux.startsWith('cc_'));
});

test('dispatch: the launch workflow opt wins over an early adopted phase', async () => {
  const sm = smForDispatch();
  const wf = { issue: 'ENT-9', phase: { label: 'starting', kind: 'active', at: 1 }, startedAt: 1 };
  const { sessionId } = await sm.dispatch({
    cwd: os.tmpdir(), intent: 'x', workflow: wf,
    bindMemory: (sid) => sm.setWorkflowPhase(sid, { label: 'planning' }),
  });
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

test('dispatch threads trustCodexLaunchCwd into buildLaunch for a codex session', async () => {
  const sm = smForDispatch();
  let captured = '';
  sm._newSession = async (_t, _d, inner) => { captured = inner; };
  await sm.dispatch({ cwd: os.tmpdir(), intent: 'x', agent: 'codex' });
  // Default config.json has no trustCodexLaunchCwd override — reads the on
  // default, so the launch cwd is threaded through as trusted.
  assert.match(captured, /trust_level="trusted"/);
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
  assert.deepEqual(mgr.prLinks(), [{ ownerId: 'CARD1', url: 'https://github.com/a/b/pull/7', number: 7, checkStatus: undefined, dirty: undefined, unresolvedCount: undefined }]);
});

test('updateLinkStatus writes checkStatus/dirty onto the matching session pr link', () => {
  const mgr = freshManager();
  mgr.setLinks('CARD1', [{ type: 'pr', url: 'https://github.com/a/b/pull/7', repo: 'a/b', number: 7 }]);
  assert.equal(mgr.updateLinkStatus('CARD1', 'https://github.com/a/b/pull/7', 'failing', true, '2026-06-16T00:00:00Z'), true);
  assert.equal(mgr.getLinks('CARD1')[0].checkStatus, 'failing');
  assert.equal(mgr.getLinks('CARD1')[0].dirty, true);
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

test('updateLinkStatus writes unresolvedCount as the last param, but excludes it from the changed check (renders nowhere, so it must not force a graph rebuild)', () => {
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
  await sm.syncNotesToContainer('d', { run });
  await sm.syncNotesToContainer('h', { run });
  const cps = calls.filter((c) => c[0] === 'docker' && c[1] === 'cp');
  assert.equal(cps.length, 1);                       // only the devcontainer entry copies
  assert.ok(cps[0].join(' ').includes(':/tmp/aw-d/notes')); // into the container's notes dir
});
