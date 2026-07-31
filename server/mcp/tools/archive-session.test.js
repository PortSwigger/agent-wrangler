import { test } from 'node:test';
import assert from 'node:assert/strict';
import { archiveSessionTool } from './archive-session.js';

// A deps double recording the kill/archive/rebuild calls. CARD1/CARD2 have
// mapping entries; CARD2 is the live worker in the graph (with a snapshot).
function deps() {
  const calls = { kill: [], archive: [], rebuild: 0 };
  const d = {
    sessionManager: {
      entryFor: (id) => (id === 'CARD1' || id === 'CARD2' ? { short: 'x' } : null),
      killForSession: async (id) => { calls.kill.push(id); return ['cc_two']; },
      archive: (id, snap) => { calls.archive.push({ id, snap }); return true; },
    },
    sessionFromGraph: (id) => (id === 'CARD2'
      ? { sessionId: 'CARD2', cwd: '/b', intent: 'do beta', label: 'Beta' }
      : null),
    taskStore: { taskFor: (id) => (id === 'CARD2' ? { id: 'T1', name: 'Login' } : null) },
    rebuild: async () => { calls.rebuild += 1; },
  };
  return { d, calls };
}

test('archive_session stops and archives a known target with the right snapshot', async () => {
  const { d, calls } = deps();
  const out = await archiveSessionTool.handler({ deps: d, caller: 'CARD1' }, { target: 'CARD2' });
  assert.deepEqual(out.structuredContent, {
    target: 'CARD2', label: 'Beta', archived: true, backgroundShellUncleanStop: null, archivedChildren: 0, containerStopped: null,
  });
  assert.deepEqual(calls.kill, ['CARD2']);
  assert.equal(calls.archive.length, 1);
  assert.equal(calls.archive[0].id, 'CARD2');
  assert.deepEqual(calls.archive[0].snap, {
    cwd: '/b', intent: 'do beta', label: 'Beta', task: { id: 'T1', name: 'Login' },
  });
  assert.equal(calls.rebuild, 1);
});

test('archive_session rejects a self-archive without touching the session', async () => {
  const { d, calls } = deps();
  const out = await archiveSessionTool.handler({ deps: d, caller: 'CARD2' }, { target: 'CARD2' });
  assert.equal(out.isError, true);
  assert.match(out.content[0].text, /yourself/);
  assert.equal(calls.kill.length, 0);
  assert.equal(calls.archive.length, 0);
});

test('archive_session rejects an unknown id', async () => {
  const { d, calls } = deps();
  const out = await archiveSessionTool.handler({ deps: d, caller: 'CARD1' }, { target: 'GHOST' });
  assert.equal(out.isError, true);
  assert.match(out.content[0].text, /Unknown session/);
  assert.equal(calls.kill.length, 0);
});

test('archive_session validates a required target', async () => {
  const { d, calls } = deps();
  const out = await archiveSessionTool.handler({ deps: d, caller: 'CARD1' }, { target: '  ' });
  assert.equal(out.isError, true);
  assert.equal(calls.kill.length, 0);
});

test('a null caller can still archive a known target (null-safe self guard)', async () => {
  const { d, calls } = deps();
  const out = await archiveSessionTool.handler({ deps: d, caller: null }, { target: 'CARD2' });
  assert.equal(out.structuredContent.archived, true);
  assert.deepEqual(calls.kill, ['CARD2']);
});

test('archive_session with a live background shell but no live tmux still archives cleanly (nothing to nudge)', async () => {
  // A real pane's nudge/wait is exercised by waitForBackgroundShellClear's own
  // tests (archive.test.js) — this only checks the no-tmux short-circuit, which
  // doesn't touch a real tmux process.
  const { d, calls } = deps();
  d.sessionFromGraph = (id) => (id === 'CARD2'
    ? { sessionId: 'CARD2', cwd: '/b', intent: 'do beta', label: 'Beta', hasBackgroundShell: true }
    : null);
  d.tmuxFor = () => null;
  const out = await archiveSessionTool.handler({ deps: d, caller: 'CARD1' }, { target: 'CARD2' });
  assert.equal(out.structuredContent.backgroundShellUncleanStop, false);
  assert.deepEqual(calls.archive.map((c) => c.id), ['CARD2']);
});

test('archive_session with a live background shell on a codex worker still archives cleanly with no live tmux (same short-circuit, no agent-specific crash)', async () => {
  const { d, calls } = deps();
  d.sessionFromGraph = (id) => (id === 'CARD2'
    ? { sessionId: 'CARD2', cwd: '/b', intent: 'do beta', label: 'Beta', agent: 'codex', hasBackgroundShell: true }
    : null);
  d.tmuxFor = () => null;
  const out = await archiveSessionTool.handler({ deps: d, caller: 'CARD1' }, { target: 'CARD2' });
  assert.equal(out.structuredContent.backgroundShellUncleanStop, false);
  assert.deepEqual(calls.archive.map((c) => c.id), ['CARD2']);
});

