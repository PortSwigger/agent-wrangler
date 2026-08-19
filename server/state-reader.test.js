import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { liveState, sessionLabel, withForkMark, buildGraph } from './state-reader.js';

// A sessions/ dir like ~/.claude/sessions: <pid>.json written by the status hook.
function makeSessionsDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aw-sessions-'));
}
function writeSessionFile(dir, pid, data) {
  fs.writeFileSync(path.join(dir, `${pid}.json`), JSON.stringify(data));
}

test('liveState maps a busy session file to working with its live (forked) id', () => {
  const dir = makeSessionsDir();
  writeSessionFile(dir, 11766, { pid: 11766, sessionId: 'forked-id', status: 'busy' });
  assert.deepEqual(liveState(11766, dir), { liveSid: 'forked-id', status: 'working', rawStatus: 'busy', waitingFor: null, name: null, updatedAt: null });
});

test('liveState surfaces needs-you and passes through waitingFor', () => {
  const dir = makeSessionsDir();
  writeSessionFile(dir, 222, { sessionId: 'f', status: 'waiting', waitingFor: 'approve plan?' });
  assert.deepEqual(liveState(222, dir), { liveSid: 'f', status: 'needs-you', rawStatus: 'waiting', waitingFor: 'approve plan?', name: null, updatedAt: null });
});

// The needs-you alarm ring is suppressed once isAcknowledged() matches the
// acknowledged updatedAt to the session's live updatedAt. Resume-forked sessions
// read status from the live (per-pid) file, so they must read updatedAt from
// there too — else it's null, null===null lets a stale ack match a fresh episode,
// and the ring never re-arms for a session you haven't looked at.
test('liveState surfaces updatedAt so resume-forks can discriminate needs-you episodes', () => {
  const dir = makeSessionsDir();
  writeSessionFile(dir, 777, { sessionId: 'f', status: 'waiting', updatedAt: 1781000000000 });
  assert.equal(liveState(777, dir).updatedAt, 1781000000000);
});

test('liveState surfaces the live fork name so the title survives a resume', () => {
  const dir = makeSessionsDir();
  writeSessionFile(dir, 555, { sessionId: 'fork', status: 'busy', name: 'Run intruder/codec experiment' });
  assert.equal(liveState(555, dir).name, 'Run intruder/codec experiment');
});

test('liveState maps idle', () => {
  const dir = makeSessionsDir();
  writeSessionFile(dir, 333, { sessionId: 'f', status: 'idle' });
  assert.equal(liveState(333, dir).status, 'idle');
});

test('liveState returns null when the file is missing (caller falls back to scrape)', () => {
  const dir = makeSessionsDir();
  assert.equal(liveState(99999, dir), null);
});

test('liveState returns null for a file without a sessionId', () => {
  const dir = makeSessionsDir();
  writeSessionFile(dir, 444, { pid: 444, status: 'busy' });
  assert.equal(liveState(444, dir), null);
});

const CWD = '/Users/me/vcs/agent-wrangler';

test('sessionLabel uses the intent when no explicit name is set (was falling to the folder)', () => {
  assert.equal(
    sessionLabel({ names: [null, null], intent: 'Fix the session title bug', summary: null, cwd: CWD, fallback: 'cc_ab12' }),
    'Fix the session title bug',
  );
});

test('sessionLabel prefers the live Claude title over intent and summary', () => {
  assert.equal(
    sessionLabel({ names: [], liveTitle: 'Auto-set wrangler title', intent: 'dispatched intent', summary: 'a summary', cwd: CWD }),
    'Auto-set wrangler title',
  );
});

test('sessionLabel ignores Claude Code\'s auto agent-name title (basename-hex) and falls to intent', () => {
  assert.equal(
    sessionLabel({ names: [], liveTitle: 'agent-wrangler-3f', intent: 'Fix the session title bug', summary: 'a summary', cwd: CWD }),
    'Fix the session title bug',
  );
});

test('sessionLabel ignores a bare-basename auto title too', () => {
  assert.equal(
    sessionLabel({ names: [], liveTitle: 'agent-wrangler', intent: 'Fix the bug', cwd: CWD }),
    'Fix the bug',
  );
});

test('sessionLabel keeps a real summary that merely starts with the basename (a phrase, not the auto name)', () => {
  assert.equal(
    sessionLabel({ names: [], liveTitle: 'agent-wrangler cleanup pass', intent: 'x', cwd: CWD }),
    'agent-wrangler cleanup pass',
  );
});

test('sessionLabel keeps a basename-suffixed title whose tail is not hex', () => {
  assert.equal(
    sessionLabel({ names: [], liveTitle: 'agent-wrangler-rewrite', intent: 'x', cwd: CWD }),
    'agent-wrangler-rewrite',
  );
});

