import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keyFor, uniqueKeys, badgeText, targetsKey, frontKey, isOpenModal, BADGE_MAX, ADHOC_ID } from './board-targets.js';

// factsOf reads these off an element; the key is decided from them alone.
const facts = (over = {}) => ({
  tag: 'button', id: '', cls: '', classes: [], data: [], name: '', href: '', role: '', field: false, primary: false,
  rail: false, sid: '', selfSession: false, leadSid: '', subagent: '', taskId: '', railExt: '', label: '', scope: 'board', ...over,
});

test('session cards, team rows and sub-agent rows are keyed by their ids', () => {
  assert.deepEqual(keyFor(facts({ sid: 's1', selfSession: true })), { key: 'session:s1', kind: 'session' });
  assert.deepEqual(keyFor(facts({ leadSid: 'lead' })), { key: 'team:lead', kind: 'session' });
  assert.deepEqual(keyFor(facts({ sid: 's1', subagent: 's1/a7' })), { key: 'subagent:s1/a7', kind: 'session' });
});

test('a task tile\'s New session and ⋯ are keyed by the task and their role', () => {
  const tile = { taskId: 't-42' };
  assert.deepEqual(keyFor(facts({ ...tile, cls: 'task-new-sess', classes: ['task-new-sess'] })), { key: 'task:t-42:new-session', kind: 'task-new-session' });
  assert.deepEqual(keyFor(facts({ ...tile, cls: 'empty-new-sess', classes: ['empty-new-sess', 'selected'] })), { key: 'task:t-42:new-session-row', kind: 'task-new-session' });
  assert.deepEqual(keyFor(facts({ ...tile, cls: 'task-actions-btn', classes: ['task-actions-btn'] })), { key: 'task:t-42:menu', kind: 'task-menu' });
  assert.equal(keyFor(facts({ taskId: ADHOC_ID, classes: ['task-actions-btn'] })).key, 'task:adhoc:menu');
});

test('a button inside a session card is scoped to the card, not the tile', () => {
  const k = keyFor(facts({ taskId: 't1', sid: 's9', cls: 'card-tag', classes: ['card-tag', 'subagent-pill'], data: ['sid=s9'] }));
  assert.equal(k.key, 'session:s9:button.card-tag|sid=s9');
  assert.equal(k.loose, true);
});

test('rail targets are keyed by view, id or extension button', () => {
  assert.deepEqual(keyFor(facts({ rail: true, data: ['view=grid'] })), { key: 'rail:view:grid', kind: 'rail' });
  assert.equal(keyFor(facts({ rail: true, data: ['view=ext:jobs:board'] })).key, 'rail:view:ext:jobs:board');
  assert.equal(keyFor(facts({ rail: true, id: 'new-session' })).key, 'rail:new-session');
  assert.equal(keyFor(facts({ rail: true, railExt: 'voice:mic', data: ['extRail=voice:mic'] })).key, 'rail:ext:voice:mic');
});

test('anything else is keyed by id, else signature, inside its dialog, menu or surface', () => {
  assert.equal(keyFor(facts({ scope: 'dialog:modal', id: 'm-submit', primary: true })).key, 'dialog:modal:#m-submit');
  assert.equal(keyFor(facts({ scope: 'panel', id: 'tab-chat', role: 'tab' })).kind, 'tab');
  assert.equal(keyFor(facts({ scope: 'menu', cls: 'context-menu-item', classes: ['context-menu-item'] })).key, 'menu:button.context-menu-item');
  assert.equal(keyFor(facts({ scope: 'view', tag: 'a', href: 'https://example.com/x' })).key, 'view:a|href=https://example.com/x');
  assert.equal(keyFor(facts({ scope: 'dialog:settings-modal', tag: 'input', field: true, name: 'q' })).kind, 'field');
});

