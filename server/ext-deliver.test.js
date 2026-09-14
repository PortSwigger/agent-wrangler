import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createExtDeliver } from './ext-deliver.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function harness(result = { mode: 'live' }) {
  const calls = [];
  const deps = { sessionManager: 'SM', memoryStore: 'MS', taskStore: 'TS', tmuxFor: 'T', socketFor: 'S' };
  const deliver = createExtDeliver(deps, {
    deliverMessage: (id, text, d, opts) => { calls.push({ id, text, d, opts }); return result; },
  });
  return { deliver, calls, deps };
}

test('deliver hands the text to deliverMessage with the bound deps and its own resume reason', async () => {
  const { deliver, calls, deps } = harness({ mode: 'dormant' });
  assert.deepEqual(await deliver('c1', 'ping'), { mode: 'dormant' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].id, 'c1');
  assert.equal(calls[0].text, 'ping');
  assert.equal(calls[0].d, deps, 'the same bound deps object, not a copy built per call');
  // reason=extension, never 'message': the resume log line names what woke a card,
  // and an extension's delivery must not read as a human pressing send.
  assert.equal(calls[0].opts.reason, 'extension');
});

test('an extension cannot pass imagePaths or clearComposer through — the signature is the access control', async () => {
  const { deliver, calls } = harness();
  await deliver('c1', 'ping', { imagePaths: ['/etc/passwd'], clearComposer: true, reason: 'message' });
  assert.deepEqual(calls[0].opts, { reason: 'extension' });
  assert.equal(deliver.length, 2, 'two parameters, so a third argument has nowhere to land');
});

test('a missing card id or empty text is an error result, not a throw or a blank paste', async () => {
  const { deliver, calls } = harness();
  for (const bad of [undefined, null, '', 42, {}]) {
    const r = await deliver(bad, 'ping');
    assert.equal(r.mode, 'error');
    assert.match(r.error, /sessionId must be a card id/);
  }
  for (const bad of [undefined, null, '', '   ', '\n', 42]) {
    const r = await deliver('c1', bad);
    assert.equal(r.mode, 'error');
    assert.match(r.error, /text must be a non-empty string/);
  }
  assert.deepEqual(calls, [], 'nothing reached the pane');
});

test("deliverMessage's own refusals come back untouched", async () => {
  const { deliver } = harness({ mode: 'error', error: 'Session c1 is archived; messaging an archived session isn\'t supported.' });
  assert.deepEqual(await deliver('c1', 'ping'), { mode: 'error', error: 'Session c1 is archived; messaging an archived session isn\'t supported.' });
});

// Nothing lints a capability into existence: a `deliver` an extension declared
// but index.js never bound is something its tool can only discover as
// `undefined` at run time, in production. Same class of invisible-wiring guard as
// client-config.test.js's tool-pair assertion — and it is now PER EXTENSION, so
// what matters is that the facade's deliver carries that extension's own reason.
test('index.js binds deliver per extension, with the extension id as the resume reason', () => {
  const src = fs.readFileSync(path.join(HERE, 'index.js'), 'utf8');
  assert.match(src, /deliver: createExtDeliver\(\{[^}]*sessionManager[^}]*tmuxFor[^}]*\}, \{ reason: `ext:\$\{e\.id\}` \}\)/);
  assert.doesNotMatch(src, /deliver: extDeliver/, 'the one shared deliver is gone');
});