test('sessionLabel ignores a truncated auto agent-name (long basename cut mid-word before the hex tail)', () => {
  const longCwd = '/Users/me/vcs/agent-wrangler-worktree-shortcut-open-terminal';
  assert.equal(
    sessionLabel({ names: [], liveTitle: 'agent-wrangler-worktree-shortcut-open-te-04', intent: 'Add Cmd+Shift+T shortcut for terminal', cwd: longCwd }),
    'Add Cmd+Shift+T shortcut for terminal',
  );
});

test('sessionLabel ignores a poisoned cached lastLabel (auto agent-name) in the names array', () => {
  // Dormant sessions feed [entry.name, entry.lastLabel] as names; lastLabel can
  // have been snapshotted from a moment the live title was Claude's auto name.
  assert.equal(
    sessionLabel({ names: [null, 'agent-wrangler-48'], intent: 'Review the unify-issues branch', cwd: CWD }),
    'Review the unify-issues branch',
  );
});

test('sessionLabel still lets an explicit human name win over the live Claude title', () => {
  assert.equal(
    sessionLabel({ names: ['My renamed session'], liveTitle: 'Auto-set wrangler title', intent: 'x', cwd: CWD }),
    'My renamed session',
  );
});

test('sessionLabel falls through to intent when there is no live title (dormant session)', () => {
  assert.equal(
    sessionLabel({ names: [], liveTitle: null, intent: 'Fix the bug', summary: null, cwd: CWD }),
    'Fix the bug',
  );
});

test('sessionLabel prefers an explicit name over the intent, untruncated', () => {
  const longName = 'A deliberately chosen rather long custom session name kept verbatim';
  assert.equal(sessionLabel({ names: [longName], intent: 'whatever', cwd: CWD }), longName);
});

test('sessionLabel returns a long intent in full — the UI clips it via CSS', () => {
  const intent = 'a'.repeat(80);
  assert.equal(sessionLabel({ names: [], intent, cwd: CWD }), intent);
});

test('sessionLabel treats the "(resumed)" placeholder as absent and falls through to summary', () => {
  assert.equal(
    sessionLabel({ names: [], intent: '(resumed)', summary: 'Review the PR diff', cwd: CWD }),
    'Review the PR diff',
  );
});

test('sessionLabel falls to the cwd basename only when name, intent and summary are all empty', () => {
  assert.equal(sessionLabel({ names: [null], intent: '', summary: null, cwd: CWD, fallback: 'cc_ab12' }), 'agent-wrangler');
});

test('sessionLabel falls to the explicit fallback when there is no cwd either', () => {
  assert.equal(sessionLabel({ names: [], intent: '', summary: '', cwd: null, fallback: 'cc_ab12' }), 'cc_ab12');
});

test('sessionLabel returns the summary in full too when it is the chosen candidate', () => {
  const summary = 'b'.repeat(80);
  assert.equal(sessionLabel({ names: [], intent: '', summary, cwd: CWD }), summary);
});

test('sessionLabel collapses internal whitespace so a multi-line intent reads as one line', () => {
  assert.equal(
    sessionLabel({ names: [], intent: 'Review this PR please:\n\nhttps://example.com/pr/1', cwd: CWD }),
    'Review this PR please: https://example.com/pr/1',
  );
});

test('withForkMark: marks an un-named fork', () => {
  assert.equal(withForkMark('fix the bug', { forkedFrom: 'parent-O' }), '[FORK] fix the bug');
});

test('withForkMark: marks a fork still showing the inherited parent name', () => {
  assert.equal(withForkMark('Snooze sessions', { forkedFrom: 'parent-O', name: 'Snooze sessions', nameInherited: true }), '[FORK] Snooze sessions');
});

test('withForkMark: a user-renamed (user-chosen) fork shows as-is, no marker', () => {
  assert.equal(withForkMark('My fork', { forkedFrom: 'parent-O', name: 'My fork' }), 'My fork');
});

test('withForkMark: leaves a non-fork session unchanged', () => {
  assert.equal(withForkMark('fix the bug', { intent: 'fix the bug' }), 'fix the bug');
  assert.equal(withForkMark('fix the bug', undefined), 'fix the bug');
});

function makeDormantManager(entries) {
  const byId = new Map(entries.map((e) => [e.sessionId, e]));
  return {
    activeEntries: () => entries.map((e) => ({ ...e })),
    archivedEntries: () => [],
    entryFor: (id) => byId.get(id),
    entryByTmux: () => null,
    tmuxOwner: () => null,
    tmuxNameFor: () => null,
    deadTmuxNameFor: () => null,
    isArchived: () => false,
  };
}

test('buildGraph tags each session node with its agent (defaults to claude)', async () => {
  const mgr = makeDormantManager([
    { sessionId: 'claude-sid', agent: 'claude', cwd: '/nonexistent/c', intent: 'a' },
    { sessionId: 'codex-sid', agent: 'codex', cwd: '/nonexistent/c', intent: 'b', liveSessionId: 'no-such-rollout' },
  ]);
  const graph = await buildGraph(mgr, async () => ({}));
  const byId = Object.fromEntries(graph.sessions.map((s) => [s.sessionId, s]));
  assert.ok(byId['claude-sid'], 'claude dormant node present');
  assert.ok(byId['codex-sid'], 'codex dormant node present');
  assert.equal(byId['claude-sid'].agent, 'claude');
  assert.equal(byId['codex-sid'].agent, 'codex');
});

