import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createGraphFrameGate } from './graph-frame-gate.js';
import { createHistoryGate } from './history-gate.js';

const graphAt = (generatedAt, extra = {}) => ({ nodes: [], sessions: [{ sessionId: 'a', status: 'idle' }], history: [{ sessionId: 'h' }], generatedAt, ...extra });

// The pair as rebuildOnce chains them.
function gates() {
  const wireGraph = createHistoryGate();
  const graphFrame = createGraphFrameGate();
  return (graph) => graphFrame(wireGraph(graph));
}

test('the first graph is sent whole, as the message the client parses', () => {
  const frame = gates()(graphAt(1));
  assert.deepEqual(JSON.parse(frame), { type: 'graph', graph: graphAt(1) });
});

test('a graph that differs from the last only in generatedAt is not sent', () => {
  const frameFor = gates();
  frameFor(graphAt(1));
  assert.equal(frameFor(graphAt(2)), null);
  assert.equal(frameFor(graphAt(3)), null, 'nor any repeat after it');
});

// history-gate leaves history off the tick after the one that carried it, so a
// compare over the whole wire graph would see that as a change and send it.
test('the history-less tick after a history change is still a repeat', () => {
  const frameFor = gates();
  frameFor(graphAt(1));
  const changed = frameFor(graphAt(2, { history: [{ sessionId: 'h' }, { sessionId: 'i' }] }));
  assert.equal(JSON.parse(changed).graph.history.length, 2);
  assert.equal(frameFor(graphAt(3, { history: [{ sessionId: 'h' }, { sessionId: 'i' }] })), null);
});

test('a real change is sent on the tick it happens, with the fresh generatedAt', () => {
  const frameFor = gates();
  frameFor(graphAt(1));
  frameFor(graphAt(2));
  const frame = JSON.parse(frameFor(graphAt(3, { sessions: [{ sessionId: 'a', status: 'working' }] })));
  assert.equal(frame.graph.sessions[0].status, 'working');
  assert.equal(frame.graph.generatedAt, 3);
  assert.equal('history' in frame.graph, false, 'history-gate still omits an unchanged history');
});

test('a change back to an earlier state is sent: the compare is with the last frame, not any frame', () => {
  const frameFor = gates();
  frameFor(graphAt(1));
  frameFor(graphAt(2, { tasks: { tasks: [1] } }));
  assert.notEqual(frameFor(graphAt(3)), null);
});

test('a changed history alone is sent even when nothing else moved', () => {
  const frameFor = gates();
  frameFor(graphAt(1));
  const frame = frameFor(graphAt(2, { history: [] }));
  assert.deepEqual(JSON.parse(frame).graph.history, []);
});

test('splicing copes with a graph that has no other keys, or no generatedAt', () => {
  assert.deepEqual(JSON.parse(createGraphFrameGate()({ generatedAt: 5 })), { type: 'graph', graph: { generatedAt: 5 } });
  assert.deepEqual(JSON.parse(createGraphFrameGate()({ sessions: [] })), { type: 'graph', graph: { sessions: [] } });
  assert.deepEqual(JSON.parse(createGraphFrameGate()({})), { type: 'graph', graph: {} });
});

test('the caller\'s graph is never mutated', () => {
  const graph = graphAt(1);
  createGraphFrameGate()(graph);
  assert.deepEqual(graph, graphAt(1));
});

// app.js can't be imported under node:test (see history-gate.test.js), so the
// client half is pinned statically: with idle ticks gone, something on the client
// has to keep clock-driven rendering (time-ago tags, snooze waking) moving.
test('the board re-applies its last graph when the server goes quiet', () => {
  const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /if \(msg\.type === 'graph'\) \{ applyGraph\(msg\.graph\); armIdleReapply\(\); \}/);
  assert.match(app, /if \(latestGraph\) applyGraph\(latestGraph\);/);
});
