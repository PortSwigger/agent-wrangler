import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  reduceCodexCatalog, refreshCodexCatalog, codexModels, codexEfforts, defaultCodexModel,
  liveCodexContextWindow, onCodexCatalogChange, _resetCodexCatalogForTest,
} from './codex-catalog.js';
import { codex } from './codex.js';

afterEach(() => _resetCodexCatalogForTest());

const levels = (...efforts) => efforts.map((effort) => ({ effort, description: '' }));
const model = (slug, priority, efforts, extra = {}) => ({
  slug, display_name: slug.toUpperCase(), description: `${slug} model.`, visibility: 'list',
  priority, supported_reasoning_levels: levels(...efforts), context_window: 272_000, ...extra,
});
const RAW = { models: [
  model('gpt-9-luna', 3, ['low', 'medium', 'high']),
  model('gpt-9-astra', 1, ['low', 'medium', 'high', 'xhigh', 'ultra']),
  model('gpt-9-hidden', 2, ['low'], { visibility: 'hide' }),
] };

test('reduceCodexCatalog keeps the fields we use, in Codex priority order', () => {
  const out = reduceCodexCatalog(RAW);
  assert.deepEqual(out.map((m) => m.slug), ['gpt-9-astra', 'gpt-9-hidden', 'gpt-9-luna']);
  assert.deepEqual(out[0], {
    slug: 'gpt-9-astra', displayName: 'GPT-9-ASTRA', description: 'gpt-9-astra model.', visibility: 'list',
    priority: 1, efforts: ['low', 'medium', 'high', 'xhigh', 'ultra'], contextWindow: 272_000,
  });
});

test('the adapter lists only Codex-listed models once a refresh lands', async () => {
  assert.equal(await refreshCodexCatalog({ run: async () => RAW }), true);
  assert.deepEqual(codex.models.map((m) => m.value), ['gpt-9-astra', 'gpt-9-luna']);
  assert.deepEqual(codex.models[1], { value: 'gpt-9-luna', label: 'GPT-9-LUNA · gpt-9-luna model', pillLabel: 'gpt-9 luna' });
});

test('with no preferred default listed, the default is Codex’s first model', async () => {
  await refreshCodexCatalog({ run: async () => RAW });
  assert.equal(defaultCodexModel(), 'gpt-9-astra');
  assert.deepEqual(codexModels().filter((m) => m.default).map((m) => m.value), ['gpt-9-astra']);
});

test('gpt-6-sol stays the default while Codex lists it', async () => {
  await refreshCodexCatalog({ run: async () => ({ models: [...RAW.models, model('gpt-6-sol', 5, ['low'])] }) });
  assert.equal(defaultCodexModel(), 'gpt-6-sol');
});

test('efforts are the union across listed models, labelled', async () => {
  await refreshCodexCatalog({ run: async () => RAW });
  assert.deepEqual(codexEfforts(), [
    { value: 'low', label: 'Low' }, { value: 'medium', label: 'Medium' }, { value: 'high', label: 'High' },
    { value: 'xhigh', label: 'Extra high' }, { value: 'ultra', label: 'Ultra' },
  ]);
});

test('the live context window is only reported after a refresh', async () => {
  assert.equal(liveCodexContextWindow('gpt-9-astra'), null);
  await refreshCodexCatalog({ run: async () => RAW });
  assert.equal(liveCodexContextWindow('gpt-9-astra'), 272_000);
});

test('a failed or empty refresh keeps the current list and does not notify', async () => {
  await refreshCodexCatalog({ run: async () => RAW });
  let notified = 0;
  const off = onCodexCatalogChange(() => { notified += 1; });
  assert.equal(await refreshCodexCatalog({ run: async () => { throw new Error('boom'); } }), false);
  assert.equal(await refreshCodexCatalog({ run: async () => ({ models: [] }) }), false);
  assert.equal(await refreshCodexCatalog({ run: async () => RAW }), false, 'unchanged catalog is not a change');
  off();
  assert.equal(notified, 0);
  assert.deepEqual(codexModels().map((m) => m.value), ['gpt-9-astra', 'gpt-9-luna']);
});

test('the bundled snapshot stands in before any refresh', () => {
  assert.ok(codex.models.length > 0);
  assert.equal(codex.models.filter((m) => m.default).length, 1);
  assert.ok(codex.efforts.length > 0);
});
