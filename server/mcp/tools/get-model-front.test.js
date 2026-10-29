import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getModelFrontTool } from './get-model-front.js';

const efforts = ['low', 'medium', 'high', 'xhigh', 'max'].map((value) => ({ value }));
const agents = [
  { id: 'claude', efforts, models: [
    { value: 'opus', efforts: ['low', 'high'], autoEffort: 'high' },
    { value: 'sonnet', efforts: ['high'], autoEffort: 'high' },
    { value: 'opusplan' },
  ] },
  { id: 'codex', efforts, models: [
    { value: 'gpt-6.1-sol', efforts: ['low', 'xhigh'], autoEffort: 'xhigh' },
    { value: 'gpt-6-luna', efforts: ['low'] },
  ] },
];
const sonnet = { agent: 'claude', model: 'sonnet', effort: 'high' };
const sol = { agent: 'codex', model: 'gpt-6.1-sol', effort: 'xhigh', quality: 57, usd: 1.39, minutes: 41.9 };
const call = (args, installed = agents) => getModelFrontTool.handler({ deps: { agents: async () => installed } }, args);

test('get_model_front returns only launchable front points, cheapest first, with units and credit', async () => {
  const out = await call();
  const result = out.structuredContent;
  assert.deepEqual(JSON.parse(out.content[0].text), result);
  assert.match(result.read, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(result.credit, /Terminal-Bench 4\.0/);
  assert.match(result.credit, /LiteLLM catalog/);
  assert.deepEqual(result.units, {
    quality: 'Terminal-Bench 4.0 points', usd: 'list-price dollars per task', minutes: 'wall-clock minutes per task',
  });
  assert.deepEqual(result.front, [
    { agent: 'codex', model: 'gpt-6-luna', effort: 'low', quality: 8, usd: 0.1, minutes: 23.2, onCurve: true },
    { agent: 'codex', model: 'gpt-6.1-sol', effort: 'low', quality: 51, usd: 0.92, minutes: 32.2, onCurve: true },
    { ...sol, onCurve: true },
    { agent: 'claude', model: 'opus', effort: 'low', quality: 39, usd: 1.58, minutes: 26.8, onCurve: false },
    { agent: 'claude', model: 'opus', effort: 'high', quality: 64, usd: 4.76, minutes: 40.6, onCurve: true },
  ]);
  assert.equal('pick' in result, false);
});

test('front filters do not narrow pick judgement or change curve membership', async () => {
  for (const filters of [{ agent: 'claude' }, { maxUsd: 0.1 }, { minQuality: 64 }, { agent: 'claude', maxUsd: 0.1, minQuality: 64 }]) {
    const { structuredContent: result } = await call({ ...filters, pick: sonnet });
    assert.deepEqual(result.pick, { ...sonnet, resolvedEffort: 'high', scored: true, quality: 38, usd: 2.27, minutes: 44, onFront: false, beatenBy: sol });
    assert.ok(result.front.every((p) => (!filters.agent || p.agent === filters.agent)
      && (filters.maxUsd === undefined || p.usd <= filters.maxUsd)
      && (filters.minQuality === undefined || p.quality >= filters.minQuality)));
    if (filters.agent === 'claude' && filters.maxUsd === undefined) {
      assert.equal(result.front.find((p) => p.effort === 'low').onCurve, false);
    }
  }
});

test('installed agents determine the judgement front, including a single agent and no agents', async () => {
  const installed = [{ ...agents[0], models: [{ value: 'opus', efforts: ['high'] }, agents[0].models[1]] }];
  const { structuredContent: result } = await call({ pick: sonnet }, installed);
  assert.equal(result.pick.onFront, true);
  assert.equal(result.pick.beatenBy, null);
  assert.ok(result.front.every((p) => p.agent === 'claude'));
  assert.deepEqual((await call({}, [])).structuredContent.front, []);
});

test('Auto with omitted or empty effort resolves the reported model effort', async () => {
  for (const effort of [undefined, '']) {
    const pick = { agent: 'codex', model: 'gpt-6.1-sol', ...(effort === undefined ? {} : { effort }) };
    const { structuredContent: result } = await call({ maxUsd: 0.1, pick });
    assert.deepEqual(result.pick, { ...pick, resolvedEffort: 'xhigh', scored: true, quality: 57, usd: 1.39, minutes: 41.9, onFront: true, beatenBy: null });
  }
});

test('unmeasured models, unknown Auto and efforts with no row have no numbers or verdict', async () => {
  for (const pick of [
    { agent: 'claude', model: 'opusplan', effort: 'high' },
    { agent: 'codex', model: 'gpt-6-luna' },
    { agent: 'codex', model: 'gpt-6-luna', effort: '' },
    { agent: 'codex', model: 'gpt-6-luna', effort: 'ultra' },
    { agent: 'claude', model: 'opus', effort: 'toString' },
  ]) {
    const out = await call({ pick });
    assert.equal(out.isError, undefined);
    assert.deepEqual(out.structuredContent.pick, { ...pick, resolvedEffort: pick.effort || '', scored: false });
    assert.deepEqual(JSON.parse(out.content[0].text), out.structuredContent);
  }
});

test('unknown or unavailable agents and models name the available choices', async () => {
  for (const args of [{ agent: 'typo' }, { pick: { agent: 'typo', model: 'opus' } }, { agent: 'codex' }]) {
    const out = await call(args, [agents[0]]);
    assert.equal(out.isError, true);
    assert.match(out.content[0].text, /Valid agents: claude/);
  }
  for (const model of ['typo', 'gpt-6.1-sol']) {
    const out = await call({ pick: { agent: 'claude', model } });
    assert.equal(out.isError, true);
    assert.match(out.content[0].text, /Valid models: opus, sonnet, opusplan/);
  }
});
