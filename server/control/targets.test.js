import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTargets } from './targets.js';

test('tmuxFor prefers the graph node, falling back to the manager', () => {
  const graph = { sessions: [{ sessionId: 'S1', tmux: 'cc_live', socket: 'sockA' }] };
  const sm = { attachTargetFor: () => 'cc_fallback', socketOf: () => 'sockX' };
  const { tmuxFor, socketFor, sessionFromGraph } = createTargets(sm, () => graph);

  assert.equal(sessionFromGraph('S1').tmux, 'cc_live');
  assert.equal(tmuxFor('S1'), 'cc_live');
  assert.equal(socketFor('S1'), 'sockA'); // graph node socket wins
});

test('tmuxFor falls back to the manager for an off-graph session', () => {
  const sm = { attachTargetFor: (id) => (id === 'S2' ? 'cc_fb' : null), socketOf: () => 'sockY' };
  const { tmuxFor, socketFor } = createTargets(sm, () => ({ sessions: [] }));
  assert.equal(tmuxFor('S2'), 'cc_fb');
  // No graph node → socket resolved via the manager off the fallback target.
  assert.equal(socketFor('S2'), 'sockY');
});

test('socketFor defaults to the legacy empty socket when nothing resolves', () => {
  const sm = { attachTargetFor: () => null };
  const { socketFor } = createTargets(sm, () => null);
  assert.equal(socketFor('nope'), '');
});
