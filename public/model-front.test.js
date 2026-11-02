import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as maths from './model-front.js';

const data = JSON.parse(readFileSync(new URL('../server/fixtures/model-front-data.json', import.meta.url)));
const efforts = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].map((value) => ({ value }));
const catalog = (id, models) => ({ id, efforts, models: models.map((value) => ({ value })) });
const claude = catalog('claude', ['opus', 'sonnet', 'sonnet[1m]', 'haiku', 'fable']);
const codex = catalog('codex', ['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-luna', 'unmeasured']);
const ids = (points) => points.map((p) => `${p.model}:${p.effort}`);
const pick = (model, effort, agent = 'claude') => ({ agent, model, effort });

test('catalog filtering keeps only offered models and measured model-specific efforts', () => {
  const narrow = { ...codex, models: [{ value: 'gpt-6.1-sol', efforts: ['low', 'high'] }, { value: 'unmeasured' }] };
  assert.deepEqual(ids(maths.frontOf([narrow], data)), ['gpt-6.1-sol:low', 'gpt-6.1-sol:high']);
  assert.deepEqual(maths.frontOf([catalog('unknown', ['opus'])], data), []);
  assert.deepEqual(maths.frontOf([], data), []);
  assert.deepEqual(ids(maths.frontOf([{ ...claude, efforts: [{ value: 'medium' }], models: [{ value: 'opus' }] }], data)), ['opus:medium']);
});

test('3D front retains faster points that the quality/cost curve excludes', () => {
  const front = maths.frontOf([claude, codex], data);
  const curve = maths.curveOf(front);
  for (const id of ['opus:low', 'opus:medium', 'gpt-6-astra:low', 'fable:low']) {
    assert.ok(ids(front).includes(id), `${id} wins on time`);
    assert.ok(!ids(curve).includes(id), `${id} is below the quality/cost curve`);
  }
  assert.deepEqual(ids(curve), [
    'gpt-6-luna:low', 'gpt-6-luna:medium', 'gpt-6-luna:high', 'gpt-6-luna:xhigh', 'gpt-6-luna:max',
    'gpt-6.1-terra:low', 'gpt-6.1-terra:medium', 'gpt-6.1-terra:high', 'gpt-6.1-terra:xhigh',
    'gpt-6.1-sol:low', 'gpt-6.1-terra:max', 'gpt-6.1-sol:medium', 'gpt-6.1-sol:high', 'gpt-6.1-sol:xhigh',
    'gpt-6.1-sol:max', 'opus:high', 'opus:xhigh',
  ]);
  assert.deepEqual(maths.curveOf([]), []);
});

test('curve uses quality/cost dominance, sorts by price and does not mutate its input', () => {
  const points = [
    { quality: 30, usd: 3, minutes: 1 },
    { quality: 20, usd: 2, minutes: 2 },
    { quality: 10, usd: 1, minutes: 3 },
    { quality: 20, usd: 1, minutes: 4 },
  ];
  assert.deepEqual(maths.curveOf(points), [points[3], points[0]]);
  assert.equal(points[0].usd, 3);
  const tied = [{ quality: 20, usd: 1, minutes: 2 }, { quality: 20, usd: 1, minutes: 1 }];
  assert.deepEqual(maths.curveOf(tied), tied);
});

test('scores expose raw units and normalized log cost and linear time, unknown rows stay unscored', () => {
  const score = maths.scoreOf(pick('gpt-6.1-sol', 'high', 'codex'), data);
  assert.deepEqual([score.quality, score.usd, score.minutes], [56, 1.34, 40.9]);
  assert.deepEqual([Math.round(score.cost), Math.round(score.time)], [49, 18]);
  assert.equal(maths.scoreOf(pick('opus', ''), data), null);
  assert.equal(maths.scoreOf(pick('missing', 'high'), data), null);
  assert.equal(maths.scoreOf(null, data), null);
});

test('dominance is strict on at least one of the three dimensions', () => {
  const p = { quality: 50, usd: 2, minutes: 5 };
  assert.equal(maths.dominates(p, p), false);
  for (const better of [{ ...p, quality: 51 }, { ...p, usd: 1 }, { ...p, minutes: 4 }]) assert.ok(maths.dominates(better, p));
  assert.equal(maths.dominates({ quality: 60, usd: 1, minutes: 6 }, p), false);
});

