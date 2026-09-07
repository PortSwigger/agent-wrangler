import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupChatEvents, activityLabel } from './chat-group.js';

const tool = (name, target, extra = {}) => ({ kind: 'tool', name, target, ok: true, ts: 1, ...extra });
const say = (text) => ({ kind: 'assistant', text, ts: 1 });

test('a run of consecutive tool events collapses into one activity item', () => {
  const items = groupChatEvents([
    say('checking'),
    tool('Read', '/a.js'), tool('Read', '/b.js'), tool('Grep', 'settleKey'),
    say('done'),
  ]);
  assert.deepEqual(items.map((i) => i.type), ['assistant', 'activity', 'assistant']);
  assert.equal(items[1].tools.length, 3);
});

test('prose between two tool runs splits them into separate activity items', () => {
  const items = groupChatEvents([tool('Read', '/a.js'), say('hm'), tool('Read', '/b.js')]);
  assert.deepEqual(items.map((i) => i.type), ['activity', 'assistant', 'activity']);
});

test('a lone tool call still becomes an activity item', () => {
  const items = groupChatEvents([tool('Bash', 'npm test')]);
  assert.deepEqual(items.map((i) => i.type), ['activity']);
  assert.equal(items[0].tools.length, 1);
});

test('activityLabel counts by verb class', () => {
  assert.equal(activityLabel([tool('Read', '/a'), tool('Read', '/b'), tool('Grep', 'x')]), 'Read 2 files, 1 search');
  assert.equal(activityLabel([tool('Edit', '/a')]), 'Edited 1 file');
  assert.equal(activityLabel([tool('Bash', 'ls'), tool('Bash', 'pwd')]), 'Ran 2 commands');
});

test('an edit run rolls up its +/- counts', () => {
  const items = groupChatEvents([
    tool('Edit', '/a.js', { adds: 8, dels: 1 }),
    tool('Write', '/b.js', { adds: 3, dels: 1 }),
  ]);
  assert.equal(items[0].adds, 11);
  assert.equal(items[0].dels, 2);
});

test('non-tool events pass through in order, each as its own item', () => {
  const items = groupChatEvents([
    { kind: 'user', text: 'go', ts: 1 },
    { kind: 'thinking', ts: 2, durationMs: 6000 },
    { kind: 'subagent', id: 'tu_1', name: 'Explore', ts: 3 },
    { kind: 'notice', noticeKind: 'denied', text: 'git push', ts: 4 },
  ]);
  assert.deepEqual(items.map((i) => i.type), ['user', 'thinking', 'subagent', 'notice']);
});
