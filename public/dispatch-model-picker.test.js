import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MODEL_FRONT } from './model-front-api.js';
import { pickerState, curveStep, createDispatchModelPicker } from './dispatch-model-picker.js';
const agents = Object.entries(MODEL_FRONT.data.models).map(([id, models]) => ({ id, label: id === 'claude' ? 'Claude' : 'Codex', models: Object.keys(models).map((value) => ({ value, label: value })), efforts: [...new Set(Object.values(models).flatMap(Object.keys))].map((value) => ({ value, label: value })) }));

function pickerHarness(initialPick, available = agents, reducedMotion = false, storage) {
  const element = () => ({
    listeners: {}, attrs: {}, dataset: {}, hidden: false, open: false, textContent: '', innerHTML: '',
    classList: { values: new Set(), toggle(name, on) { if (on) this.values.add(name); else this.values.delete(name); } },
    addEventListener(type, fn) { this.listeners[type] = fn; },
    setAttribute(key, value) { this.attrs[key] = value; },
    removeAttribute(key) { delete this.attrs[key]; },
    contains(target) { return target === this; },
  });
  const nodes = new Map();
  const sections = [element(), element(), element()];
  const timers = [], scrolls = [];
  sections.forEach((section, index) => {
    section.dataset.modelSection = ['recommended', 'graph', 'all'][index];
    section.matches = (selector) => selector === '.model-front-section';
    section.scrollIntoView = (options) => scrolls.push({ section, options });
  });
  nodes.set('.model-front-recommended', sections[0]);
  const view = {
    matchMedia: () => ({ matches: reducedMotion }),
    setTimeout(fn, delay) { timers.push({ fn, delay }); return timers.length - 1; },
    clearTimeout(id) { if (timers[id]) timers[id].cancelled = true; },
  };
  const root = { ...element(), ownerDocument: { ...element(), activeElement: null, defaultView: view },
    querySelector(selector) { if (!nodes.has(selector)) nodes.set(selector, element()); return nodes.get(selector); },
    querySelectorAll(selector) { assert.equal(selector, '.model-front-section'); return sections; },
  };
  root.querySelector('.model-front-recommended').open = true;
  let pick = initialPick;
  const selections = [];
  const picker = createDispatchModelPicker({ root, storage, agents: () => available, read: () => pick, select: (next) => { selections.push(next); pick = next; } });
  picker.sync();
  const clickSection = (section) => {
    const summary = { parentElement: section };
    root.listeners.click({ target: { closest: () => summary } });
    section.open = !section.open;
    root.listeners.toggle({ target: section });
  };
  return { picker, root, nodes, sections, selections, timers, scrolls, clickSection, read: () => pick, set: (next) => { pick = next; picker.sync(); } };
}

test('opening a chooser scrolls it into view after expansion without selecting a model', () => {
  const h = pickerHarness({ agent: 'claude', model: 'opus', effort: 'high' });
  h.clickSection(h.sections[1]);
  assert.deepEqual(h.scrolls, []);
  assert.ok(h.timers[0].delay > 0);
  h.timers[0].fn();
  assert.deepEqual(h.scrolls, [{ section: h.sections[1], options: { behavior: 'smooth', block: 'nearest' } }]);
  assert.deepEqual(h.selections, []);
});

test('a closed or reset chooser never performs a pending reveal', () => {
  const h = pickerHarness({ agent: 'claude', model: 'opus', effort: 'high' });
  h.clickSection(h.sections[1]);
  h.clickSection(h.sections[1]);
  h.timers[0].fn();
  assert.deepEqual(h.scrolls, []);
  h.clickSection(h.sections[2]);
  h.picker.reset();
  h.timers.at(-1).fn();
  assert.deepEqual(h.scrolls, []);
});

test('reduced-motion users reveal the expanded section without smooth scrolling', () => {
  const h = pickerHarness({ agent: 'claude', model: 'opus', effort: 'high' }, agents, true);
  h.clickSection(h.sections[1]);
  assert.equal(h.timers[0].delay, 0);
  h.timers[0].fn();
  assert.equal(h.scrolls[0].options.behavior, 'instant');
});

test('programmatic section changes do not scroll the dialog', () => {
  const h = pickerHarness({ agent: 'claude', model: 'opus', effort: 'high' });
  h.sections[1].open = true;
  h.root.listeners.toggle({ target: h.sections[1] });
  assert.deepEqual(h.timers, []);
  assert.deepEqual(h.scrolls, []);
});