test('beatenBy names the strongest dominating front point and handles front and unscored picks', () => {
  const front = maths.frontOf([claude, codex], data);
  assert.deepEqual(ids([maths.beatenBy(front, pick('sonnet', 'max'), data)]), ['opus:xhigh']);
  assert.equal(maths.beatenBy(front, pick('opus', 'high'), data), null);
  assert.equal(maths.beatenBy(front, pick('missing', 'high'), data), null);
});

test('full and unavailable fronts include measured settings absent from the installed catalog', () => {
  const full = maths.fullFrontOf(data);
  assert.deepEqual(full, maths.frontOf([claude, codex], data));
  assert.deepEqual(maths.unavailableOf(full, data), []);
  const unavailable = maths.unavailableOf(maths.frontOf([claude], data), data);
  assert.ok(unavailable.length > 0 && unavailable.every((p) => p.agent === 'codex'));
  assert.deepEqual(ids(maths.unavailableOf(maths.frontOf([{ ...claude, models: claude.models.filter((m) => m.value !== 'fable') }, codex], data), data)), ['fable:low']);
});

test('nearest point uses plotted cost and quality and returns null on an empty front', () => {
  assert.equal(maths.nearestOf([], { cost: 1, quality: 1 }), null);
  const a = { cost: 10, quality: 20 }, b = { cost: 50, quality: 55 };
  assert.equal(maths.nearestOf([a, b], { cost: 49, quality: 52 }), b);
});

test('known Auto resolves to reported effort while unknown Auto remains unscored', () => {
  const agents = [{ ...claude, models: [{ value: 'opus', autoEffort: 'medium' }, { value: 'sonnet' }] }];
  const auto = pick('opus', '');
  assert.equal(maths.autoEffortOf(agents, auto), 'medium');
  assert.deepEqual(maths.resolvedPick(agents, auto), pick('opus', 'medium'));
  assert.equal(maths.scoreOf(maths.resolvedPick(agents, auto), data).quality, 58);
  assert.equal(auto.effort, '');
  const unknown = pick('sonnet', '');
  assert.equal(maths.autoEffortOf(agents, unknown), '');
  assert.equal(maths.scoreOf(maths.resolvedPick(agents, unknown), data), null);
  const explicit = pick('opus', 'high');
  assert.equal(maths.autoEffortOf(agents, explicit), '');
  assert.deepEqual(maths.resolvedPick(agents, explicit), explicit);
  assert.equal(maths.autoEffortOf(agents, null), '');
});

test('caller presets select their own named slots with fallback and strictly rising quality', () => {
  const programmes = {
    both: [['Fast', pick('gpt-6.1-sol', 'low', 'codex')], ['Steady', pick('opus', 'medium')], ['Strong', pick('opus', 'xhigh')]],
    claude: [['Fast', pick('opus', 'low')], ['Steady', pick('opus', 'medium')], ['Strong', pick('opus', 'xhigh')]],
    codex: [['Fast', pick('gpt-6.1-sol', 'low', 'codex')], ['Steady', pick('gpt-6.1-sol', 'xhigh', 'codex')], ['Strong', pick('gpt-6-astra', 'high', 'codex')]],
  };
  const before = structuredClone(programmes);
  const front = maths.frontOf([claude, codex], data);
  assert.deepEqual(maths.programmesOf([claude, codex], front, programmes, data).map((p) => `${p.name} ${p.model}:${p.effort}`), ['Fast gpt-6.1-sol:low', 'Steady opus:medium', 'Strong opus:xhigh']);
  const noOpus = { ...claude, models: [{ value: 'fable' }] };
  const fallbackFront = maths.frontOf([noOpus, codex], data);
  const fallback = maths.programmesOf([noOpus, codex], fallbackFront, programmes, data);
  assert.deepEqual(fallback.map((p) => `${p.name} ${p.model}:${p.effort}`), ['Fast gpt-6.1-sol:low', 'Steady gpt-6.1-sol:xhigh', 'Strong gpt-6-astra:high']);
  assert.ok(fallback.every((p, i) => i === 0 || p.quality > fallback[i - 1].quality));
  assert.deepEqual(maths.programmesOf([claude], front, {}, data), []);
  assert.deepEqual(maths.programmesOf([], [], programmes, data), []);
  assert.deepEqual(programmes, before);
});
