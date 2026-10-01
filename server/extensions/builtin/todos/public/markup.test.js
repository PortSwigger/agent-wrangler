import { test } from 'node:test';
import assert from 'node:assert/strict';
import { todoRowHtml, todoZoneHtml, esc } from './markup.js';

test('todoRowHtml / todoZoneHtml: rows escape text; empty zone is just the anchor', () => {
  const row = todoRowHtml({ id: 't1', text: '<b>do</b>' }, 'adhoc');
  assert.match(row, /data-todoid="t1"/);
  assert.match(row, /&lt;b&gt;do&lt;\/b&gt;/);
  assert.equal(todoZoneHtml([], 'adhoc'), '<div class="todo-zone" data-todo-key="adhoc"></div>');
  const zone = todoZoneHtml([{ id: 't1', text: 'x' }], 'adhoc');
  assert.match(zone, /todo-divider/);
  assert.match(zone, /data-todoid="t1"/);
});

test('todoRowHtml exposes a details editor for every TODO and marks described rows', () => {
  const plain = todoRowHtml({ id: 'td_1', text: 'Plain' }, 'adhoc');
  const rich = todoRowHtml({ id: 'td_2', text: 'Rich', description: 'Next: test <edge>' }, 'adhoc');
  assert.match(plain, /todo-details/);
  assert.doesNotMatch(plain, /has-description/);
  assert.match(rich, /has-description/);
  assert.doesNotMatch(rich, /Next: test <edge>/);
});

test('todoZoneHtml: the toggle pill shows the todo count, open by default (minus icon, "Hide" title)', () => {
  const zone = todoZoneHtml([{ id: 't1', text: 'a' }, { id: 't2', text: 'b' }], 'adhoc');
  assert.match(zone, /class="card-tag todo-pill"/);
  assert.match(zone, />todo 2</);
  assert.match(zone, /title="Hide TODOs"/);
  assert.match(zone, /todo-toggle-icon/);
  assert.match(zone, /data-todoid="t1"/);
  assert.match(zone, /data-todoid="t2"/);
});

test('todoZoneHtml: collapsed hides the rows but keeps the pill + count + anchor (plus icon, "Show" title)', () => {
  const zone = todoZoneHtml([{ id: 't1', text: 'a' }, { id: 't2', text: 'b' }], 'adhoc', true);
  assert.match(zone, />todo 2</);
  assert.match(zone, /title="Show TODOs"/);
  assert.doesNotMatch(zone, /data-todoid/);
  assert.match(zone, /<div class="todo-zone" data-todo-key="adhoc"><\/div>$/);
});

test('esc escapes the five HTML metacharacters and tolerates null', () => {
  assert.equal(esc('<a href="x">\'&'), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;');
  assert.equal(esc(null), '');
});
