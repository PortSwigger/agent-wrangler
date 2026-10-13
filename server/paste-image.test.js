import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { decodePasteImage, convertToPng, isPasteFileName, pasteFileName, prunePastes, MAX_PASTE_BYTES, PASTE_TTL_MS } from './paste-image.js';

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
  assert.match(r.error, /PNG, JPEG, GIF, WebP, HEIC and TIFF/);
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

const HEIC = Buffer.concat([Buffer.from([0, 0, 0, 0x24]), Buffer.from('ftypheic'), Buffer.alloc(8)]);
const TIFF_LE = Buffer.from([0x49, 0x49, 0x2a, 0x00, 8, 0, 0, 0]);
const TIFF_BE = Buffer.from([0x4d, 0x4d, 0x00, 0x2a, 0, 0, 0, 8]);

test('decodePasteImage: HEIC and TIFF are accepted by their magic bytes, flagged for conversion', () => {
  assert.deepEqual(decodePasteImage({ mime: 'image/heic', dataBase64: b64(HEIC) }), { bytes: HEIC, ext: 'heic', convert: true });
  assert.equal(decodePasteImage({ mime: 'image/heif', dataBase64: b64(HEIC) }).ext, 'heic');
  assert.equal(decodePasteImage({ mime: 'image/tiff', dataBase64: b64(TIFF_LE) }).convert, true);
  assert.equal(decodePasteImage({ mime: 'image/tiff', dataBase64: b64(TIFF_BE) }).ext, 'tiff');
  // The original four are never flagged.
  assert.equal(decodePasteImage({ mime: 'image/png', dataBase64: b64(PNG) }).convert, undefined);
});

test('decodePasteImage: a convertible mime still needs matching bytes', () => {
  assert.match(decodePasteImage({ mime: 'image/heic', dataBase64: b64(PNG) }).error, /PNG, not a HEIC/);
  assert.match(decodePasteImage({ mime: 'image/tiff', dataBase64: b64(Buffer.from('MM not a tiff')) }).error, /does not look like an image/);
});

test('the stored-name allowlist still only admits the four stored formats', () => {
  assert.equal(isPasteFileName('paste-1-abcd.heic'), false);
  assert.equal(isPasteFileName('paste-1-abcd.tiff'), false);
});

test('convertToPng: refuses off macOS with a sentence saying what to do', async () => {
  const r = await convertToPng(HEIC, 'heic', { platform: 'linux', run: () => assert.fail('must not run anything') });
  assert.match(r.error, /HEIC images can only be converted on macOS/);
});

test('convertToPng: runs sips with fixed args, and refuses output that is not a PNG', async () => {
  const calls = [];
  const fs = await import('node:fs');
  const ok = await convertToPng(TIFF_LE, 'tiff', {
    platform: 'darwin',
    run: async (cmd, args) => { calls.push([cmd, args]); fs.writeFileSync(args[5], PNG); },
  });
  assert.deepEqual(ok, { bytes: PNG, ext: 'png' });
  assert.equal(calls[0][0], '/usr/bin/sips');
  assert.deepEqual(calls[0][1].slice(0, 3), ['-s', 'format', 'png']);
  assert.ok(!fs.existsSync(calls[0][1][3]), 'the temp dir is removed afterwards');

  const notPng = await convertToPng(TIFF_LE, 'tiff', { platform: 'darwin', run: async (_c, args) => fs.writeFileSync(args[5], 'GIF89a......') });
  assert.match(notPng.error, /Could not convert that TIFF/);
  const failed = await convertToPng(TIFF_LE, 'tiff', { platform: 'darwin', run: async () => { throw new Error('sips: unsupported'); } });
  assert.match(failed.error, /Could not convert that TIFF/);
});

// A tiny valid PNG, so the real converter has something it can actually decode.
function realPng() {
  const chunk = (t, d) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(d.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(Buffer.concat([Buffer.from(t), d])));
    return Buffer.concat([len, Buffer.from(t), d, crc]);
  };
  const ihdr = Buffer.from([0, 0, 0, 2, 0, 0, 0, 2, 8, 2, 0, 0, 0]);
  const raw = Buffer.from([0, 255, 0, 0, 0, 255, 0, 0, 0, 0, 255, 255, 255, 255]);
  return Buffer.concat([PNG.subarray(0, 8), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

test('convertToPng: a real TIFF and HEIC become a real PNG (macOS only)', { skip: process.platform !== 'darwin' || typeof zlib.crc32 !== 'function' }, async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-paste-test-'));
  try {
    fs.writeFileSync(path.join(dir, 'in.png'), realPng());
    for (const ext of ['tiff', 'heic']) {
      const src = path.join(dir, `in.${ext}`);
      try { execFileSync('/usr/bin/sips', ['-s', 'format', ext, path.join(dir, 'in.png'), '--out', src], { stdio: 'ignore' }); } catch { continue; }
      const decoded = decodePasteImage({ mime: `image/${ext}`, dataBase64: fs.readFileSync(src).toString('base64') });
      assert.equal(decoded.convert, true, ext);
      const r = await convertToPng(decoded.bytes, decoded.ext);
      assert.equal(r.ext, 'png', ext);
      assert.equal(decodePasteImage({ mime: 'image/png', dataBase64: r.bytes.toString('base64') }).ext, 'png');
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
