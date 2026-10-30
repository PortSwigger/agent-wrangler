import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSlots } from './slots.js';
import { pruneMinimised, visibleTileIds } from './layout.js';

const source = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
function declaration(name) {
  const head = `function ${name}(`;
  const start = source.indexOf(head);
  assert.ok(start >= 0, `${name} is defined`);
  const body = source.indexOf('{', start);
  let depth = 0;
  for (let i = body; i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw Error(`Unbalanced ${name}`);
}

function harness() {
  let order = ['b', '__adhoc__', 'a'];
  const renders = [], writes = [];
  const scope = { currentOrder: () => order, pruneMinimised, visibleTileIds,
    renderGrid: () => renders.push(true), localStorage: { setItem: (key, value) => writes.push(JSON.parse(value)) } };
  const api = new Function(...Object.keys(scope), `
    let minimisedIds = new Set(['a']); const MIN_KEY = 'test';
    ${['persistMinimised', 'setMinimisedTasks', 'focusOnly', 'unminimise', 'restoreAll'].map(declaration).join('\n')}
    return { setMinimisedTasks, focusOnly, unminimise, restoreAll, ids: () => [...minimisedIds] };
  `)(...Object.values(scope));
  return { ...api, renders, writes, order: (ids) => { order = ids; } };
}

test('bulk minimisation replaces atomically, renders once and prunes non-live ids', () => {
  const h = harness();
  assert.equal(h.setMinimisedTasks(['b', 'b', 'archived', '__adhoc__']), true);
  assert.deepEqual(h.ids(), ['b', '__adhoc__']);
  assert.equal(h.renders.length, 1);
  assert.deepEqual(h.writes, [['b', '__adhoc__']]);
});

test('bulk minimisation refuses to empty the live board without partial changes', () => {
  const h = harness();
  assert.equal(h.setMinimisedTasks(['a', 'b', '__adhoc__']), false);
  assert.deepEqual(h.ids(), ['a']);
  assert.equal(h.renders.length, 0);
  assert.deepEqual(h.writes, []);
});

test('bulk minimisation accepts unchanged sets without rendering and rejects malformed input', () => {
  const h = harness();
  assert.equal(h.setMinimisedTasks(['a', 'deleted']), true);
  for (const ids of [null, ['b', 1], ['']]) assert.equal(h.setMinimisedTasks(ids), false);
  assert.equal(h.renders.length, 0);
});

test('new tasks stay visible, while Focus, open-task restore and Restore all remain authoritative', () => {
  const h = harness();
  h.setMinimisedTasks(['b', '__adhoc__']);
  h.order(['b', '__adhoc__', 'a', 'new']);
  assert.deepEqual(visibleTileIds(['b', '__adhoc__', 'a', 'new'], new Set(h.ids())), ['a', 'new']);
  h.focusOnly('__adhoc__');
  assert.deepEqual(h.ids(), ['b', 'a', 'new']);
  h.unminimise('a');
  assert.deepEqual(h.ids(), ['b', 'new']);
  h.restoreAll();
  assert.deepEqual(h.ids(), []);
});

test('tray read model follows live display order, includes Unassigned and drops archived tasks', () => {
  const scope = { latestTasks: { tasks: [{ id: 'a', name: 'Alpha' }, { id: 'gone', name: 'Old', archivedAt: 1 }, { id: 'b', name: 'Beta' }], order: ['b', 'gone', 'adhoc', 'a'] } };
  const read = new Function('latestTasks', `const ADHOC_ID = 'adhoc'; let minimisedIds = new Set(['a']);
    ${declaration('currentOrder')}
    ${declaration('trayContext')}
    return trayContext;
  `)(scope.latestTasks);
  assert.deepEqual(read(), { tasks: [
    { id: 'b', name: 'Beta', adhoc: false }, { id: 'adhoc', name: 'Unassigned', adhoc: true }, { id: 'a', name: 'Alpha', adhoc: false },
  ], minimisedIds: ['a'] });
  scope.latestTasks.tasks.push({ id: 'new', name: 'New' });
  assert.equal(read().tasks.at(-1).id, 'new');
});

for (const adhoc of [false, true]) test(`both task menus preserve extension actions and guards for ${adhoc ? 'Unassigned' : 'a named task'}`, () => {
  let replacement = true, items;
  const subjects = [];
  const invoked = [];
  const slots = createSlots({});
  slots.forExtension('task-tints', {}).register('task.action', {
    id: 'colour', items: (task) => { subjects.push(task); return [{ label: 'Colour…', run: () => { invoked.push(task.id); } }]; },
  });
  slots.forExtension('task-memory', {}).register('task.action', {
    id: 'memory', items: (task) => task.adhoc ? [] : [{ label: 'Memory…', run() {} }],
  });
  slots.forExtension('minimise-task', {}).register('task.action', {
    id: 'minimise', items: () => [{ label: 'Minimise', run() {} }],
  });
  slots.trayMinimiseItem = (task) => replacement ? { label: 'Manage profiles…', run: () => task.id } : null;
  const id = adhoc ? 'adhoc' : 'a';
  const scope = {
    ADHOC_ID: 'adhoc', latestTasks: { tasks: [{ id: 'a', name: 'Alpha' }] }, latestGraph: {}, extApi: {},
    activitySortedTasks: new Set(), slots,
    mountMenu: (value) => { items = value; },
    FOCUS_ICON: '', MINIMISE_ICON: '', SORT_ICON: '', CHECK_ICON: '', ARCHIVE_ICON: '', TERMINAL_ICON: '', PENCIL_ICON: '',
    focusOnly() {}, minimise() {},
  };
  const menus = new Function(...Object.keys(scope), `
    ${['extTaskMenuItems', 'taskMinimiseMenuItem', 'openTaskActionsMenu', 'openTaskMenu'].map(declaration).join('\n')}
    return { openTaskActionsMenu, openTaskMenu };
  `)(...Object.values(scope));
  const open = [() => menus.openTaskActionsMenu(id, 0, 0), () => menus.openTaskMenu({ dataset: { taskid: id, entity: adhoc ? 'no-task' : 'task' } }, 0, 0)];
  for (const menu of open) {
    menu();
    assert.ok(items.find((x) => x.label === 'Colour…'));
    items.find((x) => x.label === 'Colour…').run();
    assert.equal(invoked.at(-1), id);
    assert.deepEqual(subjects.at(-1), { id, name: adhoc ? null : 'Alpha', adhoc });
    assert.equal(items.some((x) => x.label === 'Memory…'), !adhoc);
    assert.equal(items.some((x) => x.label === 'Archive task'), !adhoc);
    assert.equal(items.some((x) => x.label === 'Minimise'), false);
    assert.ok(!items[0].sep && !items.at(-1).sep);
    assert.ok(items.every((item, i) => !item.sep || !items[i - 1]?.sep));
    assert.equal(items.find((x) => x.label === 'Manage profiles…').run(), id);
  }
  open[0]();
  assert.ok(items.some((x) => x.label === 'Focus'));
  assert.ok(items.some((x) => x.label === 'Sort by activity'));
  replacement = false;
  for (const menu of open) { menu(); assert.equal(items.filter((x) => x.label === 'Minimise').length, 1); }
  slots.removeExtension('task-tints');
  slots.removeExtension('task-memory');
  slots.removeExtension('minimise-task');
  for (const menu of open) {
    menu();
    assert.ok(!items.at(-1).sep);
    assert.ok(items.every((item, i) => !item.sep || !items[i - 1]?.sep));
  }
});

test('housekeeping clears stale ids and restores all when the last visible task disappears', () => {
  const writes = [];
  const reconcile = new Function('pruneMinimised', 'localStorage', `
    let minimisedIds = new Set(['a', 'archived']), legacyFocusedId = null;
    const MIN_KEY = 'test';
    ${declaration('persistMinimised')}
    ${declaration('reconcileMinimised')}
    return (order) => { reconcileMinimised(order); return [...minimisedIds]; };
  `)(pruneMinimised, { setItem: (key, value) => writes.push(JSON.parse(value)) });
  assert.deepEqual(reconcile(['a', 'b']), ['a']);
  assert.deepEqual(reconcile(['a']), []);
  assert.deepEqual(writes, [['a'], []]);
});

test('blank task-view menu keeps New task and adds only the tray owner action', () => {
  let owner = true, items, created = 0, managed = 0;
  const scope = {
    slots: { trayBackgroundItem: () => owner ? { label: 'Manage profiles…', run: () => { managed++; } } : null },
    latestGraph: {}, extApi: {}, PLUS_ICON: '',
    mountMenu: (value) => { items = value; }, createTask: () => { created++; },
  };
  const open = new Function(...Object.keys(scope), `${declaration('openTaskViewMenu')}; return openTaskViewMenu;`)(...Object.values(scope));
  open(10, 20);
  assert.deepEqual(items.map((it) => it.label), ['New task', 'Manage profiles…']);
  items[0].run();
  items[1].run();
  assert.equal(created, 1);
  assert.equal(managed, 1);
  owner = false;
  open(10, 20);
  assert.deepEqual(items.map((it) => it.label), ['New task']);
});
