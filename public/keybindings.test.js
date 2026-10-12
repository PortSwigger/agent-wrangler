import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createKeybindings, parseCombo, SCOPES } from './keybindings.js';
import { CORE_BINDINGS, registerCoreBindings } from './core-keybindings.js';
import { shortcutsHtml } from './shortcuts.js';

const ev = (key, mods = {}) => ({
  key, code: mods.code, metaKey: !!mods.meta, ctrlKey: !!mods.ctrl, shiftKey: !!mods.shift, altKey: !!mods.alt,
  prevented: 0, stopped: 0,
  preventDefault() { this.prevented += 1; },
  stopPropagation() { this.stopped += 1; },
});

function reg(opts = {}) {
  const errors = [];
  const k = createKeybindings({ mac: opts.mac ?? true });
  k.configure({ onError: (msg) => errors.push(String(msg)), ...opts.state });
  return { k, errors };
}

test('parseCombo understands modifiers and named keys, and throws on unknown tokens', () => {
  assert.deepEqual(parseCombo('Ctrl+Cmd+N'), { key: 'n', mod: false, meta: true, ctrl: true, shift: false, alt: false });
  assert.equal(parseCombo('mod+enter').mod, true);
  assert.equal(parseCombo('shift+cmd+left').key, 'left');
  for (const k of ['escape', 'backspace', 'delete', 'space', 'up', 'down', 'right', '/', '1', ',']) assert.ok(parseCombo(k).key);
  assert.throws(() => parseCombo('hyper+k'), /unknown modifier "hyper"/);
  assert.throws(() => parseCombo('ctrl+pageup'), /unknown key "pageup"/);
  assert.throws(() => parseCombo(''), /invalid key combo/);
});

test('formatCombo: ⌃⌥⇧⌘ order on Mac, Ctrl+… elsewhere; mod follows the platform', () => {
  const mac = createKeybindings({ mac: true });
  assert.equal(mac.formatCombo('cmd+shift+alt+ctrl+k'), '⌃⌥⇧⌘K');
  assert.equal(mac.formatCombo('mod+enter'), '⌘Enter');
  assert.equal(mac.formatCombo('ctrl+cmd+backspace'), '⌃⌘⌫');
  assert.equal(mac.formatCombo('shift+cmd+left'), '⇧⌘←');
  const pc = createKeybindings({ mac: false });
  assert.equal(pc.formatCombo('mod+shift+k'), 'Ctrl+Shift+K');
  assert.equal(pc.formatCombo('alt+left'), 'Alt+Left');
  assert.equal(pc.formatCombo('/'), '/');
});

test('matches is exact on modifiers, case-insensitive on key, and falls back to e.code under Alt/Shift', () => {
  const { k } = reg();
  assert.ok(k.matches(parseCombo('ctrl+cmd+n'), ev('N', { meta: true, ctrl: true })));
  assert.ok(!k.matches(parseCombo('ctrl+cmd+n'), ev('n', { meta: true })));
  assert.ok(!k.matches(parseCombo('cmd+n'), ev('n', { meta: true, ctrl: true })));
  assert.ok(k.matches(parseCombo('alt+n'), ev('˜', { alt: true, code: 'KeyN' })));
  assert.ok(k.matches(parseCombo('shift+mod+1'), ev('!', { meta: true, shift: true, code: 'Digit1' })));
  assert.ok(k.matches(parseCombo('shift+cmd+left'), ev('ArrowLeft', { meta: true, shift: true })));
  // "/" may need Shift on some layouts; a punctuation combo without shift ignores it.
  assert.ok(k.matches(parseCombo('/'), ev('/', { shift: true })));
  const pc = createKeybindings({ mac: false });
  assert.ok(pc.matches(parseCombo('mod+enter'), ev('Enter', { ctrl: true })));
  assert.ok(!pc.matches(parseCombo('mod+enter'), ev('Enter', { meta: true })));
});

test('register validates scope, combo and handlers', () => {
  const { k } = reg();
  assert.deepEqual(SCOPES, ['dispatch', 'modal', 'board', 'global']);
  assert.throws(() => k.register({ id: 'x', combo: 'a', scope: 'nowhere' }), /scope must be one of/);
  assert.throws(() => k.register({ id: 'x', combo: 'zz', scope: 'global' }), /unknown key "zz"/);
  assert.throws(() => k.register({ id: 'x', combo: 'a', scope: 'global', run: 'no' }), /run must be a function/);
  assert.throws(() => k.register({ combo: 'a', scope: 'global' }), /needs an id/);
});

