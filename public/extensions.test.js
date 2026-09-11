import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClientExtensionLoader } from './extensions.js';
import { createSlots } from './slots.js';

function harness(modules) {
  const document = { createElement: () => ({ children: [], dataset: {}, appendChild() {}, removeChild() {} }) };
  const errors = [];
  const slots = createSlots({ document, storage: null, onError: (msg) => errors.push(String(msg)) });
  const imported = [];
  const load = createClientExtensionLoader(slots, {
    importer: async (url) => {
      imported.push(url);
      const m = modules[url];
      if (m instanceof Error) throw m;
      if (!m) throw new Error(`404 ${url}`);
      return m;
    },
    onError: (msg) => errors.push(String(msg)),
  });
  return { slots, errors, imported, load };
}

const good = (id) => ({ default: { register(reg) { reg.register('panel.section', { id: `${id}-panel`, mount() {} }); } } });

test('loads each announced module and registers it under its own id', async () => {
  const { slots, load, errors } = harness({ '/ext/a/index.js': good('a'), '/ext/b/index.js': good('b') });
  assert.equal(await load([{ id: 'a', client: '/ext/a/index.js' }, { id: 'b', client: '/ext/b/index.js' }]), true);
  assert.deepEqual(slots.contributions('panel.section').map((c) => `${c.extId}:${c.id}`), ['a:a-panel', 'b:b-panel']);
  assert.deepEqual(errors, []);
});

test('a reconnect re-sending the same list registers nothing twice', async () => {
  const { slots, load, imported } = harness({ '/ext/a/index.js': good('a') });
  const list = [{ id: 'a', client: '/ext/a/index.js' }];
  await load(list);
  assert.equal(await load(list), false);
  assert.equal(imported.length, 1);
  assert.equal(slots.contributions('panel.section').length, 1);
});

test('an importer that throws for one id leaves the others registered and releases the id for retry', async () => {
  const modules = { '/ext/a/index.js': new Error('parse error'), '/ext/b/index.js': good('b') };
  const { slots, load, errors, imported } = harness(modules);
  const list = [{ id: 'a', client: '/ext/a/index.js' }, { id: 'b', client: '/ext/b/index.js' }];
  await load(list);
  assert.deepEqual(slots.contributions('panel.section').map((c) => c.extId), ['b']);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /\[ext:a\] failed to load/);
  // The next connect retries a — and only a.
  modules['/ext/a/index.js'] = good('a');
  await load(list);
  assert.deepEqual(imported, ['/ext/a/index.js', '/ext/b/index.js', '/ext/a/index.js']);
  assert.deepEqual(slots.contributions('panel.section').map((c) => c.extId).sort(), ['a', 'b']);
});

test('a module without default.register is a failure, and a register that throws mid-way is rolled back', async () => {
  const { slots, load, errors } = harness({
    '/ext/a/index.js': { default: {} },
    '/ext/b/index.js': { default: { register(reg) { reg.register('panel.section', { id: 'p', mount() {} }); throw new Error('half way'); } } },
  });
  await load([{ id: 'a', client: '/ext/a/index.js' }, { id: 'b', client: '/ext/b/index.js' }]);
  assert.deepEqual(slots.contributions('panel.section'), [], 'b\'s partial registration was removed');
  assert.equal(errors.length, 2);
  assert.match(errors[0], /\[ext:a\] failed to load/);
  assert.match(errors[1], /\[ext:b\] failed to load/);
});

test('register receives a registrar bound to the extension id, not the raw slots object', async () => {
  let seen;
  const { slots, load } = harness({ '/ext/a/index.js': { default: { register(reg) { seen = reg; } } } });
  await load([{ id: 'a', client: '/ext/a/index.js' }]);
  assert.notEqual(seen, slots);
  assert.equal(typeof seen.register, 'function');
  assert.equal(seen.register.length, 2, 'register(slotName, contribution) — no extId argument');
  assert.equal(seen.removeExtension, undefined);
});

test('malformed entries are skipped rather than thrown on', async () => {
  const { load, errors } = harness({});
  assert.equal(await load([null, {}, { id: 'a' }, { client: '/x' }]), false);
  assert.equal(await load('not a list'), false);
  assert.deepEqual(errors, []);
});