test('Escape dismisses the benchmark sources before it can cancel the launch dialog', () => {
  const h = pickerHarness({ agent: 'claude', model: 'opus', effort: 'high' });
  const sources = h.root.querySelector('.model-front-sources');
  sources.open = true;
  let prevented = false, stopped = false;
  const escape = { key: 'Escape', preventDefault() { prevented = true; }, stopPropagation() { stopped = true; } };
  h.root.listeners.keydown(escape);
  assert.equal(sources.open, false);
  assert.equal(prevented, true);
  assert.equal(stopped, true);
  prevented = stopped = false;
  h.root.listeners.keydown(escape);
  assert.equal(prevented, false);
  assert.equal(stopped, false);
  assert.deepEqual(h.selections, []);
});

test('benchmark sources stay open for inside clicks and dismiss on outside clicks', () => {
  const h = pickerHarness({ agent: 'claude', model: 'opus', effort: 'high' });
  const sources = h.root.querySelector('.model-front-sources');
  sources.open = true;
  h.root.ownerDocument.listeners.pointerdown({ target: sources });
  assert.equal(sources.open, true);
  h.root.ownerDocument.listeners.pointerdown({ target: h.sections[0] });
  assert.equal(sources.open, false);
  assert.deepEqual(h.selections, []);
});

test('reopening and reloading retain the last chooser section alongside an outside model', () => {
  for (const index of [1, 2]) {
    const values = new Map();
    const storage = { getItem: (key) => values.get(key), setItem: (key, value) => values.set(key, value) };
    const pick = { agent: 'claude', model: 'unmeasured', effort: 'high' };
    const h = pickerHarness(pick, agents, false, storage);
    h.clickSection(h.sections[index]);
    h.picker.reset();
    assert.deepEqual(h.sections.map((section) => section.open), [0, 1, 2].map((i) => i === index));
    assert.deepEqual(h.read(), pick);
    assert.deepEqual(h.selections, []);
    const reloaded = pickerHarness(pick, agents, false, storage);
    reloaded.root.listeners.toggle({ target: reloaded.sections[0] });
    reloaded.picker.reset();
    assert.equal(reloaded.sections[index].open, true);
    assert.equal(reloaded.sections[0].open, false);
    assert.deepEqual(reloaded.scrolls, []);
    assert.deepEqual(reloaded.selections, []);
  }
});

test('unavailable browser storage still remembers the section while the page stays open', () => {
  const storage = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('full'); } };
  const h = pickerHarness({ agent: 'claude', model: 'opus', effort: 'high' }, agents, false, storage);
  h.clickSection(h.sections[2]);
  h.picker.reset();
  assert.equal(h.sections[2].open, true);
  assert.equal(h.sections[0].open, false);
});

test('outside recommendations keeps the selection without a slider handle or selected graph point', () => {
  for (const pick of [
    { agent: 'claude', model: 'sonnet', effort: 'high' },
    { agent: 'claude', model: 'unmeasured', effort: 'high' },
    { agent: 'claude', model: 'opus', effort: '' },
  ]) {
    const h = pickerHarness(pick);
    assert.deepEqual(h.read(), pick);
    assert.deepEqual(h.selections, []);
    assert.ok(h.nodes.get('.model-front-slider').classList.values.has('no-handle'));
    assert.doesNotMatch(h.nodes.get('.model-front-plot').innerHTML, /aria-pressed="true"/);
    for (const selector of ['.model-front-slider-note', '.model-front-graph-note']) {
      assert.equal(h.nodes.get(selector)?.hidden, false);
      assert.match(h.nodes.get(selector)?.textContent || '', /outside the recommended set/);
    }
    if (pick.model === 'sonnet') {
      assert.match(h.nodes.get('.model-front-readout').innerHTML, /\$[\d.]+ \/ task/);
      assert.doesNotMatch(h.nodes.get('.model-front-readout').innerHTML, /model-front-benchmark-overlay/);
    }
  }
});