test('buildGraph carries the mapping snooze onto the board node', async () => {
  const mgr = makeDormantManager([
    { sessionId: 'snz-sid', agent: 'claude', cwd: '/nonexistent/c', intent: 'x', snooze: { until: 9999, createdAt: 1 } },
  ]);
  const graph = await buildGraph(mgr, async () => ({}));
  const node = graph.sessions.find((s) => s.sessionId === 'snz-sid');
  assert.deepEqual(node.snooze, { until: 9999, createdAt: 1 });
});

test('buildGraph carries the transcript-derived current model onto a dormant board node', async () => {
  const mgr = makeDormantManager([
    { sessionId: 'model-sid', agent: 'claude', cwd: '/nonexistent/c', intent: 'x', model: 'opusplan' },
  ]);
  const graph = await buildGraph(mgr, async () => ({ currentModel: 'claude-sonnet-4' }));
  const node = graph.sessions.find((s) => s.sessionId === 'model-sid');
  assert.equal(node.currentModel, 'claude-sonnet-4');
});

test('buildGraph: with no mailStore injected, `mail` is omitted (not a fabricated empty object)', async () => {
  const mgr = makeDormantManager([{ sessionId: 'no-mail-sid', agent: 'claude', cwd: '/nonexistent/c', intent: 'x' }]);
  const graph = await buildGraph(mgr, async () => ({}));
  const node = graph.sessions.find((s) => s.sessionId === 'no-mail-sid');
  assert.equal('mail' in node, true); // the key exists (object literal), but its value is undefined
  assert.equal(node.mail, undefined);
});

test('buildGraph: carries unreadInfo from an injected mailStore onto the dormant board node, keyed on card id', async () => {
  const mgr = makeDormantManager([{ sessionId: 'mail-sid', agent: 'claude', cwd: '/nonexistent/c', intent: 'x' }]);
  const mailStore = { unreadInfo: (id) => (id === 'mail-sid' ? { unread: 3, notifiedAt: 100, amber: true } : { unread: 0, notifiedAt: null, amber: false }) };
  const graph = await buildGraph(mgr, async () => ({}), { mailStore });
  const node = graph.sessions.find((s) => s.sessionId === 'mail-sid');
  assert.deepEqual(node.mail, { unread: 3, notifiedAt: 100, amber: true });
});

test('buildGraph carries the mapping workflow marker onto the board node', async () => {
  const workflow = { issue: 'ENT-1', phase: { label: 'implementing', kind: 'active', at: 1 }, startedAt: 1 };
  const mgr = makeDormantManager([
    { sessionId: 'wf-sid', agent: 'claude', cwd: '/nonexistent/c', intent: 'x', workflow },
    { sessionId: 'nowf-sid', agent: 'claude', cwd: '/nonexistent/c', intent: 'y' },
  ]);
  const graph = await buildGraph(mgr, async () => ({}));
  const node = graph.sessions.find((s) => s.sessionId === 'wf-sid');
  assert.deepEqual(node.workflow, workflow);
  assert.equal(node.parentSession, null);
  const bare = graph.sessions.find((s) => s.sessionId === 'nowf-sid');
  assert.equal(bare.workflow, null, 'an entry with no workflow marker reports null');
  assert.equal(bare.parentSession, null);
});

test('buildGraph carries a generic parentSession onto the board node', async () => {
  const mgr = makeDormantManager([
    { sessionId: 'child-sid', agent: 'claude', cwd: '/nonexistent/c', intent: 'x', parentSession: 'PARENT1' },
  ]);
  const graph = await buildGraph(mgr, async () => ({}));
  const node = graph.sessions.find((s) => s.sessionId === 'child-sid');
  assert.equal(node.parentSession, 'PARENT1');
  assert.equal(node.workflow, null);
});

test('buildGraph carries spawnedBy onto the board node, independent of parentSession', async () => {
  const mgr = makeDormantManager([
    { sessionId: 'child-sid', agent: 'claude', cwd: '/nonexistent/c', intent: 'x', spawnedBy: 'CALLER1' },
    { sessionId: 'nobody-sid', agent: 'claude', cwd: '/nonexistent/c', intent: 'y' },
  ]);
  const graph = await buildGraph(mgr, async () => ({}));
  const node = graph.sessions.find((s) => s.sessionId === 'child-sid');
  assert.equal(node.spawnedBy, 'CALLER1');
  assert.equal(node.parentSession, null, 'spawnedBy alone does not imply nesting');
  const bare = graph.sessions.find((s) => s.sessionId === 'nobody-sid');
  assert.equal(bare.spawnedBy, null);
});

