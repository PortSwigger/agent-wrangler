import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MODEL_FRONT } from './model-front-api.js';
import { pickerState, curveStep } from './dispatch-model-picker.js';
const agents = Object.entries(MODEL_FRONT.data.models).map(([id, models]) => ({ id, label: id === 'claude' ? 'Claude' : 'Codex', models: Object.keys(models).map((value) => ({ value, label: value })), efforts: [...new Set(Object.values(models).flatMap(Object.keys))].map((value) => ({ value, label: value })) }));

test('slider includes every front point while the plotted curve excludes faster-only points', () => {
  const front = MODEL_FRONT.frontOf(agents);
  const faster = front.find((p) => !MODEL_FRONT.curveOf(front).includes(p));
  assert.ok(faster);
  const state = pickerState(agents, faster);
  assert.deepEqual(state.stops[state.handle], faster);
  assert.deepEqual(state.stops, state.front);
  assert.match(state.verdict, /On the front.*faster/);
  assert.ok(state.score);
  assert.ok(state.curve.every((p) => !MODEL_FRONT.dominates(faster, p)));
  assert.ok(state.stops.includes(curveStep(state, 1)));
});

test('slider arrows visit every front point and clamp at either end', () => {
  const curve = MODEL_FRONT.frontOf(agents);
  for (let i = 0; i < curve.length - 1; i++) {
    assert.deepEqual(curveStep(pickerState(agents, curve[i]), 1), curve[i + 1]);
    assert.deepEqual(curveStep(pickerState(agents, curve[i + 1]), -1), curve[i]);
  }
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

test('log cost ticks use round dollar values at their actual logarithmic positions', async () => {
  const { costTicks } = await import('./dispatch-model-picker.js');
  const ticks = costTicks();
  assert.deepEqual(ticks.map((t) => t.label), ['$0.10', '$0.20', '$0.50', '$1', '$2', '$5', '$10']);
  assert.ok(ticks.every((t) => t.cost >= 0 && t.cost <= 100));
  const one = ticks.find((t) => t.usd === 1), two = ticks.find((t) => t.usd === 2), ten = ticks.find((t) => t.usd === 10);
  assert.ok(Math.abs((two.cost - one.cost) / (ten.cost - one.cost) - Math.log10(2)) < 1e-10);
});

test('unavailable clicks show an anchored tooltip, dismissed by Escape or outside clicks', async () => {
  const { createDispatchModelPicker } = await import('./dispatch-model-picker.js');
  const element = () => ({
    listeners: {}, attrs: {}, dataset: {}, style: { setProperty(key, value) { this[key] = value; } }, hidden: true, textContent: '', innerHTML: '',
    classList: { toggle() {} }, offsetWidth: 260,
    addEventListener(type, fn) { this.listeners[type] = fn; },
    setAttribute(key, value) { this.attrs[key] = value; },
    getAttribute(key) { return this.attrs[key]; },
    removeAttribute(key) { delete this.attrs[key]; },
    contains(target) { return target === this; },
  });
  const doc = { ...element(), activeElement: null };
  const nodes = new Map();
  const root = { ...element(), ownerDocument: doc,
    querySelector(selector) { if (!nodes.has(selector)) nodes.set(selector, element()); return nodes.get(selector); },
    getBoundingClientRect() { return { left: 100, top: 100, width: 300 }; },
  };
  const dot = { ...element(), dataset: { point: '0', unavailable: 'true' },
    closest() { return this; },
    getBoundingClientRect() { return { left: 350, right: 370, top: 200 }; },
  };
  dot.setAttribute('aria-label', 'Unavailable model');
  const notice = root.querySelector('.model-front-notice');
  notice.id = 'model-front-unavailable-tooltip';
  let selections = 0;
  const picker = createDispatchModelPicker({ root, agents: () => agents, read: () => ({ agent: 'claude', model: 'opus', effort: 'high' }), select: () => selections++ });
  picker.sync();
  const plot = nodes.get('.model-front-plot');
  plot.listeners.click({ target: dot });
  assert.equal(notice.hidden, false);
  assert.match(notice.textContent, /installed agents do not offer/);
  assert.equal(dot.attrs['aria-describedby'], notice.id);
  assert.equal(notice.style.left, '32px');
  assert.equal(notice.style['--notice-arrow-left'], '228px');
  assert.equal(notice.style.top, '92px');
  assert.equal(selections, 0);
  root.listeners.keydown({ key: 'Escape' });
  assert.equal(notice.hidden, true);
  assert.equal(dot.attrs['aria-describedby'], undefined);
  dot.getBoundingClientRect = () => ({ left: 230, right: 250, top: 200 });
  plot.listeners.keydown({ key: 'Enter', target: dot, preventDefault() {} });
  assert.equal(notice.style.left, '10px');
  assert.equal(notice.style['--notice-arrow-left'], '130px');
  assert.equal(notice.hidden, false);
  doc.listeners.pointerdown({ target: element() });
  assert.equal(notice.hidden, true);
  plot.listeners.click({ target: dot });
  picker.sync();
  assert.equal(notice.hidden, true);
});

test('graph cost range fits visible points and expands for an expensive selected point', async () => {
  const { costRange, costTicks } = await import('./dispatch-model-picker.js');
  const visible = [...MODEL_FRONT.frontOf(agents), ...MODEL_FRONT.unavailableOf(MODEL_FRONT.frontOf(agents))];
  const range = costRange(visible);
  assert.deepEqual(range, [0.1, 10]);
  assert.equal(costTicks(range).at(-1).label, '$10');
  assert.deepEqual(costRange([...visible, { usd: 16.18 }]), [0.1, 20]);
  assert.deepEqual(costRange([]), [0.1, 10]);
  const single = costRange([{ usd: 1 }]);
  assert.ok(single[0] <= 1 && single[1] >= 1 && single[1] > single[0]);
});
