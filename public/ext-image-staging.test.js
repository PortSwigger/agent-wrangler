import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createExtImageStaging } from './ext-image-staging.js';
import { createStagedPreviews } from './staged-previews.js';

const file = (name, type = 'image/png') => ({ name, type, size: 3 });
const frameOf = async () => ({ mime: 'image/png', dataBase64: 'AA==' });

test('stage sends a staged paste-image frame and resolves the server name', async () => {
  const sent = [];
  const s = createExtImageStaging({ send: (m) => { sent.push(m); return true; }, frameOf });
  const p = s.stage(file('a.png'));
  await new Promise((r) => setImmediate(r));
  assert.equal(sent[0].type, 'paste-image');
  assert.equal(sent[0].staged, true);
  assert.equal(s.onResult({ token: sent[0].token, ok: true, name: 'paste-1-aaaa.png' }), true);
  assert.deepEqual(await p, { name: 'paste-1-aaaa.png' });
});

test('stage rejects a non-image, a refused upload and a dead socket', async () => {
  const sent = [];
  const s = createExtImageStaging({ send: (m) => { sent.push(m); return true; }, frameOf });
  await assert.rejects(s.stage(file('notes.txt', 'text/plain')), /notes\.txt is not an image/);
  const p = s.stage(file('a.png'));
  await new Promise((r) => setImmediate(r));
  s.onResult({ token: sent[0].token, ok: false, error: 'Too big' });
  await assert.rejects(p, /Too big/);
  const dead = createExtImageStaging({ send: () => false, frameOf });
  await assert.rejects(dead.stage(file('a.png')), /Not connected/);
});

test('onResult ignores replies that are not its own', () => {
  const s = createExtImageStaging({ send: () => true, frameOf });
  assert.equal(s.onResult({ token: 'dispatch#1#1', ok: true }), false);
});

test('a reply that never comes rejects after the timeout', async () => {
  const s = createExtImageStaging({ send: () => true, frameOf, timeoutMs: 5 });
  await assert.rejects(s.stage(file('a.png')), /did not answer/);
});

test('a staged image is remembered for preview under its minted name; a refused one is not', async () => {
  const sent = [];
  const previews = createStagedPreviews({ createObjectURL: () => 'blob:fake/1', revokeObjectURL: () => {} });
  const s = createExtImageStaging({ send: (m) => { sent.push(m); return true; }, frameOf, previews });
  const ok = s.stage(file('a.png'));
  const bad = s.stage(file('b.png'));
  await new Promise((r) => setImmediate(r));
  s.onResult({ token: sent[0].token, ok: true, name: 'paste-1-aaaa.png' });
  s.onResult({ token: sent[1].token, ok: false, error: 'Too big' });
  await ok;
  await assert.rejects(bad);
  assert.equal(previews.urlFor('paste-1-aaaa.png'), 'blob:fake/1');
  assert.equal(previews.size(), 1);
});