test('buildGraph: a legacy pre-migration worker (workflow:{parent}, no issue/phase/startedAt) reports parentSession + null workflow', async () => {
  const mgr = makeDormantManager([
    { sessionId: 'legacy-worker', agent: 'claude', cwd: '/nonexistent/c', intent: 'x', workflow: { parent: 'ORCH1' } },
  ]);
  const graph = await buildGraph(mgr, async () => ({}));
  const node = graph.sessions.find((s) => s.sessionId === 'legacy-worker');
  assert.equal(node.workflow, null, 'a legacy worker marker must not read as its own orchestrator run');
  assert.equal(node.parentSession, 'ORCH1');
});

test('buildGraph: a real orchestrator marker (has issue/phase/startedAt) is untouched by the legacy fallback', async () => {
  const workflow = { issue: 'ENT-9', phase: { label: 'starting', kind: 'active', at: 1 }, startedAt: 1 };
  const mgr = makeDormantManager([
    { sessionId: 'orch', agent: 'claude', cwd: '/nonexistent/c', intent: 'x', workflow },
  ]);
  const graph = await buildGraph(mgr, async () => ({}));
  const node = graph.sessions.find((s) => s.sessionId === 'orch');
  assert.deepEqual(node.workflow, workflow);
  assert.equal(node.parentSession, null);
});

test('buildGraph carries the mapping links onto the board node', async () => {
  const mgr = makeDormantManager([
    { sessionId: 'lnk-sid', agent: 'claude', cwd: '/nonexistent/c', intent: 'x', links: [{ type: 'jira', key: 'ENT-1' }] },
    { sessionId: 'nolnk-sid', agent: 'claude', cwd: '/nonexistent/c', intent: 'y' },
  ]);
  const graph = await buildGraph(mgr, async () => ({}));
  const node = graph.sessions.find((s) => s.sessionId === 'lnk-sid');
  assert.deepEqual(node.links, [{ type: 'jira', key: 'ENT-1' }]);
  const bare = graph.sessions.find((s) => s.sessionId === 'nolnk-sid');
  assert.deepEqual(bare.links, [], 'an entry with no links defaults to an empty array');
});

// graph.history records mirror the board node's workflow subset + parentSession
// so Search's archived rows can fold a run's worker cards under their orchestrator
// (worker's parentSession → orchestrator sessionId), exactly like the board.
function makeArchiveManager(entries) {
  return {
    activeEntries: () => [],
    archivedEntries: () => entries.map((e) => ({ ...e })),
    entryFor: () => null,
    entryByTmux: () => null,
    tmuxOwner: () => null,
    tmuxNameFor: () => null,
    deadTmuxNameFor: () => null,
    isArchived: () => false,
  };
}

test('buildGraph history record narrows workflow to orchestrator-only and carries parentSession, incl. the legacy fallback', async () => {
  const mgr = makeArchiveManager([
    { sessionId: 'orch', agent: 'claude', cwd: '/x', archivedAt: 3,
      workflow: { issue: 'ENT-1', phase: { label: 'opened PR', kind: 'success', at: 1 }, startedAt: 1 } },
    { sessionId: 'wkr', agent: 'claude', cwd: '/x', archivedAt: 2, parentSession: 'orch' },
    { sessionId: 'legacy-wkr', agent: 'claude', cwd: '/x', archivedAt: 1, workflow: { parent: 'orch' } },
    { sessionId: 'plain', agent: 'claude', cwd: '/x', archivedAt: 0 },
  ]);
  const graph = await buildGraph(mgr, async () => ({}));
  const byId = Object.fromEntries(graph.history.map((h) => [h.sessionId, h]));
  assert.deepEqual(byId.orch.workflow, { issue: 'ENT-1', phase: { label: 'opened PR', kind: 'success', at: 1 } });
  assert.equal(byId.orch.parentSession, null);
  assert.equal(byId.wkr.workflow, null);
  assert.equal(byId.wkr.parentSession, 'orch');
  assert.equal(byId['legacy-wkr'].workflow, null, 'a legacy worker marker must not read as its own orchestrator run');
  assert.equal(byId['legacy-wkr'].parentSession, 'orch');
  assert.equal(byId.plain.workflow, null, 'an archived entry with no workflow marker reports null');
  assert.equal(byId.plain.parentSession, null);
});

test('buildGraph history record carries viaTaskArchive, null when absent', async () => {
  const mgr = makeArchiveManager([
    { sessionId: 'cascaded', agent: 'claude', cwd: '/x', archivedAt: 2, viaTaskArchive: 'T1' },
    { sessionId: 'solo', agent: 'claude', cwd: '/x', archivedAt: 1 },
  ]);
  const graph = await buildGraph(mgr, async () => ({}));
  const byId = Object.fromEntries(graph.history.map((h) => [h.sessionId, h]));
  assert.equal(byId.cascaded.viaTaskArchive, 'T1');
  assert.equal(byId.solo.viaTaskArchive, null);
});

