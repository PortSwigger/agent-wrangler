import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const source = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
const rename = source.slice(source.indexOf('function beginTaskRename('), source.indexOf('\nfunction fitTaskLinkLists('));
const autoRename = source.slice(source.indexOf('  if (autoEditTaskId) {'), source.indexOf('  scheduleSnoozeWake();', source.indexOf('  if (autoEditTaskId) {')));

function editor({ initial = true, name = 'New task' } = {}) {
  const messages = [], listeners = {};
  const task = { id: 't_new', name, links: [] };
  let focused = false;
  const input = {
    value: name,
    focus() { focused = true; },
    blur() { focused = false; listeners.blur?.(); },
    select() {}, addEventListener(type, fn) { listeners[type] = fn; },
  };
  let editing = false, renders = 0;
  const nameEl = {
    textContent: name,
    set innerHTML(value) { editing = true; },
    querySelector: () => editing ? input : null,
  };
  const cell = { dataset: { taskid: task.id }, querySelector: () => nameEl };
  const scope = {
    latestTasks: { tasks: [task] }, send: (msg) => messages.push(msg),
    renderGrid: () => { renders++; }, esc: (s) => s,
    el: { querySelector: () => cell }, CSS: { escape: (s) => s },
  };
  const open = new Function(...Object.keys(scope), `
    ${rename}
    return (initial, cell) => {
      let autoEditTaskId = initial ? 't_new' : null;
      ${autoRename}
      if (!initial) beginTaskRename(cell);
    };
  `)(...Object.values(scope));
  open(initial, cell);
  return {
    messages, task, input, renders: () => renders, focused: () => focused,
    key(key) { listeners.keydown({ key, preventDefault() {}, stopPropagation() {} }); },
    blur() { listeners.blur(); },
  };
}

for (const value of ['New task', 'Uncommitted name']) {
  test(`Escape in initial task naming permanently deletes the task with input ${JSON.stringify(value)}`, () => {
    const h = editor();
    h.input.value = value;
    h.key('Escape');
    h.blur();
    assert.deepEqual(h.messages, [{ type: 'task-delete', taskId: 't_new', undoCreate: true }]);
    assert.equal(h.focused(), false);
    assert.equal(h.renders(), 1);
  });
}

test('Escape during a later rename keeps an existing task with the default name', () => {
  const h = editor({ initial: false });
  h.input.value = 'Discard this';
  h.key('Escape');
  h.blur();
  assert.deepEqual(h.messages, []);
  assert.equal(h.task.name, 'New task');
});

for (const action of ['Enter', 'blur']) {
  test(`${action} saves the initial task name without deleting it`, () => {
    const h = editor();
    h.input.value = '  My task  ';
    if (action === 'blur') h.blur();
    else h.key(action);
    h.blur();
    assert.deepEqual(h.messages, [{ type: 'task-rename', taskId: 't_new', name: 'My task' }]);
    assert.equal(h.task.name, 'My task');
  });
}

test('accepting the default name keeps the task', () => {
  const h = editor();
  h.key('Enter');
  assert.deepEqual(h.messages, [{ type: 'task-rename', taskId: 't_new', name: 'New task' }]);
  assert.equal(h.task.name, 'New task');
});

function creationFlow() {
  const messages = [], renamed = [];
  const start = source.indexOf('function createTask(');
  const end = source.indexOf('// Turn the "＋ New task"', start);
  assert.ok(start >= 0 && end > start);
  const run = new Function('send', 'beginTaskRename', `
    let latestTasks = { tasks: [] }, autoEditTaskId = null;
    const CSS = { escape: (id) => id };
    const el = { querySelector: (selector) => {
      const task = latestTasks.tasks.find((t) => selector.includes('"' + t.id + '"'));
      return task ? { dataset: { taskid: task.id } } : null;
    } };
    function renderGridIfVisible() { ${autoRename} }
    ${source.slice(start, end)}
    return {
      createTask,
      graph(tasks) {
        latestTasks = { tasks };
        renderGridIfVisible();
      },
      reply: onTaskCreated,
    };
  `)((msg) => messages.push(msg), (cell, isNew) => renamed.push({ taskId: cell.dataset.taskid, isNew }));
  return { ...run, messages, renamed };
}

test('a foreign task appearing after a create request is never opened as our new task', () => {
  const h = creationFlow();
  h.createTask();
  h.graph([{ id: 'foreign' }]);
  assert.deepEqual(h.renamed, []);
  h.reply({ taskId: 'ours' });
  h.graph([{ id: 'foreign' }, { id: 'ours' }]);
  assert.deepEqual(h.renamed, [{ taskId: 'ours', isNew: true }]);
});

test('creation reply opens the exact task even when its graph arrived first', () => {
  const h = creationFlow();
  h.createTask();
  h.graph([{ id: 'foreign' }, { id: 'ours' }]);
  h.reply({ taskId: 'ours' });
  assert.deepEqual(h.renamed, [{ taskId: 'ours', isNew: true }]);
});

test('a failed creation with no success reply never opens a later foreign task', () => {
  const h = creationFlow();
  h.createTask();
  h.graph([]);
  h.graph([{ id: 'foreign' }]);
  assert.deepEqual(h.renamed, []);
});