test('front selection synchronizes both views and clears outside-selection notices', () => {
  const h = pickerHarness({ agent: 'claude', model: 'unmeasured', effort: 'high' });
  const pick = MODEL_FRONT.frontOf(agents)[2];
  h.set(pick);
  assert.equal(h.nodes.get('.model-front-slider').classList.values.has('no-handle'), false);
  assert.match(h.nodes.get('.model-front-plot').innerHTML, /data-point="2"[^>]*aria-pressed="true"/);
  assert.equal(h.nodes.get('[role="slider"]').attrs['aria-valuenow'], '2');
  assert.equal(h.nodes.get('.model-front-slider-note').hidden, true);
  assert.equal(h.nodes.get('.model-front-graph-note').hidden, true);
  assert.equal(h.nodes.get('.model-front-slider-note').textContent, '');
  assert.equal(h.nodes.get('.model-front-graph-note').textContent, '');
  assert.deepEqual(h.selections, []);
});

test('reset defaults to the recommended section without changing the selected model', () => {
  const pick = { agent: 'claude', model: 'unmeasured', effort: 'high' };
  const h = pickerHarness(pick);
  h.sections.forEach((section) => { section.open = true; });
  h.nodes.get('.model-front-recommended').open = false;
  h.picker.reset();
  assert.deepEqual(h.sections.map((section) => section.open), [true, false, false]);
  assert.equal(h.nodes.get('.model-front-recommended').open, true);
  assert.equal(h.nodes.get('.model-front-notice').hidden, true);
  assert.deepEqual(h.read(), pick);
  assert.deepEqual(h.selections, []);
});

test('an empty recommended set does not replace the selected model on slider input', () => {
  const pick = { agent: 'custom', model: 'unmeasured', effort: '' };
  const h = pickerHarness(pick, []);
  h.nodes.get('[role="slider"]').listeners.keydown({ key: 'ArrowRight', preventDefault() {} });
  assert.deepEqual(h.read(), pick);
  assert.deepEqual(h.selections, []);
  assert.equal(h.nodes.get('[role="slider"]').attrs['aria-disabled'], 'true');
});

test('missing benchmarks preserve empty metric rows under one shared overlay', async () => {
  const { benchmarkReadout } = await import('./dispatch-model-picker.js');
  const html = benchmarkReadout(null);
  assert.match(html, /No benchmark data available/);
  assert.match(html, /for this setting/);
  for (const label of ['Quality', 'Cost', 'Time']) assert.match(html, new RegExp(`<span>${label}</span>`));
  assert.match(html, /aria-hidden="true"/);
  assert.equal((html.match(/model-front-benchmark-overlay/g) || []).length, 1);
  assert.doesNotMatch(html, /<i |NaN|undefined|0 \/ 100|\$0\.00/);
});

test('partial benchmarks show known metrics and mark individual missing values unavailable', async () => {
  const { benchmarkReadout } = await import('./dispatch-model-picker.js');
  const html = benchmarkReadout({ quality: 0, usd: null, minutes: 12, time: 30 });
  assert.match(html, /0 \/ 100/);
  assert.match(html, /12\.0 min/);
  assert.equal((html.match(/Unavailable/g) || []).length, 1);
  assert.doesNotMatch(html, /model-front-benchmark-overlay|NaN|\$0\.00/);
});

test('zero cost and time remain measured values and non-finite values are unavailable', async () => {
  const { benchmarkReadout } = await import('./dispatch-model-picker.js');
  const html = benchmarkReadout({ quality: NaN, usd: 0, minutes: 0, cost: -Infinity, time: 0 });
  assert.match(html, /\$0\.00 \/ task/);
  assert.match(html, /0\.0 min/);
  assert.equal((html.match(/Unavailable/g) || []).length, 1);
  assert.doesNotMatch(html, /model-front-benchmark-overlay|NaN|Infinity/);
});

test('selecting a scored model clears the no-benchmark overlay and restores all metrics', () => {
  const h = pickerHarness({ agent: 'claude', model: 'unmeasured', effort: 'high' });
  assert.match(h.nodes.get('.model-front-readout').innerHTML, /No benchmark data available/);
  h.set({ agent: 'codex', model: 'gpt-6.1-sol', effort: 'medium' });
  const html = h.nodes.get('.model-front-readout').innerHTML;
  assert.match(html, /55 \/ 100/);
  assert.match(html, /\$1\.14 \/ task/);
  assert.match(html, /36\.8 min/);
  assert.doesNotMatch(html, /model-front-benchmark-overlay|Unavailable/);
});

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
