import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stopStatusNoticesTool } from './stop-status-notices.js';

function deps(entries) {
  const cleared = [];
  return {
    cleared,
    d: {
      sessionManager: {
        activeEntries: () => Object.entries(entries).map(([sessionId, v]) => ({ sessionId, ...v })),
        clearStatusNotify: (id) => { cleared.push(id); },
      },
    },
  };
}

const run = (d, caller, args) => stopStatusNoticesTool.handler({ deps: d, caller }, args);

test('stop_status_notices clears the caller\'s subscription by full id', async () => {
  const { d, cleared } = deps({ 'aaaa1111-x': { statusNotify: { to: 'P' } } });
  const out = await run(d, 'P', { session_id: 'aaaa1111-x' });
  assert.deepEqual(out.structuredContent, { session_id: 'aaaa1111-x', notices: 'stopped' });
  assert.deepEqual(cleared, ['aaaa1111-x']);
});

test('stop_status_notices accepts the short id shown in a notice', async () => {
  const { d, cleared } = deps({ 'aaaa1111-x': { statusNotify: { to: 'P' } }, 'bbbb2222-y': { statusNotify: { to: 'P' } } });
  await run(d, 'P', { session_id: 'aaaa1111' });
  assert.deepEqual(cleared, ['aaaa1111-x']);
});

test('stop_status_notices refuses a session subscribed to someone else', async () => {
  const { d, cleared } = deps({ 'aaaa1111-x': { statusNotify: { to: 'OTHER' } } });
  const out = await run(d, 'P', { session_id: 'aaaa1111-x' });
  assert.equal(out.isError, true);
  assert.match(out.content[0].text, /not getting status notices/);
  assert.deepEqual(cleared, []);
});

test('stop_status_notices refuses an ambiguous prefix', async () => {
  const { d, cleared } = deps({ 'aaaa1111-x': { statusNotify: { to: 'P' } }, 'aaaa1111-y': { statusNotify: { to: 'P' } } });
  const out = await run(d, 'P', { session_id: 'aaaa1111' });
  assert.equal(out.isError, true);
  assert.match(out.content[0].text, /more than one/);
  assert.deepEqual(cleared, []);
});

test('stop_status_notices requires a session id and a session caller', async () => {
  const { d } = deps({});
  assert.equal((await run(d, 'P', { session_id: ' ' })).isError, true);
  assert.equal((await run(d, null, { session_id: 'x' })).isError, true);
});
