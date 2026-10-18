import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStagedPreviews, frameToBlob } from './staged-previews.js';

function fakeUrls() {
  let n = 0;
  const revoked = [];
  return {
    revoked,
    createObjectURL: () => `blob:fake/${++n}`,
    revokeObjectURL: (u) => revoked.push(u),
  };
}
const blob = () => new Blob([new Uint8Array([1])], { type: 'image/png' });

test('remember, urlFor and forget, which revokes', () => {
  const u = fakeUrls();
  const p = createStagedPreviews(u);
  assert.equal(p.urlFor('paste-1-aaaa.png'), null);
  p.remember('paste-1-aaaa.png', blob());
  assert.equal(p.urlFor('paste-1-aaaa.png'), 'blob:fake/1');
  p.forget('paste-1-aaaa.png');
  assert.equal(p.urlFor('paste-1-aaaa.png'), null);
  assert.deepEqual(u.revoked, ['blob:fake/1']);
  p.forget('paste-1-aaaa.png');
  assert.deepEqual(u.revoked, ['blob:fake/1'], 'forgetting twice revokes once');
});

test('remembering a name again replaces and revokes the old URL; no blob is a no-op', () => {
  const u = fakeUrls();
  const p = createStagedPreviews(u);
  p.remember('a', blob());
  p.remember('a', blob());
  assert.equal(p.urlFor('a'), 'blob:fake/2');
  assert.deepEqual(u.revoked, ['blob:fake/1']);
  p.remember('b', null);
  assert.equal(p.urlFor('b'), null);
  assert.equal(p.size(), 1);
});

test('past the bound the oldest entry is evicted and revoked', () => {
  const u = fakeUrls();
  const p = createStagedPreviews({ ...u, max: 3 });
  for (const name of ['a', 'b', 'c', 'd', 'e']) p.remember(name, blob());
  assert.equal(p.size(), 3);
  assert.equal(p.urlFor('a'), null);
  assert.equal(p.urlFor('b'), null);
  assert.equal(p.urlFor('e'), 'blob:fake/5');
  assert.deepEqual(u.revoked, ['blob:fake/1', 'blob:fake/2']);
});

test('the default bound is 32', () => {
  const u = fakeUrls();
  const p = createStagedPreviews(u);
  for (let i = 0; i < 40; i++) p.remember(`n${i}`, blob());
  assert.equal(p.size(), 32);
  assert.equal(u.revoked.length, 8);
});

test('frameToBlob decodes a drawable frame and refuses formats the browser cannot draw', async () => {
  const b = frameToBlob({ mime: 'image/png', dataBase64: 'AQID' });
  assert.equal(b.type, 'image/png');
  assert.deepEqual([...new Uint8Array(await b.arrayBuffer())], [1, 2, 3]);
  assert.equal(frameToBlob({ mime: 'image/heic', dataBase64: 'AQID' }), null);
  assert.equal(frameToBlob({ mime: 'image/tiff', dataBase64: 'AQID' }), null);
  assert.equal(frameToBlob(null), null);
});