test('resolveScope: dispatch > modal > board > global', () => {
  const matrix = [
    [{ d: true, m: true, b: true }, 'dispatch'],
    [{ d: false, m: true, b: true }, 'modal'],
    [{ d: false, m: false, b: true }, 'board'],
    [{ d: false, m: false, b: false }, 'global'],
  ];
  for (const [s, want] of matrix) {
    const { k } = reg({ state: { isDispatchOpen: () => s.d, isModalOpen: () => s.m, isBoardIdle: () => s.b } });
    assert.equal(k.resolveScope(), want);
  }
});

test('dispatch runs the active scope, then global; when() gates; display-only entries never run', () => {
  let scope = 'board';
  const { k } = reg({ state: { isBoardIdle: () => scope === 'board', isModalOpen: () => scope === 'modal' } });
  const ran = [];
  let allowed = false;
  k.register({ id: 'b', combo: 'enter', scope: 'board', run: () => ran.push('board') });
  k.register({ id: 'g', combo: 'ctrl+cmd+n', scope: 'global', when: () => allowed, run: () => ran.push('global') });
  k.register({ id: 'shown', combo: 'escape', scope: 'global', description: 'display only' });
  const e = ev('Enter');
  assert.equal(k.dispatch(e), true);
  assert.equal(e.prevented, 1);
  assert.equal(e.stopped, 1);
  scope = 'modal';
  assert.equal(k.dispatch(ev('Enter')), false, 'board binding inactive behind a modal');
  assert.equal(k.dispatch(ev('n', { meta: true, ctrl: true })), false, 'when() said no');
  allowed = true;
  assert.equal(k.dispatch(ev('n', { meta: true, ctrl: true })), true, 'global is checked from any scope');
  assert.equal(k.dispatch(ev('Escape')), false);
  assert.deepEqual(ran, ['board', 'global']);
});

test('capture and bubble bindings only run on their own phase; preventAlways prevents even when when() fails', () => {
  const { k } = reg();
  const ran = [];
  k.register({ id: 'c', combo: 'ctrl+cmd+g', scope: 'global', capture: true, preventAlways: true, when: () => false, run: () => ran.push('c') });
  k.register({ id: 'b', combo: '/', scope: 'global', run: () => ran.push('b') });
  const g = ev('g', { meta: true, ctrl: true });
  assert.equal(k.dispatch(g, { capture: true }), false);
  assert.equal(g.prevented, 1);
  assert.equal(k.dispatch(ev('/'), { capture: true }), false);
  assert.equal(k.dispatch(ev('/')), true);
  assert.deepEqual(ran, ['b']);
});

test('extension bindings win over core in the same scope; a failing extension when() falls through to core', () => {
  const { k } = reg();
  const ran = [];
  let extWants = true;
  k.register({ id: 'core', combo: 'ctrl+cmd+k', scope: 'global', run: () => ran.push('core') });
  k.register({ id: 'ext', combo: 'ctrl+cmd+k', scope: 'global', owner: 'ql', when: () => extWants, run: () => ran.push('ext') });
  k.dispatch(ev('k', { meta: true, ctrl: true }));
  extWants = false;
  k.dispatch(ev('k', { meta: true, ctrl: true }));
  assert.deepEqual(ran, ['ext', 'core']);
});

test('a second extension binding the same combo+scope is dropped and reported; the first keeps it', () => {
  const { k, errors } = reg();
  const ran = [];
  k.register({ id: 'a', combo: 'ctrl+cmd+k', scope: 'global', owner: 'one', run: () => ran.push('one') });
  const off = k.register({ id: 'b', combo: 'ctrl+cmd+k', scope: 'global', owner: 'two', run: () => ran.push('two') });
  assert.equal(typeof off, 'function');
  assert.match(errors.at(-1), /\[ext:two\] keybinding "ctrl\+cmd\+k" \(global\) ignored: already bound by extension one/);
  // A different scope is not a collision.
  k.register({ id: 'c', combo: 'ctrl+cmd+k', scope: 'dispatch', owner: 'two', run: () => ran.push('two-d') });
  k.dispatch(ev('k', { meta: true, ctrl: true }));
  assert.deepEqual(ran, ['one']);
});

test('a throwing extension run is reported and the binding kept', () => {
  const { k, errors } = reg();
  let calls = 0;
  k.register({ id: 'boom', combo: 'ctrl+cmd+k', scope: 'global', owner: 'ql', run: () => { calls += 1; throw new Error('nope'); } });
  assert.equal(k.dispatch(ev('k', { meta: true, ctrl: true })), true);
  assert.match(errors.at(-1), /\[ext:ql\] keybinding boom run threw/);
  k.dispatch(ev('k', { meta: true, ctrl: true }));
  assert.equal(calls, 2);
});