test('buildGraph carries suspendedAt onto the dormant board node', async () => {
  const mgr = makeDormantManager([
    { sessionId: 'susp-sid', agent: 'claude', cwd: '/nonexistent/c', intent: 'x', suspendedAt: 1781000000000 },
  ]);
  const graph = await buildGraph(mgr, async () => ({}));
  const node = graph.sessions.find((s) => s.sessionId === 'susp-sid');
  assert.equal(node.suspendedAt, 1781000000000);
});

test('buildGraph: a dormant node without a suspend stamp reports suspendedAt null', async () => {
  const mgr = makeDormantManager([
    { sessionId: 'plain-sid', agent: 'claude', cwd: '/nonexistent/c', intent: 'x' },
  ]);
  const graph = await buildGraph(mgr, async () => ({}));
  const node = graph.sessions.find((s) => s.sessionId === 'plain-sid');
  assert.equal(node.suspendedAt, null);
});

test('buildGraph prefers the runtime analyze hook for a devcontainer entry; local falls through to enrich', async () => {
  const fakeRuntimeFor = (id) => id === 'devcontainer'
    ? { analyze: async () => ({ usd: 1.23, tokens: { input: 1, output: 2, cacheWrite: 0, cacheRead: 0 }, subAgents: [], lastActivity: 111, summary: null, lastMessage: null, aiTitle: null }) }
    : {}; // local/absent: no analyze hook
  const mgr = makeDormantManager([
    { sessionId: 'dc-sid', agent: 'claude', runtime: 'devcontainer', cwd: '/nonexistent/c', intent: 'x', liveSessionId: 'L1' },
    { sessionId: 'local-sid', agent: 'claude', cwd: '/nonexistent/c', intent: 'y', liveSessionId: 'L2' },
  ]);
  const enrich = async () => ({ usd: 9.99, tokens: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 }, subAgents: [] });
  const graph = await buildGraph(mgr, enrich, { runtimeResolver: fakeRuntimeFor });
  const dc = graph.sessions.find((s) => s.sessionId === 'dc-sid');
  const loc = graph.sessions.find((s) => s.sessionId === 'local-sid');
  assert.equal(dc.usd, 1.23);   // devcontainer: from the runtime hook
  assert.equal(loc.usd, 9.99);  // local: falls through to enrich (host)
});

test('buildGraph carries runtime onto the board node (devcontainer set, local null)', async () => {
  const mgr = makeDormantManager([
    { sessionId: 'dc-sid', agent: 'claude', runtime: 'devcontainer', cwd: '/nonexistent/c', intent: 'x' },
    { sessionId: 'local-sid', agent: 'claude', cwd: '/nonexistent/c', intent: 'y' },
  ]);
  // Stub resolver → no runtime.analyze → no docker subprocess; the runtime FIELD is
  // carried independently of enrichment.
  const graph = await buildGraph(mgr, async () => ({}), { runtimeResolver: () => ({}) });
  assert.equal(graph.sessions.find((s) => s.sessionId === 'dc-sid').runtime, 'devcontainer');
  assert.equal(graph.sessions.find((s) => s.sessionId === 'local-sid').runtime, null);
});

// The DISCOVERED live-tmux loop (a Resume-fork-style node synthesized from an owned
// tmux with no live session file under its owner id) is where a devcontainer's
// bring-up/failure hint (C1's classify().waitingFor) must land — that loop has no
// dormant-manager fixture yet, so it's built here directly with `discover`/`capture`
// injected (mirroring the `runtimeResolver` seam already used above).
function makeDiscoveredManager(entry, tmuxName) {
  return {
    activeEntries: () => [],
    archivedEntries: () => [],
    entryFor: (id) => (id === entry.sessionId ? entry : undefined),
    entryByTmux: (t) => (t === tmuxName ? entry : null),
    tmuxOwner: () => null,
    tmuxNameFor: () => null,
    deadTmuxNameFor: () => null,
    isArchived: () => false,
    scanSockets: () => [''],
    socketOf: () => '',
  };
}

test('buildGraph: a discovered devcontainer session in bring-up reads working with a starting-container hint', async () => {
  const entry = { sessionId: 'dc1', agent: 'claude', runtime: 'devcontainer', cwd: '/nonexistent/repo', liveSessionId: 'L1' };
  const mgr = makeDiscoveredManager(entry, 'cc_dc1');
  const discover = async () => [{ tmuxName: 'cc_dc1', socket: '', claudePid: 4242, agent: 'claude', cwd: '/nonexistent/repo', command: 'devcontainer exec ... claude', paneTitle: '' }];
  const capture = async () => 'Resolving Feature dependencies...\nRunning the postCreateCommand from devcontainer.json...\nnpm install';
  const runtimeResolver = (rt) => (rt === 'devcontainer' ? { readLive: async () => null, analyze: async () => null } : {});
  const graph = await buildGraph(mgr, async () => ({}), { runtimeResolver, discover, capture });
  const node = graph.sessions.find((s) => s.sessionId === 'dc1');
  assert.ok(node, 'discovered devcontainer node present');
  assert.equal(node.status, 'working');
  assert.equal(node.waitingFor, 'starting container');
});

