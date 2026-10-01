import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeOptions } from './select-dd.js';

const opt = (value, textContent, disabled = false) => ({ tagName: 'OPTION', value, textContent, disabled });
const group = (label, children, disabled = false) => ({ tagName: 'OPTGROUP', label, children, disabled });

test('flat options map to rows', () => {
  assert.deepEqual(describeOptions([opt('a', 'A'), opt('b', 'B', true)]), [
    { value: 'a', label: 'A', disabled: false },
    { value: 'b', label: 'B', disabled: true },
  ]);
});

test('an optgroup becomes a heading followed by its options', () => {
  assert.deepEqual(describeOptions([group('Claude', [opt('opus', 'Opus')]), opt('x', 'X')]), [
    { heading: 'Claude' },
    { value: 'opus', label: 'Opus', disabled: false },
    { value: 'x', label: 'X', disabled: false },
  ]);
});

test('a disabled optgroup disables its options', () => {
  assert.equal(describeOptions([group('G', [opt('a', 'A')], true)])[1].disabled, true);
});
