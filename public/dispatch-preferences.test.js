import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dispatchPick, readDispatchPick, saveDispatchPick } from './dispatch-preferences.js';

const agents = [
  { id: 'claude', models: [{ value: 'opus', default: true }, { value: 'shared' }], efforts: [{ value: 'high' }] },
  { id: 'codex', models: [{ value: 'sol', default: true, efforts: ['low'] }, { value: 'shared' }], efforts: [{ value: 'low' }, { value: 'medium' }] },
];
const saved = { agent: 'codex', model: 'sol', effort: 'low' };

test('explicit dispatch values win over the remembered choice, including omitted scheduled effort', () => {
  assert.deepEqual(dispatchPick(agents, saved), saved);
  assert.deepEqual(dispatchPick(agents, saved, { agent: 'claude', model: 'opus' }), { agent: 'claude', model: 'opus', effort: '' });
  assert.deepEqual(dispatchPick(agents, saved, { model: 'shared', agent: 'claude', effort: 'high' }), { agent: 'claude', model: 'shared', effort: 'high' });
  assert.deepEqual(dispatchPick(agents, saved, { model: 'opus', effort: '' }), { agent: 'claude', model: 'opus', effort: '' });
});

test("agent-only schedules use that agent's live default instead of the remembered agent", () => {
  assert.deepEqual(dispatchPick(agents, { agent: 'claude', model: 'opus', effort: 'high' }, { agent: 'codex' }), { agent: 'codex', model: 'sol', effort: '' });
  assert.deepEqual(dispatchPick(agents, null, { agent: 'codex', effort: 'low' }), { agent: 'codex', model: 'sol', effort: 'low' });
});

test('stale agent or model falls back to a live default and invalid effort becomes Auto', () => {
  for (const pick of [null, [], 'bad', { agent: 'gone', model: 'opus' }, { agent: 'codex', model: 'gone' }]) {
    assert.deepEqual(dispatchPick(agents, pick), { agent: 'claude', model: 'opus', effort: '' });
  }
  assert.deepEqual(dispatchPick(agents, { ...saved, effort: 'high' }), { ...saved, effort: '' });
  assert.deepEqual(dispatchPick(agents.slice(1), { agent: 'claude', model: 'opus' }), { ...saved, effort: '' });
  assert.equal(dispatchPick([], saved), null);
});

test('browser storage remembers explicit choices including Auto across independent reads', () => {
  const values = new Map();
  const storage = { getItem: (k) => values.get(k), setItem: (k, v) => values.set(k, v) };
  saveDispatchPick(storage, saved);
  assert.deepEqual(readDispatchPick(storage), saved);
  saveDispatchPick(storage, { ...saved, effort: '' });
  assert.deepEqual(readDispatchPick(storage), { ...saved, effort: '' });
  storage.setItem('aw-dispatch-pick', 'broken json');
  assert.equal(readDispatchPick(storage), null);
  const denied = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('full'); } };
  assert.equal(readDispatchPick(denied), null);
  assert.doesNotThrow(() => saveDispatchPick(denied, saved));
});
