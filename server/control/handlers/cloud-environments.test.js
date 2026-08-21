import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cloudEnvironmentsHandler } from './cloud-environments.js';

// The injected `write` is what keeps this test off the developer's real
// ~/.agent-wrangler/config.json — `node --test` runs files in parallel against it.
function ctx() {
  const calls = { writes: [], rebuild: 0 };
  return {
    calls,
    write: (patch) => calls.writes.push(patch),
    rebuild: async () => { calls.rebuild += 1; },
  };
}

async function run(environments, c) {
  await cloudEnvironmentsHandler.handler({ type: 'cloud-environments', environments }, c, { write: c.write });
}

test('cloud-environments: persists valid rows and rebuilds', async () => {
  const c = ctx();
  await run([{ label: 'Anthropic prod', id: 'env_abc' }, { label: 'Runner pool', id: 'ccpool_xyz' }], c);
  assert.deepEqual(c.calls.writes, [{
    cloudEnvironments: [{ label: 'Anthropic prod', id: 'env_abc' }, { label: 'Runner pool', id: 'ccpool_xyz' }],
  }]);
  assert.equal(c.calls.rebuild, 1);
});

test('cloud-environments: drops a row whose id has neither known prefix', async () => {
  const c = ctx();
  await run([{ label: 'Good', id: 'env_ok' }, { label: 'Typo', id: 'evn_oops' }, { label: 'Bare', id: 'prod' }], c);
  assert.deepEqual(c.calls.writes[0].cloudEnvironments, [{ label: 'Good', id: 'env_ok' }]);
});

test('cloud-environments: drops a row with no label', async () => {
  const c = ctx();
  await run([{ label: '', id: 'env_a' }, { label: '   ', id: 'env_b' }, { id: 'env_c' }, { label: 'Keep', id: 'env_d' }], c);
  assert.deepEqual(c.calls.writes[0].cloudEnvironments, [{ label: 'Keep', id: 'env_d' }]);
});

test('cloud-environments: trims whitespace around both fields', async () => {
  const c = ctx();
  await run([{ label: '  Prod  ', id: '  env_abc  ' }], c);
  assert.deepEqual(c.calls.writes[0].cloudEnvironments, [{ label: 'Prod', id: 'env_abc' }]);
});

test('cloud-environments: a duplicate id keeps only the first spelling', async () => {
  const c = ctx();
  await run([{ label: 'First', id: 'env_a' }, { label: 'Second', id: 'env_a' }], c);
  assert.deepEqual(c.calls.writes[0].cloudEnvironments, [{ label: 'First', id: 'env_a' }]);
});

test('cloud-environments: only label and id survive — no extra client fields', async () => {
  const c = ctx();
  await run([{ label: 'Prod', id: 'env_a', secret: 'x', selected: true }], c);
  assert.deepEqual(Object.keys(c.calls.writes[0].cloudEnvironments[0]), ['label', 'id']);
});

test('cloud-environments: an empty array is a legitimate "clear them all"', async () => {
  const c = ctx();
  await run([], c);
  assert.deepEqual(c.calls.writes, [{ cloudEnvironments: [] }]);
  assert.equal(c.calls.rebuild, 1);
});

test('cloud-environments: a non-array payload writes nothing (never wipes the registry)', async () => {
  for (const bad of [undefined, null, 'env_a', { id: 'env_a' }, 7]) {
    const c = ctx();
    await run(bad, c);
    assert.deepEqual(c.calls.writes, [], `payload ${JSON.stringify(bad)} must not write`);
    assert.equal(c.calls.rebuild, 1);
  }
});

test('cloud-environments: a non-object row is dropped rather than throwing', async () => {
  const c = ctx();
  await run([null, 'env_a', 42, { label: 'Keep', id: 'env_ok' }], c);
  assert.deepEqual(c.calls.writes[0].cloudEnvironments, [{ label: 'Keep', id: 'env_ok' }]);
});

test('cloud-environments: registered under the type the client sends', () => {
  assert.equal(cloudEnvironmentsHandler.type, 'cloud-environments');
});