// Regression: a normal working pane (no bring-up markers) on the SAME discovered/
// devcontainer path must NOT get a waitingFor hint — proving the card's new `▸` line
// (added for `working` in cards.js) stays silent for an ordinary busy session.
test('buildGraph: a discovered devcontainer session with a normal working pane has no waitingFor hint', async () => {
  const entry = { sessionId: 'dc2', agent: 'claude', runtime: 'devcontainer', cwd: '/nonexistent/repo', liveSessionId: 'L2' };
  const mgr = makeDiscoveredManager(entry, 'cc_dc2');
  const discover = async () => [{ tmuxName: 'cc_dc2', socket: '', claudePid: 5252, agent: 'claude', cwd: '/nonexistent/repo', command: 'devcontainer exec ... claude', paneTitle: '' }];
  const capture = async () => 'Some tool output...\nesc to interrupt';
  const runtimeResolver = (rt) => (rt === 'devcontainer' ? { readLive: async () => null, analyze: async () => null } : {});
  const graph = await buildGraph(mgr, async () => ({}), { runtimeResolver, discover, capture });
  const node = graph.sessions.find((s) => s.sessionId === 'dc2');
  assert.ok(node, 'discovered devcontainer node present');
  assert.equal(node.status, 'working');
  assert.equal(node.waitingFor, null);
});

// `/clear` starts a fresh conversation (new id, new transcript) inside the same pane,
// so the pane's session file is the ONLY place that swap shows up. buildGraph already
// enriches from the live id it finds there; it must also hand it to the session manager
// or the entry keeps pointing at the abandoned conversation (stale label once dormant,
// and Resume brings the abandoned one back).
test('buildGraph writes back a live session id that changed under us (a /clear)', async () => {
  const entry = { sessionId: 'clr1', agent: 'claude', cwd: '/nonexistent/repo', intent: 'the original ask', liveSessionId: 'L1' };
  const mgr = makeDiscoveredManager(entry, 'cc_clr1');
  const noted = [];
  mgr.noteLiveSessionId = async (...args) => { noted.push(args); };
  const discover = async () => [{ tmuxName: 'cc_clr1', socket: '', claudePid: 7171, agent: 'claude', cwd: '/nonexistent/repo', command: 'claude --session-id L1', paneTitle: '' }];
  const runtimeResolver = () => ({ readLive: async () => ({ liveSid: 'L2', status: 'idle', rawStatus: 'idle', name: null, waitingFor: null }) });
  await buildGraph(mgr, async () => ({}), { runtimeResolver, discover, capture: async () => '' });
  assert.deepEqual(noted, [['clr1', 'L2']], 'the card id and the conversation actually running');
});

// Claude's 'shell' status means "a Bash tool is tracked as live" — it can't
// distinguish a still-blocking foreground command from a detached
// run_in_background job the turn has already ended on. A still-blocking
// command keeps "esc to interrupt" in the pane, so 'shell' + that pane text
// must stay 'working' (the mid-command guard the raw status exists to serve).
test('buildGraph: raw shell status + a pane still showing "esc to interrupt" stays working', async () => {
  const entry = { sessionId: 'sh1', agent: 'claude', cwd: '/nonexistent/repo', liveSessionId: 'L1' };
  const mgr = makeDiscoveredManager(entry, 'cc_sh1');
  const discover = async () => [{ tmuxName: 'cc_sh1', socket: '', claudePid: 6161, agent: 'claude', cwd: '/nonexistent/repo', command: 'claude --resume L1', paneTitle: '' }];
  const capture = async () => 'Running a long build...\nesc to interrupt';
  const runtimeResolver = () => ({ readLive: async () => ({ liveSid: 'L1', status: 'working', rawStatus: 'shell', name: null, waitingFor: null }) });
  const graph = await buildGraph(mgr, async () => ({}), { runtimeResolver, discover, capture });
  const node = graph.sessions.find((s) => s.sessionId === 'sh1');
  assert.ok(node, 'synthesized node present');
  assert.equal(node.status, 'working');
});