// A tree ORCH -> CHILD1 -> GRANDCHILD (chained nesting), all with mapping entries
// so the target guard passes for any of them.
function depsWithTree() {
  const calls = { kill: [], archive: [] };
  const nodes = {
    ORCH: { sessionId: 'ORCH', cwd: '/x', label: 'Orch' },
    CHILD1: { sessionId: 'CHILD1', cwd: '/x', label: 'Child1', parentSession: 'ORCH' },
    GRANDCHILD: { sessionId: 'GRANDCHILD', cwd: '/x', label: 'Grandchild', parentSession: 'CHILD1' },
  };
  const d = {
    sessionManager: {
      entryFor: (id) => (nodes[id] ? { short: 'x' } : null),
      killForSession: async (id) => { calls.kill.push(id); return ['cc']; },
      archive: (id, snap) => { calls.archive.push({ id, snap }); return true; },
    },
    sessionFromGraph: (id) => nodes[id] ?? null,
    taskStore: { taskFor: () => null },
    graph: () => ({ sessions: Object.values(nodes) }),
    rebuild: async () => {},
  };
  return { d, calls };
}

test('archive_session (default archive_children) archives descendants first, then the target', async () => {
  const { d, calls } = depsWithTree();
  const out = await archiveSessionTool.handler({ deps: d, caller: null }, { target: 'ORCH' });
  // descendantsOf walks breadth-first (CHILD1, then its own child GRANDCHILD);
  // the target (ORCH) is always archived last, after every descendant.
  assert.deepEqual(calls.archive.map((c) => c.id), ['CHILD1', 'GRANDCHILD', 'ORCH']);
  assert.equal(out.structuredContent.archivedChildren, 2);
});

test('archive_session with archive_children: false leaves descendants untouched', async () => {
  const { d, calls } = depsWithTree();
  const out = await archiveSessionTool.handler({ deps: d, caller: null }, { target: 'ORCH', archive_children: false });
  assert.deepEqual(calls.archive.map((c) => c.id), ['ORCH']);
  assert.equal(out.structuredContent.archivedChildren, 0);
});

// --- devcontainer container-stop opt-in ---
// A deps double whose target CARD2 is a devcontainer, with an injected
// stopContainer recording docker calls (no real docker). Mirrors deps() above.
function devcontainerDeps({ targetCwd = '/b', siblings = [] } = {}) {
  const calls = { archive: [], stop: [] };
  const d = {
    sessionManager: {
      entryFor: (id) => (id === 'CARD2' ? { runtime: 'devcontainer', cwd: targetCwd }
        : id === 'CARD1' ? { short: 'x' } : null),
      killForSession: async () => ['cc_two'],
      archive: (id, snap) => { calls.archive.push({ id, snap }); return true; },
    },
    sessionFromGraph: (id) => (id === 'CARD2' ? { sessionId: 'CARD2', cwd: targetCwd, label: 'Beta', runtime: 'devcontainer' } : null),
    taskStore: { taskFor: () => null },
    graph: () => ({ sessions: [{ sessionId: 'CARD2', runtime: 'devcontainer', cwd: targetCwd }, ...siblings] }),
    rebuild: async () => {},
    stopContainer: async (cwd) => { calls.stop.push(cwd); return 'cid1'; },
  };
  return { d, calls };
}

test('archive_session leaves the devcontainer running by default (no stop_container → containerStopped null, no docker stop)', async () => {
  const { d, calls } = devcontainerDeps();
  const out = await archiveSessionTool.handler({ deps: d, caller: null }, { target: 'CARD2' });
  assert.equal(out.structuredContent.containerStopped, null);
  assert.equal(calls.stop.length, 0);
});

test('archive_session with stop_container:true stops the devcontainer when no other session shares the cwd', async () => {
  const { d, calls } = devcontainerDeps();
  const out = await archiveSessionTool.handler({ deps: d, caller: 'CARD1' }, { target: 'CARD2', stop_container: true });
  assert.equal(out.structuredContent.containerStopped, true);
  assert.deepEqual(calls.stop, ['/b']);
});

test('archive_session with stop_container:true is WITHHELD while another active session shares the container', async () => {
  const { d, calls } = devcontainerDeps({ siblings: [{ sessionId: 'SIB', runtime: 'devcontainer', cwd: '/b' }] });
  const out = await archiveSessionTool.handler({ deps: d, caller: null }, { target: 'CARD2', stop_container: true });
  assert.equal(out.structuredContent.containerStopped, false);
  assert.equal(calls.stop.length, 0, 'the shared container must not be stopped');
});

test('archive_session with stop_container:true is a no-op for a non-devcontainer (host) target', async () => {
  const { d, calls } = deps(); // CARD2 entry is { short: 'x' } — no runtime
  let stopped = false;
  d.stopContainer = async () => { stopped = true; return 'cid'; };
  const out = await archiveSessionTool.handler({ deps: d, caller: null }, { target: 'CARD2', stop_container: true });
  assert.equal(out.structuredContent.containerStopped, null);
  assert.equal(stopped, false);
});
