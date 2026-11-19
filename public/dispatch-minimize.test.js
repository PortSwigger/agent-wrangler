import assert from 'node:assert/strict';
import { test } from 'node:test';
import { snippet, minimizedSummary, shouldRestoreMinimized, SNIPPET_MAX } from './dispatch-minimize.js';

test('snippet collapses whitespace and truncates with an ellipsis', () => {
  assert.equal(snippet('  fix\n\nthe   bug  '), 'fix the bug');
  assert.equal(snippet(''), '');
  assert.equal(snippet(undefined), '');
  const long = 'a'.repeat(SNIPPET_MAX + 10);
  const out = snippet(long);
  assert.equal(out.length, SNIPPET_MAX);
  assert.ok(out.endsWith('…'));
  assert.equal(snippet('a'.repeat(SNIPPET_MAX)), 'a'.repeat(SNIPPET_MAX));
});

test('minimizedSummary shows the task only when one is picked, and the intent only when typed', () => {
  assert.deepEqual(minimizedSummary({ title: 'Dispatch a new session', taskId: 't1', taskName: 'Widgets', intent: 'Do\nthe thing' }),
    { title: 'Dispatch a new session', task: 'Widgets', intent: 'Do the thing' });
  assert.deepEqual(minimizedSummary({ title: 'Schedule a session', taskId: '', taskName: 'No task', intent: '   ' }),
    { title: 'Schedule a session', task: null, intent: null });
  assert.equal(minimizedSummary({}).title, 'Dispatch a new session');
});

test('shouldRestoreMinimized restores a plain open of the same (or no) task', () => {
  const base = { minimized: true, mode: 'launch', draftTaskId: 't1' };
  assert.equal(shouldRestoreMinimized({ ...base, taskId: null, opts: {} }), true);
  assert.equal(shouldRestoreMinimized({ ...base, taskId: 't1' }), true);
  assert.equal(shouldRestoreMinimized({ ...base, taskId: 't2', opts: {} }), false, 'another task replaces the draft');
  assert.equal(shouldRestoreMinimized({ ...base, taskId: null, opts: { intent: 'x' } }), false, 'a prefilled open replaces it');
  assert.equal(shouldRestoreMinimized({ ...base, minimized: false, taskId: null }), false);
  assert.equal(shouldRestoreMinimized({ ...base, mode: 'schedule-create', taskId: null }), false);
});