// The other half of the same guard: once the pane's own idle prompt shows (the
// turn has genuinely ended) with the background-shell footer still present, the
// stale 'shell' status must not pin the card at "busy" forever — it should read
// idle, with hasBackgroundShell true so displayStatus() (public/util.js) folds
// it into the 'job' state.
test('buildGraph: raw shell status + an idle pane with the shell footer reads idle, with hasBackgroundShell true', async () => {
  const entry = { sessionId: 'sh2', agent: 'claude', cwd: '/nonexistent/repo', liveSessionId: 'L2' };
  const mgr = makeDiscoveredManager(entry, 'cc_sh2');
  const discover = async () => [{ tmuxName: 'cc_sh2', socket: '', claudePid: 6262, agent: 'claude', cwd: '/nonexistent/repo', command: 'claude --resume L2', paneTitle: '' }];
  const capture = async () => 'Started — sleep 1800 is running in the background.\n❯ \n⏵⏵ auto mode on · 1 shell · ← 2 agents';
  const runtimeResolver = () => ({ readLive: async () => ({ liveSid: 'L2', status: 'working', rawStatus: 'shell', name: null, waitingFor: null }) });
  const graph = await buildGraph(mgr, async () => ({}), { runtimeResolver, discover, capture });
  const node = graph.sessions.find((s) => s.sessionId === 'sh2');
  assert.ok(node, 'synthesized node present');
  assert.equal(node.status, 'idle');
  assert.equal(node.hasBackgroundShell, true);
});

// C3: a COLD devcontainer dispatch spends 1-2min in `devcontainer up` +
// postCreateCommand before `claude` starts. During that window the pane has no
// `claude` token for discoverClaudeSessions to match, so `discover` legitimately
// returns [] even though the owned tmux is alive. Without synthesis this entry
// would fall through to the dormant loop below (a "Resume" card) despite a live,
// building container. buildGraph must detect this by tmux LIVENESS
// (sessionManager.tmuxNameFor) and synthesize a discovered record so it's picked
// up by the same discovered-loop path as a resume-fork/bring-up node above.
test('buildGraph: a live-but-UNdiscovered devcontainer tmux is synthesized into a working bring-up node', async () => {
  const entry = { sessionId: 'bu1', agent: 'claude', runtime: 'devcontainer', cwd: '/nonexistent/repo', liveSessionId: 'L1', tmux: 'cc_bu1' };
  const mgr = {
    activeEntries: () => [entry],
    archivedEntries: () => [],
    entryFor: (id) => (id === 'bu1' ? entry : undefined),
    entryByTmux: (t) => (t === 'cc_bu1' ? entry : null),
    tmuxNameFor: (id) => (id === 'bu1' ? 'cc_bu1' : null),   // alive owned tmux
    tmuxOwner: () => null, deadTmuxNameFor: () => null,
    isArchived: () => false, scanSockets: () => [''], socketOf: () => '',
  };
  const discover = async () => [];                            // NOT discovered as an agent
  const capture = async () => 'Resolving Feature dependencies...\nRunning the postCreateCommand from devcontainer.json...\nnpm install';
  const runtimeResolver = (rt) => (rt === 'devcontainer' ? { readLive: async () => null, analyze: async () => null } : {});
  const graph = await buildGraph(mgr, async () => ({}), { runtimeResolver, discover, capture });
  const node = graph.sessions.find((s) => s.sessionId === 'bu1');
  assert.ok(node, 'synthesized bring-up node present');
  assert.equal(node.managed, true);
  assert.equal(node.status, 'working');
  assert.equal(node.waitingFor, 'starting container');
  assert.equal(node.tmux, 'cc_bu1');
});

// Negative: the fallback is scoped to a devcontainer entry with a genuinely
// alive tmux. A devcontainer entry whose `tmuxNameFor` returns null (no tmux, or
// a dead one) must NOT be synthesized — it stays on the ordinary dormant path
// (managed: false, offering Resume), same as before this fix existed.
test('buildGraph: a devcontainer entry with no alive tmux is NOT synthesized (stays dormant)', async () => {
  const mgr = makeDormantManager([
    { sessionId: 'bu2', agent: 'claude', runtime: 'devcontainer', cwd: '/nonexistent/repo', liveSessionId: 'L2' },
  ]);
  const discover = async () => [];
  const graph = await buildGraph(mgr, async () => ({}), { discover });
  const node = graph.sessions.find((s) => s.sessionId === 'bu2');
  assert.ok(node, 'dormant node present');
  assert.equal(node.managed, false);
});

