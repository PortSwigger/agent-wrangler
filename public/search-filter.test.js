import test from 'node:test';
import assert from 'node:assert/strict';
import { closeTaskFilterOnOutsideClick } from './search-filter.js';

test('closeTaskFilterOnOutsideClick closes an open picker only for outside targets', () => {
  const filter = { open: true, contains: (target) => target === 'inside' };
  closeTaskFilterOnOutsideClick(filter, 'inside');
  assert.equal(filter.open, true);
  closeTaskFilterOnOutsideClick(filter, 'outside');
  assert.equal(filter.open, false);
});
