import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stateToGraph } from './deck-client.js';
import { actingAs, resetLegacyWarnings, setLegacyReporter, warnLegacy, withCompatFields } from './legacy-surface.js';

const frame = {
  type: 'state', rev: 3,
  sessions: [{ id: 'session:a', type: 'session', sessionId: 'a', label: 'A' }, { id: 'session:b', type: 'session', sessionId: 'b' }],
  nodes: [{ id: 'session:a', type: 'session', sessionId: 'a', label: 'A' }, { id: 'folder:/x', type: 'folder', sessionId: 'a' }],
  settings: {}, status: {}, ext: {},
  compat: { sessionFields: { a: { pid: 12, socket: 's' } } },
};

test('the extension graph carries the full session record; reading a compat field warns once', () => {
  resetLegacyWarnings();
  const lines = [];
  const warn = console.warn;
  console.warn = (m) => lines.push(m);
  try {
    const g = stateToGraph(frame, { restore: withCompatFields });
    assert.deepEqual(lines, [], 'building the graph reads nothing');
    assert.equal(g.sessions[0].pid, 12);
    assert.equal(g.nodes[0].socket, 's');
    assert.equal(g.sessions[0].pid, 12);
    assert.equal(lines.length, 2, 'one warning per field, on its first read');
    assert.match(lines[0], /session\.pid is deprecated/);
    assert.ok(!('pid' in g.sessions[1]), 'a session with no compat fields is untouched');
    assert.ok(!('pid' in g.nodes[1]), 'only session nodes are restored');
    assert.deepEqual(Object.keys(g.sessions[0]), ['id', 'type', 'sessionId', 'label', 'pid', 'socket'], 'the old shape, keys and all');
    g.sessions[0].pid = 13;
    assert.equal(g.sessions[0].pid, 13, 'a write sticks');
  } finally {
    console.warn = warn;
  }
});

test('without restore the board view stays as the deck sent it', () => {
  const g = stateToGraph(frame);
  assert.ok(!('pid' in g.sessions[0]));
  assert.ok(!('compat' in g));
});

const tick = () => new Promise((r) => setTimeout(r, 0));

test('each extension\'s first use of a surface is reported once a page load, after the reporter is set', async () => {
  resetLegacyWarnings();
  const quiet = { log: () => {} };
  actingAs('old-ext', () => warnLegacy('session.pid', 'x', { ...quiet, use: 'board.session-field' }));
  const reports = [];
  setLegacyReporter(async (use, ext) => { reports.push([use, ext]); return true; });
  await tick();
  assert.deepEqual(reports, [['board.session-field', 'old-ext']], 'a use before the deck was reachable is sent once it is');
  actingAs('old-ext', () => warnLegacy('session.socket', 'x', { ...quiet, use: 'board.session-field' }));
  actingAs('other-ext', () => warnLegacy('session.pid', 'x', { ...quiet, use: 'board.session-field' }));
  warnLegacy('graph.todos', 'x', { ...quiet, use: 'board.graph-key', ext: 'old-ext' });
  await tick();
  assert.deepEqual(reports, [['board.session-field', 'old-ext'], ['board.session-field', 'other-ext'], ['board.graph-key', 'old-ext']]);
  resetLegacyWarnings();
});

test('a report the deck refused is tried again on the next use', async () => {
  resetLegacyWarnings();
  let ok = false;
  const reports = [];
  setLegacyReporter(async (use, ext) => { reports.push([use, ext]); return ok; });
  const use = () => warnLegacy('graph.todos', 'x', { log: () => {}, use: 'board.graph-key', ext: 'old-ext' });
  use();
  await tick();
  ok = true;
  use();
  await tick();
  use();
  await tick();
  assert.equal(reports.length, 2);
  resetLegacyWarnings();
});
