import test from 'node:test';
import assert from 'node:assert/strict';
import { decodePasteImage, pasteFileName, prunePastes, MAX_PASTE_BYTES, PASTE_TTL_MS } from './paste-image.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const b64 = (buf) => buf.toString('base64');

test('decodePasteImage: accepts a real PNG and reports its extension', () => {
  const r = decodePasteImage({ mime: 'image/png', dataBase64: b64(PNG) });
  assert.equal(r.ext, 'png');
  assert.deepEqual(r.bytes, PNG);
});

test('decodePasteImage: mime is matched case-insensitively and trimmed (browsers vary)', () => {
  assert.equal(decodePasteImage({ mime: ' IMAGE/PNG ', dataBase64: b64(PNG) }).ext, 'png');
});

test('decodePasteImage: refuses a mime outside the allowlist', () => {
  const r = decodePasteImage({ mime: 'image/svg+xml', dataBase64: b64(PNG) });
  assert.match(r.error, /PNG, JPEG, GIF and WebP/);
  assert.equal(r.bytes, undefined);
});

test('decodePasteImage: refuses bytes that do not match the claimed mime rather than renaming them', () => {
  // A JPEG announced as a PNG. Silently writing it as .png is exactly the guess
  // that leaves the agent a file it cannot read.
  const r = decodePasteImage({ mime: 'image/png', dataBase64: b64(JPG) });
  assert.match(r.error, /JPG, not a PNG/);
});

test('decodePasteImage: refuses a payload that is not an image at all', () => {
  const r = decodePasteImage({ mime: 'image/png', dataBase64: b64(Buffer.from('#!/bin/sh\nrm -rf /')) });
  assert.match(r.error, /does not look like an image/);
});

test('decodePasteImage: refuses an empty payload', () => {
  assert.match(decodePasteImage({ mime: 'image/png', dataBase64: '' }).error, /empty/);
  assert.match(decodePasteImage({ mime: 'image/png' }).error, /empty/);
});

test('decodePasteImage: refuses an oversized payload from its base64 LENGTH, before decoding it', () => {
  // 4/3 of the cap, so the length check alone must catch it — this asserts the
  // oversized frame is never materialised as a Buffer.
  const huge = 'A'.repeat(Math.ceil((MAX_PASTE_BYTES + 1024) * 4 / 3));
  assert.match(decodePasteImage({ mime: 'image/png', dataBase64: huge }).error, /over 10 MB/);
});

test('decodePasteImage: recognises GIF and WebP by their magic bytes', () => {
  const gif = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(4)]);
  assert.equal(decodePasteImage({ mime: 'image/gif', dataBase64: b64(gif) }).ext, 'gif');
  const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')]);
  assert.equal(decodePasteImage({ mime: 'image/webp', dataBase64: b64(webp) }).ext, 'webp');
});

test('pasteFileName: sortable by time, unique by the random suffix', () => {
  assert.equal(pasteFileName('png', { now: 1700000000000, rand: 'abcd1234' }), 'paste-1700000000000-abcd1234.png');
});

test('prunePastes: removes only our own filenames, and only ones past the TTL', () => {
  const now = 10_000_000_000;
  const files = {
    'paste-1-aaaa.png': now - PASTE_TTL_MS - 1,   // stale, ours → goes
    'paste-2-bbbb.jpg': now - 1000,               // fresh, ours → stays
    'notes.md': now - PASTE_TTL_MS - 1,           // stale, a human's → stays
    'paste-nope.png': now - PASTE_TTL_MS - 1,     // stale, wrong shape → stays
  };
  const removed = [];
  const n = prunePastes('/d', {
    now,
    readdirSync: () => Object.keys(files),
    statSync: (f) => ({ mtimeMs: files[f.split('/').pop()] }),
    rmSync: (f) => removed.push(f.split('/').pop()),
  });
  assert.equal(n, 1);
  assert.deepEqual(removed, ['paste-1-aaaa.png']);
});

test('prunePastes: a missing directory is a silent no-op, never a throw on the write path', () => {
  const n = prunePastes('/gone', {
    now: 1,
    readdirSync: () => { throw new Error('ENOENT'); },
    statSync: () => ({ mtimeMs: 0 }),
    rmSync: () => { throw new Error('should not be reached'); },
  });
  assert.equal(n, 0);
});