test('unregister removes the binding and notifies subscribers', () => {
  const { k } = reg();
  let changes = 0;
  k.subscribe(() => { changes += 1; });
  const off = k.register({ id: 'x', combo: 'ctrl+cmd+k', scope: 'global', run: () => {} });
  off();
  off();
  assert.equal(changes, 2);
  assert.equal(k.dispatch(ev('k', { meta: true, ctrl: true })), false);
});

test('describe: core groups in fixed order, then one group per extension; hidden entries omitted', () => {
  const { k } = reg();
  k.register({ id: 't', combo: 'cmd+backspace', scope: 'global', group: 'Terminal', description: 'Clear' });
  k.register({ id: 'e', combo: 'ctrl+cmd+k', scope: 'global', owner: 'ql', ownerLabel: 'Quick launch', run: () => {}, description: 'Launch' });
  k.register({ id: 'b', combo: 'enter', scope: 'board', group: 'Board', description: 'Open' });
  k.register({ id: 'h', combo: 'enter', scope: 'board', group: 'Board', description: 'secret', hidden: true });
  assert.deepEqual(k.describe(), [
    { group: 'Board', owner: 'core', rows: [{ keys: 'Enter', description: 'Open' }] },
    { group: 'Terminal', owner: 'core', rows: [{ keys: '⌘⌫', description: 'Clear' }] },
    { group: 'Quick launch', owner: 'ql', rows: [{ keys: '⌃⌘K', description: 'Launch' }] },
  ]);
});

// Every row of the hand-maintained SHORTCUTS table this registry replaced must
// still be listed — the regression net for the Shortcuts tab.
const OLD_SHORTCUTS = [
  ['Board', 'Switch task / session (axes flip with "Flip navigating task / session hotkeys")'],
  ['Board', 'Open the dispatch dialog for the selected new-session slot'],
  ['Board', 'New session'],
  ['Board', 'Toggle a shell terminal in the selected session'],
  ['Board', 'Fork (branch) the selected session'],
  ['Board', 'Restart the selected session'],
  ['Board', 'Peer review the selected session'],
  ['Board', 'Maximize / restore the panel'],
  ['Board', 'Snooze / unsnooze the selected session'],
  ['Board', 'Toggle the working-tree diff panel'],
  ['Board', 'Jump to any session: label every card with a letter, then type it'],
  ['Board', 'Open Settings'],
  ['Board', 'Archive the selected session'],
  ['Board', 'Close the open dialog or panel'],
  ['Search', 'Open the Search view and focus its input'],
  ['Diff panel', 'Send all draft comments to the agent'],
  ['Diff panel', 'Close the comment editor, then the panel'],
  ['Terminal', 'Send a literal Alt+Enter to the agent'],
  ['Terminal', 'Move cursor by word'],
  ['Terminal', 'Clear the current line'],
];

test('core bindings list every row of the old static Shortcuts table', () => {
  const { k } = reg();
  registerCoreBindings(k);
  const groups = k.describe();
  for (const [group, desc] of OLD_SHORTCUTS) {
    const g = groups.find((x) => x.group === group);
    assert.ok(g, `group ${group}`);
    const row = g.rows.find((r) => r.description === desc);
    assert.ok(row, `${group}: ${desc}`);
    assert.ok(row.keys, `${desc} has keys`);
  }
  assert.deepEqual(groups.map((g) => g.group), ['Board', 'Search', 'Dispatch dialog', 'Diff panel', 'Terminal']);
  assert.equal(new Set(CORE_BINDINGS.map((b) => b.id)).size, CORE_BINDINGS.length, 'ids are unique');
});

test('registerCoreBindings wires handlers by id and unregisters them all', () => {
  const { k } = reg();
  let n = 0;
  const off = registerCoreBindings(k, { 'chord.new': { run: () => { n += 1; } } });
  assert.equal(k.dispatch(ev('n', { meta: true, ctrl: true }), { capture: true }), true);
  assert.equal(n, 1);
  off();
  assert.deepEqual(k.describe(), []);
});

test('shortcutsHtml renders describe() with the existing markup, escaped', () => {
  const { k } = reg();
  k.register({ id: 'x', combo: 'ctrl+cmd+k', scope: 'global', owner: 'ql', ownerLabel: '<Q>', run: () => {}, description: 'a & b' });
  const html = shortcutsHtml(k);
  assert.match(html, /<div class="shortcuts-group-title">&lt;Q&gt;<\/div>/);
  assert.match(html, /<span class="shortcut-desc">a &amp; b<\/span>/);
  assert.match(html, /<span class="shortcut-keys">⌃⌘K<\/span>/);
});
