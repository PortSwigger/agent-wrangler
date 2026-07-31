import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TerminalRegistry } from './terminal-registry.js';

test('set / get / remove lifecycle', () => {
  const reg = new TerminalRegistry();
  const entry = { tmuxName: 'sh_ab12', socket: 'aw-sock', cwd: '/tmp/foo' };
  reg.set('t_0001', entry);
  assert.deepEqual(reg.get('t_0001'), entry);
  assert.equal(reg.remove('t_0001'), true);
  assert.equal(reg.get('t_0001'), null);
});

test('get on missing id returns null', () => {
  const reg = new TerminalRegistry();
  assert.equal(reg.get('nope'), null);
});

test('remove on missing id returns false', () => {
  const reg = new TerminalRegistry();
  assert.equal(reg.remove('nope'), false);
});

test('multiple entries are independent', () => {
  const reg = new TerminalRegistry();
  reg.set('t_a', { tmuxName: 'sh_aa', socket: 's1', cwd: '/a' });
  reg.set('t_b', { tmuxName: 'sh_bb', socket: 's2', cwd: '/b' });
  reg.remove('t_a');
  assert.equal(reg.get('t_a'), null);
  assert.equal(reg.get('t_b')?.tmuxName, 'sh_bb');
});
