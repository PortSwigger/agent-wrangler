import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commandOnPath, createInstalledAgents } from './installed.js';

test('lists the agents whose CLI is on PATH, re-checking once the cache expires', async () => {
  let clock = 0;
  const onPath = new Set(['claude']);
  let lookups = 0;
  const installed = createInstalledAgents({
    adapters: () => [{ id: 'claude' }, { id: 'codex' }, { id: 'gemini' }],
    onPath: async (name) => { lookups++; return onPath.has(name); },
    ttlMs: 1000,
    now: () => clock,
  });
  assert.deepEqual(await installed(), ['claude']);
  onPath.add('codex');
  clock = 999;
  assert.deepEqual(await installed(), ['claude'], 'cached');
  assert.equal(lookups, 3);
  clock = 1000;
  assert.deepEqual(await installed(), ['claude', 'codex']);
});

test('concurrent callers share one lookup', async () => {
  let lookups = 0;
  const installed = createInstalledAgents({ adapters: () => [{ id: 'claude' }], onPath: async () => { lookups++; return true; } });
  const [x, y] = await Promise.all([installed(), installed()]);
  assert.deepEqual(x, ['claude']);
  assert.deepEqual(y, ['claude']);
  assert.equal(lookups, 1);
});

test('commandOnPath finds sh and not a missing command', async () => {
  assert.equal(await commandOnPath('sh'), true);
  assert.equal(await commandOnPath('aw-no-such-command-xyz'), false);
});
