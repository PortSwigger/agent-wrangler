import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MODEL_FRONT } from './model-front-api.js';
import { pickerState, curveStep } from './dispatch-model-picker.js';
const agents = Object.entries(MODEL_FRONT.data.models).map(([id, models]) => ({ id, label: id, models: Object.keys(models).map((value) => ({ value, label: value })), efforts: [...new Set(Object.values(models).flatMap(Object.keys))].map((value) => ({ value, label: value })) }));

test('slider stops exclude faster-only front points while their verdict stays on the front', () => {
  const front = MODEL_FRONT.frontOf(agents);
  const faster = front.find((p) => !MODEL_FRONT.curveOf(front).includes(p));
  assert.ok(faster);
  const state = pickerState(agents, faster);
  assert.equal(state.handle, -1);
  assert.match(state.verdict, /On the front.*faster/);
  assert.ok(state.score);
  assert.ok(state.curve.every((p) => !MODEL_FRONT.dominates(faster, p)));
  assert.ok(state.curve.includes(curveStep(state, 1)));
});

test('curve arrows advance exactly one stop and clamp at either end', () => {
  const curve = MODEL_FRONT.curveOf(MODEL_FRONT.frontOf(agents));
  assert.deepEqual(curveStep(pickerState(agents, curve[0]), 1), curve[1]);
  assert.deepEqual(curveStep(pickerState(agents, curve[0]), -1), curve[0]);
  assert.deepEqual(curveStep(pickerState(agents, curve.at(-1)), 1), curve.at(-1));
});

test('below-front picks name the dominator and Auto without a reported effort stays unscored', () => {
  const state = pickerState(agents, { agent: 'claude', model: 'sonnet', effort: 'high' });
  assert.match(state.verdict, /^Below the front: .+ is at least as good/);
  assert.equal(state.handle, -1);
  const auto = pickerState(agents, { agent: 'claude', model: 'opus', effort: '' });
  assert.equal(auto.score, null);
  assert.equal(auto.verdict, 'Not scored — Auto effort is not reported by this agent.');
  const reported = structuredClone(agents);
  reported.find((a) => a.id === 'claude').models.find((m) => m.value === 'opus').autoEffort = 'high';
  assert.ok(pickerState(reported, { agent: 'claude', model: 'opus', effort: '' }).score);
});

test('unavailable rings never include settings the installed agents can launch', () => {
  const installed = agents.filter((a) => a.id === 'claude');
  const state = pickerState(installed, { agent: 'claude', model: 'opus', effort: 'high' });
  assert.ok(state.unavailable.some((p) => p.agent === 'codex'));
  assert.ok(state.unavailable.every((p) => !state.front.some((f) => f.agent === p.agent && f.model === p.model && f.effort === p.effort)));
});

test('Auto with a reported effort but no benchmark identifies the missing measurement', () => {
  const unmeasured = structuredClone(agents);
  unmeasured[0].models.push({ value: 'unmeasured', autoEffort: 'high' });
  const state = pickerState(unmeasured, { agent: unmeasured[0].id, model: 'unmeasured', effort: '' });
  assert.equal(state.score, null);
  assert.equal(state.verdict, 'Not scored — no benchmark for this setting.');
});

test('model colours stay stable across effort changes and agent list ordering', async () => {
  const { pickColour, modelKey } = await import('./dispatch-model-picker.js');
  const picks = [
    { agent: 'claude', model: 'opus', effort: 'low' },
    { agent: 'codex', model: 'gpt-6.1-sol', effort: 'high' },
  ];
  assert.equal(pickColour(picks[0]), pickColour({ ...picks[0], effort: 'high' }));
  assert.notEqual(pickColour(picks[0]), pickColour(picks[1]));
  assert.deepEqual(modelKey(agents, [picks[1], picks[0], { ...picks[0], effort: 'high' }]).map((p) => p.label), ['Claude / opus', 'Codex / gpt-6.1-sol']);
  assert.deepEqual(modelKey(agents, picks), modelKey([...agents].reverse(), [...picks].reverse()));
});
