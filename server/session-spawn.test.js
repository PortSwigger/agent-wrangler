import { test } from 'node:test';
import assert from 'node:assert/strict';

import { collectBeforeSpawn, notifySpawned } from './session-spawn.js';

const payload = { spawnedBy: 'parent', agent: 'codex', model: 'gpt-5', effort: 'high', cwd: '/repo', intent: 'do it', source: 'agent' };
const registry = (before = [], after = []) => ({ hooks: { 'session.beforeSpawn': before, 'session.spawned': after } });
const hook = (extId, fn) => ({ extId, fn });

test('beforeSpawn defaults to allow with no hooks', async () => {
  assert.deepEqual(await collectBeforeSpawn(payload, { ext: registry() }), new Map());
});

test('beforeSpawn binds the host and keeps returned data per extension', async () => {
  const host = {};
  const data = await collectBeforeSpawn(payload, { hostApiFor: () => host, ext: registry([
    hook('one', (input) => { assert.deepEqual(input, { ...payload, host }); return { data: { id: 1 } }; }),
    hook('two', () => ({ data: false })), hook('three', () => undefined),
  ]) });
  assert.deepEqual([...data], [['one', { id: 1 }], ['two', false]]);
});

test('beforeSpawn refusal stops later hooks and returns its reason', async () => {
  let later = false;
  await assert.rejects(collectBeforeSpawn(payload, { ext: registry([
    hook('one', () => ({ refuse: ' Capacity reached ' })),
    hook('two', () => { later = true; }),
  ]) }), /Capacity reached/);
  assert.equal(later, false);
});

test('beforeSpawn fails open on throw and timeout, logs both and continues', async () => {
  const errors = [];
  const data = await collectBeforeSpawn(payload, { timeoutMs: 5, onError: (...args) => errors.push(args), ext: registry([
    hook('broken', () => { throw new Error('broken'); }),
    hook('slow', () => new Promise(() => {})),
    hook('ok', () => ({ data: 3 })),
  ]) });
  assert.deepEqual([...data], [['ok', 3]]);
  assert.equal(errors.length, 2);
  assert.match(errors[0][0], /broken.*session.beforeSpawn/);
  assert.match(errors[1][1].message, /timed out/);
});

test('late beforeSpawn results are ignored after timeout', async () => {
  let resolve;
  const data = await collectBeforeSpawn(payload, { timeoutMs: 5, onError: () => {}, ext: registry([
    hook('slow', () => new Promise((r) => { resolve = r; })),
  ]) });
  resolve({ refuse: 'too late', data: 'too late' });
  await new Promise((r) => setImmediate(r));
  assert.equal(data.size, 0);
});

test('spawned receives the id and only its own extension data', async () => {
  const got = [];
  const host = {};
  await notifySpawned({ ...payload, sessionId: 'new' }, new Map([['one', { id: 1 }], ['two', false]]), {
    hostApiFor: () => host, ext: registry([], ['one', 'two', 'three'].map((id) => hook(id, (input) => got.push(input)))),
  });
  assert.deepEqual(got, [
    { ...payload, sessionId: 'new', host, data: { id: 1 } },
    { ...payload, sessionId: 'new', host, data: false },
    { ...payload, sessionId: 'new', host, data: undefined },
  ]);
});

test('spawned failures and timeouts cannot fail the successful launch', async () => {
  const errors = [];
  let later = false;
  await notifySpawned({ ...payload, sessionId: 'new' }, new Map(), { timeoutMs: 5,
    onError: (...args) => errors.push(args), ext: registry([], [
      hook('broken', () => { throw new Error('broken'); }),
      hook('slow', () => new Promise(() => {})),
      hook('ok', () => { later = true; }),
    ]),
  });
  assert.equal(errors.length, 2);
  assert.equal(later, true);
});
