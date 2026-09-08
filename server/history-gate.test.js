import test from 'node:test';
import assert from 'node:assert/strict';
import { createHistoryGate } from './history-gate.js';

const graphWith = (history) => ({ sessions: [], history, generatedAt: 1 });

test('the first graph carries history, so a fresh connection is never starved', () => {
  const gate = createHistoryGate();
  const wire = gate(graphWith([{ sessionId: 'a' }]));
  assert.deepEqual(wire.history, [{ sessionId: 'a' }]);
});

test('an unchanged history is omitted from the wire graph, not sent as null or []', () => {
  const gate = createHistoryGate();
  gate(graphWith([{ sessionId: 'a' }]));
  const wire = gate(graphWith([{ sessionId: 'a' }]));
  assert.equal('history' in wire, false, 'the key must be ABSENT — the client tells "unchanged" from "now empty" by its presence');
  assert.deepEqual(wire.sessions, [], 'every other key still rides the wire graph');
});

test('a changed history is sent again, and a later repeat re-omits it', () => {
  const gate = createHistoryGate();
  gate(graphWith([{ sessionId: 'a' }]));
  const changed = gate(graphWith([{ sessionId: 'a' }, { sessionId: 'b' }]));
  assert.equal(changed.history.length, 2);
  assert.equal('history' in gate(graphWith([{ sessionId: 'a' }, { sessionId: 'b' }])), false);
});

test('a field changing inside an unchanged set of entries still re-sends', () => {
  const gate = createHistoryGate();
  gate(graphWith([{ sessionId: 'a', label: 'old' }]));
  const wire = gate(graphWith([{ sessionId: 'a', label: 'new' }]));
  assert.deepEqual(wire.history, [{ sessionId: 'a', label: 'new' }]);
});

// The last archive being purged empties the list — a state the client must be told
// about, and one an "omit when falsy" gate would hide forever.
test('emptying a non-empty history sends the empty array', () => {
  const gate = createHistoryGate();
  gate(graphWith([{ sessionId: 'a' }]));
  const wire = gate(graphWith([]));
  assert.equal('history' in wire, true);
  assert.deepEqual(wire.history, []);
});

// lastGraph is assigned before the broadcast and is what the connect path and
// ctx.graph() serve, so stripping must copy rather than delete in place.
test('the caller\'s graph is never mutated', () => {
  const gate = createHistoryGate();
  const first = graphWith([{ sessionId: 'a' }]);
  gate(first);
  const second = graphWith([{ sessionId: 'a' }]);
  gate(second);
  assert.deepEqual(second.history, [{ sessionId: 'a' }], 'the snapshot keeps its history for the connect path');
});
