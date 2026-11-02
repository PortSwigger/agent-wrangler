import { test } from 'node:test';
import assert from 'node:assert/strict';
import { composeStatusNotice, formatIdleFor } from './status-notice-format.js';

const caveat = 'These are observations from the board, not messages from the sessions. A session that is idle may be finished, waiting for you, or have stopped early; read its transcript or send_message it before assuming.';
const event = (kind, extra = {}) => ({ kind, child: { sessionId: '123456789', label: 'Child', waitingFor: null, exitOutput: null }, ...extra });

test('formatIdleFor shows seconds, minutes and hours', () => {
  for (const [ms, expected] of [[64000, '1m 04s'], [12000, '12s'], [7380000, '2h 03m'], [0, '0s']]) assert.equal(formatIdleFor(ms), expected);
});

test('composeStatusNotice renders the spec example and caveat', () => {
  const events = [
    event('idle', { idleMs: 64000, child: { sessionId: '3f1a9c2b-more', label: 'Fix flaky board test' } }),
    event('needs-you', { child: { sessionId: '8ab0e1d4-more', label: 'Review PR 412', waitingFor: 'approve the Bash command `rm -rf build/`.' } }),
  ];
  assert.equal(composeStatusNotice(events, new Map([['3f1a9c2b-more', { unread: 0, lastSaid: 'All three tests pass locally; nothing committed yet.' }]])),
    '[Agent Wrangler] Status notice for sessions you spawned\n'
    + '- Fix flaky board test (3f1a9c2b): idle for 1m 04s with no report to you. Unread mail waiting for it: 0. Last said: "All three tests pass locally; nothing committed yet."\n'
    + '- Review PR 412 (8ab0e1d4): needs you — approve the Bash command `rm -rf build/`.\n' + caveat);
});

test('composeStatusNotice omits missing last words and renders every other kind', () => {
  const text = composeStatusNotice([
    event('idle', { idleMs: 60000 }), event('needs-you'), event('exited', { exitReason: 'archived' }),
    event('exited', { exitReason: 'gone' }), event('quiet', { quietMs: 900000 }),
  ], new Map([['123456789', { unread: 2, lastSaid: null }]]));
  assert.ok(text.includes('Unread mail waiting for it: 2.'));
  assert.ok(!text.includes('Last said:'));
  assert.ok(text.includes(': needs you.\n'));
  assert.ok(text.includes(': archived.\n'));
  assert.ok(text.includes(': exited.\n'));
  assert.ok(text.includes(': still working but nothing written for 15m 00s; it may be stuck.\n'));
});

test('exit output is collapsed and clipped', () => {
  const e = event('exited');
  e.child.exitOutput = 'a\nb' + 'x'.repeat(300);
  assert.ok(composeStatusNotice([e], new Map()).includes('Last output: "a b' + 'x'.repeat(197) + '…"'));
});
