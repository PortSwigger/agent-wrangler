import { test } from 'node:test';
import assert from 'node:assert/strict';
import { updateCheckHandler, updateApplyHandler, autoUpdateModeHandler } from './self-update.js';

function ctx(updates) {
  const replies = [];
  return { replies, updates, reply: (o) => replies.push(o), rebuild: async () => {} };
}

test('a check is delegated to the update service, which broadcasts its own status', async () => {
  let checks = 0;
  const c = ctx({ check: async () => { checks += 1; } });
  await updateCheckHandler.handler({}, c);
  assert.equal(checks, 1);
  assert.deepEqual(c.replies, []);
});

test('a failed check or apply replies to the requester with an update error', async () => {
  const failing = { check: async () => { throw new Error('could not fetch'); }, apply: async () => { throw new Error('not supervised'); } };
  const c = ctx(failing);
  await updateCheckHandler.handler({}, c);
  await updateApplyHandler.handler({}, c);
  assert.deepEqual(c.replies, [
    { type: 'update-error', message: 'could not fetch' },
    { type: 'update-error', message: 'not supervised' },
  ]);
});

test('an unknown auto-update mode is refused', async () => {
  await assert.rejects(() => autoUpdateModeHandler.handler({ mode: 'sometimes' }, ctx({})), /Unknown auto-update mode/);
});
