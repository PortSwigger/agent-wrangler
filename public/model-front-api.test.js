import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MODEL_FRONT } from './model-front-api.js';
import { createSlots } from './slots.js';

const methods = ['scoreOf', 'dominates', 'frontOf', 'fullFrontOf', 'unavailableOf', 'curveOf', 'beatenBy', 'nearestOf', 'autoEffortOf', 'resolvedPick', 'programmesOf'];
const committed = JSON.parse(readFileSync(new URL('./model-front-data.json', import.meta.url)));
const [agent, models] = Object.entries(committed.models)[0];
const [model, efforts] = Object.entries(models)[0];
const [effort, row] = Object.entries(efforts)[0];
const pick = { agent, model, effort };
const agents = [{ id: agent, models: [{ value: model, autoEffort: effort }], efforts: [{ value: effort }] }];

test('client extension API exposes frozen modelFront data and the complete bound pure maths contract', () => {
  const slots = createSlots({ document: {}, storage: null });
  const api = slots.forExtension('example', { modelFront: MODEL_FRONT }).api;
  const front = api.modelFront;
  assert.ok(front && Object.isFrozen(front));
  assert.deepEqual(Object.keys(front).sort(), ['data', ...methods].sort());
  for (const method of methods) assert.equal(typeof front[method], 'function', method);
  assert.deepEqual(Object.keys(front.data).sort(), ['benchmarks', 'credit', 'models', 'read']);
  const frozen = (value) => { if (value && typeof value === 'object') { assert.ok(Object.isFrozen(value)); Object.values(value).forEach(frozen); } };
  frozen(front.data);
  assert.deepEqual(front.data, committed);
  assert.match(front.data.credit, /LiteLLM catalog \(MIT\)/);
  const replacement = { models: { [agent]: { [model]: { [effort]: [0, 0, 0] } } } };
  const score = front.scoreOf(pick, replacement);
  assert.deepEqual([score.quality, score.usd, score.minutes], row, 'caller cannot inject rows');
  assert.equal(front.dominates({ quality: row[0] + 1, usd: 0, minutes: 0 }, score), true);
  const available = front.frontOf(agents, replacement);
  assert.equal(available.length, 1);
  assert.deepEqual([available[0].agent, available[0].model, available[0].effort, available[0].quality], [agent, model, effort, row[0]]);
  assert.deepEqual(front.curveOf(available).map((p) => p.effort), [effort]);
  assert.ok(front.fullFrontOf().length > 0);
  assert.ok(front.unavailableOf([]).length > 0);
  const better = { ...pick, quality: row[0] + 1, usd: row[1] / 2, minutes: row[2] / 2 };
  assert.deepEqual(front.beatenBy([better], pick, replacement), better);
  assert.equal(front.nearestOf(available, available[0]), available[0]);
  assert.equal(front.autoEffortOf(agents, { ...pick, effort: '' }), effort);
  assert.deepEqual(front.resolvedPick(agents, { ...pick, effort: '' }), pick);
  assert.deepEqual(front.programmesOf(agents, available, { [agent]: [['Custom', pick]] }, replacement).map((p) => [p.name, p.effort]), [['Custom', effort]]);
  assert.deepEqual(front.programmesOf(agents, available, {}).map((p) => p.name), []);
});

test('mutations cannot change core data or poison subsequent full-front results across extensions', () => {
  const slots = createSlots({ document: {}, storage: null });
  const base = { modelFront: MODEL_FRONT };
  const first = slots.forExtension('first', base).api.modelFront;
  const second = slots.forExtension('second', base).api.modelFront;
  assert.throws(() => { first.data.models[agent][model][effort][0] = 0; }, TypeError);
  assert.throws(() => { first.data.models = {}; }, TypeError);
  assert.throws(() => { first.scoreOf = () => null; }, TypeError);
  const expected = structuredClone(second.fullFrontOf());
  const result = first.fullFrontOf();
  try { result[0].quality = -1; result.splice(0); } catch (error) { assert.ok(error instanceof TypeError); }
  assert.deepEqual(second.fullFrontOf(), expected);
  assert.equal(second.scoreOf(pick).quality, row[0]);
});
