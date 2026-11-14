import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStateStream, toState } from './state.js';

const graph = (over = {}) => ({
  generatedAt: 1,
  sessions: [{ id: 'session:a', type: 'session', sessionId: 'a', label: 'A', pid: 12, socket: 's', liveSessionId: 'L' }],
  history: [{ sessionId: 'h' }],
  nodes: [{ id: 'session:a', type: 'session', sessionId: 'a', pid: 12 }, { id: 'folder:/x', type: 'folder' }],
  edges: [{ id: 'e' }],
  tasks: [{ id: 't' }],
  schedules: [],
  defaultRuntime: 'local',
  extensions: [{ id: 'todos', enabled: true }],
  codeVersion: 'abc',
  todos: { items: [] },
  ...over,
});

test('toState projects the session view, groups settings, and keys extension state by id', () => {
  const s = toState(graph(), { todos: { todos: { items: [] } } });
  assert.deepEqual(s.sessions, [{ id: 'session:a', type: 'session', sessionId: 'a', label: 'A' }]);
  assert.deepEqual(s.nodes[0], { id: 'session:a', type: 'session', sessionId: 'a' });
  assert.deepEqual(s.settings, { defaultRuntime: 'local', extensions: [{ id: 'todos', enabled: true }] });
  assert.deepEqual(s.status, { codeVersion: 'abc' });
  assert.deepEqual(s.ext, { todos: { todos: { items: [] } } });
  assert.ok(!('todos' in s), 'an extension key never sits at the top level');
});

test('rev only rises, an unchanged rebuild sends nothing, and history rides only when it moved', () => {
  const stream = createStateStream({ startRev: 100 });
  assert.equal(stream.next(), null, 'nothing observed yet');
  stream.observe(graph(), {});
  const first = JSON.parse(stream.next());
  assert.equal(first.type, 'state');
  assert.equal(first.rev, 101);
  assert.deepEqual(first.history, [{ sessionId: 'h' }]);

  stream.observe(graph({ generatedAt: 2 }), {});
  assert.equal(stream.next(), null, 'only generatedAt moved');

  stream.observe(graph({ generatedAt: 3, tasks: [] }), {});
  const second = JSON.parse(stream.next());
  assert.equal(second.rev, 102);
  assert.ok(!('history' in second), 'history unchanged, so left out');

  stream.observe(graph({ history: [] }), {});
  const third = JSON.parse(stream.next());
  assert.equal(third.rev, 103);
  assert.deepEqual(third.history, []);

  const snap = JSON.parse(stream.snapshot());
  assert.equal(snap.rev, 103);
  assert.deepEqual(snap.history, [], 'a snapshot always carries history');
});

test('PR toast suppression follows server settings through deck state updates', () => {
  const stream = createStateStream({ startRev: 100 });
  stream.observe(graph({ suppressNudgedPrToasts: true }));
  assert.equal(JSON.parse(stream.next()).settings.suppressNudgedPrToasts, true);
  stream.observe(graph({ suppressNudgedPrToasts: false }));
  assert.equal(JSON.parse(stream.next()).settings.suppressNudgedPrToasts, false);
});
