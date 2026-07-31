import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { workflowPhaseTool } from './workflow-phase.js';

function deps(captured) {
  return {
    sessionManager: {
      setWorkflowPhase: (sid, phase) => { captured.phase = { sid, phase }; return true; },
    },
    rebuild: async () => { captured.rebuilt = (captured.rebuilt || 0) + 1; },
  };
}

test('workflow_phase records the phase under the caller card id and rebuilds', async () => {
  const captured = {};
  const out = await workflowPhaseTool.handler({ deps: deps(captured), caller: 'CARD1' }, { label: 'build', kind: 'active' });
  assert.deepEqual(captured.phase, { sid: 'CARD1', phase: { label: 'build', kind: 'active' } });
  assert.equal(captured.rebuilt, 1);
  assert.deepEqual(out.structuredContent, { label: 'build', kind: 'active' });
});

test('workflow_phase: kind is optional and echoes back as null when omitted', async () => {
  const captured = {};
  const out = await workflowPhaseTool.handler({ deps: deps(captured), caller: 'CARD1' }, { label: 'plan' });
  assert.equal(captured.phase.phase.kind, undefined);
  assert.equal(out.structuredContent.kind, null);
});

test('workflow_phase errors (no write, no rebuild) when the request carries no caller', async () => {
  const captured = {};
  const out = await workflowPhaseTool.handler({ deps: deps(captured), caller: null }, { label: 'x' });
  assert.equal(out.isError, true);
  assert.equal(captured.phase, undefined);
  assert.equal(captured.rebuilt, undefined);
});

test('workflow_phase inputSchema: label required, kind constrained to the tint enum', () => {
  const schema = z.object(workflowPhaseTool.inputSchema);
  assert.equal(schema.safeParse({ label: 'verify' }).success, true);       // 6 chars, the cap
  assert.equal(schema.safeParse({ label: 'plan', kind: 'success' }).success, true);
  assert.equal(schema.safeParse({ label: '' }).success, false);            // min(1)
  assert.equal(schema.safeParse({ label: 'planning' }).success, false);    // max(6)
  assert.equal(schema.safeParse({ kind: 'active' }).success, false);       // label required
  assert.equal(schema.safeParse({ label: 'x', kind: 'bogus' }).success, false);
});