test('uniqueKeys adds the label only to colliding loose keys, then an ordinal', () => {
  const items = [
    { key: 'menu:button.context-menu-item', loose: true, label: 'Rename' },
    { key: 'menu:button.context-menu-item', loose: true, label: 'Archive' },
    { key: 'menu:#only', loose: false, label: 'Only' },
    { key: 'view:button.x', loose: true, label: 'Go' },
    { key: 'view:button.x', loose: true, label: 'Go' },
    { key: 'view:button.solo', loose: true, label: 'Solo' },
  ];
  assert.deepEqual(uniqueKeys(items).map((i) => i.key), [
    'menu:button.context-menu-item|Rename',
    'menu:button.context-menu-item|Archive',
    'menu:#only',
    'view:button.x|Go',
    'view:button.x|Go~2',
    'view:button.solo',
  ]);
});

test('keys stay put when a redraw changes a card\'s text or adds a tile', () => {
  const before = uniqueKeys([
    { ...keyFor(facts({ sid: 'a', selfSession: true })), label: 'busy 3m' },
    { ...keyFor(facts({ taskId: 't1', classes: ['task-new-sess'] })), label: 'New session in this task' },
    { ...keyFor(facts({ taskId: 't1', classes: ['task-actions-btn'] })), label: 'Task actions' },
  ]).map((i) => i.key);
  const after = uniqueKeys([
    { ...keyFor(facts({ taskId: 't0', classes: ['task-new-sess'] })), label: 'New session in this task' },
    { ...keyFor(facts({ taskId: 't0', classes: ['task-actions-btn'] })), label: 'Task actions' },
    { ...keyFor(facts({ sid: 'a', selfSession: true })), label: 'idle 4m' },
    { ...keyFor(facts({ taskId: 't1', classes: ['task-new-sess'] })), label: 'New session in this task' },
    { ...keyFor(facts({ taskId: 't1', classes: ['task-actions-btn'] })), label: 'Task actions' },
  ]).map((i) => i.key);
  for (const k of before) assert.ok(after.includes(k), k);
});

test('badge text is plain, collapsed and capped', () => {
  assert.equal(badgeText('  blue\n  fox '), 'blue fox');
  assert.equal(badgeText(7), '7');
  assert.equal(badgeText({ toString: () => 'x' }), '');
  assert.equal(badgeText(null), '');
  assert.equal(badgeText('x'.repeat(40)).length, BADGE_MAX);
});

test('the change keys ignore rects but not labels or front', () => {
  const t = { key: 'k', kind: 'button', label: 'A', where: 'board', primary: false };
  assert.equal(targetsKey([{ ...t, rect: { x: 1 } }]), targetsKey([{ ...t, rect: { x: 9 } }]));
  assert.notEqual(targetsKey([t]), targetsKey([{ ...t, label: 'B' }]));
  const f = { view: 'grid', ext: null, dialog: null, menu: false, session: null, panel: null };
  assert.notEqual(frontKey(f), frontKey({ ...f, dialog: 'modal' }));
  assert.notEqual(frontKey({ ...f, session: 's1', panel: 'chat' }), frontKey({ ...f, session: 's1', panel: 'terminal' }), 'Chat to Terminal is a front change');
  assert.equal(frontKey(f), frontKey({ ...f }));
});

test('isOpenModal: a div by .hidden, a <dialog> by open', () => {
  const div = (hidden) => ({ tagName: 'DIV', hidden: false, classList: { contains: (c) => c === 'hidden' && hidden } });
  assert.equal(isOpenModal(div(false)), true);
  assert.equal(isOpenModal(div(true)), false);
  assert.equal(isOpenModal({ tagName: 'DIALOG', open: false, id: 'x-modal' }), false);
  assert.equal(isOpenModal({ tagName: 'DIALOG', open: true, id: 'x-modal', matches: () => false }), true);
  assert.equal(isOpenModal({ tagName: 'DIALOG', open: true, id: 'inline', matches: () => false }), false);
  assert.equal(isOpenModal({ tagName: 'DIALOG', open: true, id: '', matches: (s) => s === ':modal' }), true);
});