// Scope guard (the binding constraint): the synthesis MUST fire only for a
// devcontainer runtime — a LOCAL/host session's pane IS `claude`, so it's always
// discovered normally and must never be synthesized off tmux liveness alone.
// Mirrors the positive bring-up test verbatim but with a local entry (no
// `runtime` field) that has a live tmux + empty discover(): without the
// `if (entry.runtime !== 'devcontainer') continue;` guard this WOULD be
// synthesized into a managed working "starting container" node, so this test is
// non-vacuous — it asserts the local entry instead falls to the dormant loop.
test('buildGraph: a live-but-UNdiscovered LOCAL tmux is NOT synthesized (runtime scope guard)', async () => {
  const entry = { sessionId: 'loc1', agent: 'claude', cwd: '/nonexistent/repo', liveSessionId: 'L3', tmux: 'cc_loc1' };
  const mgr = {
    activeEntries: () => [entry],
    archivedEntries: () => [],
    entryFor: (id) => (id === 'loc1' ? entry : undefined),
    entryByTmux: (t) => (t === 'cc_loc1' ? entry : null),
    tmuxNameFor: (id) => (id === 'loc1' ? 'cc_loc1' : null),   // alive owned tmux
    tmuxOwner: () => null, deadTmuxNameFor: () => null,
    isArchived: () => false, scanSockets: () => [''], socketOf: () => '',
  };
  const discover = async () => [];                             // NOT discovered as an agent
  const capture = async () => 'Resolving Feature dependencies...\nRunning the postCreateCommand from devcontainer.json...\nnpm install';
  const runtimeResolver = () => ({});
  const graph = await buildGraph(mgr, async () => ({}), { runtimeResolver, discover, capture });
  const node = graph.sessions.find((s) => s.sessionId === 'loc1');
  assert.ok(node, 'dormant node present');
  assert.equal(node.managed, false);
  assert.notEqual(node.waitingFor, 'starting container');
});

// A session-manager stub whose only owned tmux is `cc_lead`, mapped to the lead
// card `lead-card` (live id `lead-live`). Real ~/.claude/sessions files are read
// by buildGraph but never match this stub's ids, so they don't create nodes.
function makeTeamManager() {
  const lead = { sessionId: 'lead-card', agent: 'claude', liveSessionId: 'lead-live', cwd: '/nonexistent/c', name: 'Lead task' };
  return {
    scanSockets: () => [''],
    isArchived: () => false,
    entryFor: () => undefined,
    tmuxOwner: () => null,
    tmuxNameFor: () => null,
    deadTmuxNameFor: () => null,
    socketOf: () => '',
    isResuming: () => false,
    entryByTmux: (name) => (name === 'cc_lead' ? { ...lead } : null),
    activeEntries: () => [],
    archivedEntries: () => [],
  };
}

const leadPane = {
  tmuxName: 'cc_lead', socket: '', claudePid: 990001, agent: 'claude', cwd: '/nonexistent/c',
  command: 'claude --resume lead-live --permission-mode auto', paneId: '%990', windowIndex: '0', paneTitle: '✳ Lead task',
};
const teammatePane = {
  tmuxName: 'cc_lead', socket: '', claudePid: 990002, agent: 'claude', cwd: '/nonexistent/c',
  command: 'claude --agent-name worker-arm --team-name T --parent-session-id lead-live --agent-type general-purpose --agent-color blue',
  paneId: '%991', windowIndex: '0', paneTitle: '⠂ general-purpose',
};

test('buildGraph folds an agent-team member pane into the lead node (no phantom duplicate card)', async () => {
  const mgr = makeTeamManager();
  const graph = await buildGraph(mgr, async () => ({}), { discover: async () => [leadPane, teammatePane] });
  const leadNodes = graph.sessions.filter((s) => s.sessionId === 'lead-card');
  assert.equal(leadNodes.length, 1, 'exactly one node for the lead card');
  assert.equal(graph.sessions.some((s) => s.label === 'general-purpose'), false, 'no phantom teammate card');
  const teammates = leadNodes[0].teammates;
  assert.equal(teammates.length, 1);
  assert.equal(teammates[0].name, 'worker-arm');
  assert.equal(teammates[0].agentType, 'general-purpose');
  assert.equal(teammates[0].color, 'blue');
  assert.equal(teammates[0].paneId, '%991');
});

test('buildGraph dedupes two primary panes of one owned tmux to a single node', async () => {
  const mgr = makeTeamManager();
  const second = { ...leadPane, claudePid: 990003, paneId: '%992', paneTitle: '✳ Lead task' };
  const graph = await buildGraph(mgr, async () => ({}), { discover: async () => [leadPane, second] });
  const leadNodes = graph.sessions.filter((s) => s.sessionId === 'lead-card');
  assert.equal(leadNodes.length, 1, 'the same realSid never yields two synthesized nodes');
  assert.equal(leadNodes[0].teammates.length, 0);
});

test('buildGraph bounds a dormant fork\'s enrichment at its createdAt, and leaves a plain session unbounded', async () => {
  const mgr = makeDormantManager([
    { sessionId: 'fork-sid', agent: 'claude', cwd: '/nonexistent/c', intent: 'x', forkedFrom: 'PARENT1', createdAt: 4242, liveSessionId: 'fork-live' },
    { sessionId: 'plain-sid', agent: 'claude', cwd: '/nonexistent/c', intent: 'y', createdAt: 4242, liveSessionId: 'plain-live' },
  ]);
  const seen = new Map();
  await buildGraph(mgr, async (sid, opts) => { seen.set(sid, opts); return {}; });
  assert.deepEqual(seen.get('fork-live'), { since: 4242 }, 'a fork must not be billed for the parent history replayed into its transcript');
  assert.deepEqual(seen.get('plain-live'), { since: 0 });
});
