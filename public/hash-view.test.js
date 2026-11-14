import test from 'node:test';
import assert from 'node:assert/strict';
import { parseViewHash, viewKeyOf } from './hash-view.js';

test('a bare #view= hash yields the view and no params', () => {
  const p = parseViewHash('#view=ext:hive:main');
  assert.equal(p.view, 'ext:hive:main');
  assert.equal([...p.params].length, 0);
});

test('extra params stay out of the view key and remain readable', () => {
  const p = parseViewHash('#view=ext:hive&cell=cell_1&bead=hive-x');
  assert.equal(p.view, 'ext:hive');
  assert.equal(p.params.get('cell'), 'cell_1');
  assert.equal(p.params.get('bead'), 'hive-x');
});

test('non-view hashes and empty keys are not views', () => {
  assert.equal(parseViewHash('#session=abc'), null);
  assert.equal(parseViewHash(''), null);
  assert.equal(parseViewHash('#view=&cell=1'), null);
});

test('viewKeyOf cuts at the first ampersand', () => {
  assert.equal(viewKeyOf('ext:hive&cell=1'), 'ext:hive');
  assert.equal(viewKeyOf('search'), 'search');
  assert.equal(viewKeyOf(undefined), '');
});
