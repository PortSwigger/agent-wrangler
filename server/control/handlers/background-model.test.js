import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backgroundModelHandler } from './background-model.js';
import { readConfig, writeConfig } from '../../config-store.js';
import { backgroundModel } from '../../headless.js';
import { adapterFor } from '../../agents/index.js';

function ctx() {
  const calls = { rebuild: 0 };
  return { calls, rebuild: async () => { calls.rebuild += 1; } };
}

test('set-background-model stores a pair that can run headless and rebuilds', async () => {
  writeConfig({ backgroundModel: undefined });
  const model = adapterFor('codex').models[0].value;
  const c = ctx();
  await backgroundModelHandler.handler({ type: 'set-background-model', agent: 'codex', model }, c);
  assert.deepEqual(readConfig().backgroundModel, { agent: 'codex', model });
  assert.deepEqual(backgroundModel(), { agent: 'codex', model });
  assert.equal(c.calls.rebuild, 1);
});

test('set-background-model ignores a pair that cannot run, keeping the one in force', async () => {
  writeConfig({ backgroundModel: { agent: 'claude', model: 'sonnet' } });
  for (const msg of [{ agent: 'claude', model: 'gpt-x' }, { agent: 'nope', model: 'haiku' }, { agent: 'claude' }, { model: 'haiku' }]) {
    await backgroundModelHandler.handler({ type: 'set-background-model', ...msg }, ctx());
  }
  assert.deepEqual(readConfig().backgroundModel, { agent: 'claude', model: 'sonnet' });
  writeConfig({ backgroundModel: undefined });
});
