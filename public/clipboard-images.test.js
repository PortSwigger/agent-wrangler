import { test } from 'node:test';
import assert from 'node:assert/strict';
import { imageSources, imgSrcsFromHtml, imageMimeOf, sourceToFrame, bytesToBase64 } from './clipboard-images.js';

// DataTransfer stubs shaped like what Chrome 152 on macOS actually delivered for
// each copy source (logged with a probe page before the fix).
const file = (name, type, bytes = [1, 2, 3]) => new File([new Uint8Array(bytes)], name, { type });
function dt({ files = [], items, data = {} } = {}) {
  return {
    files,
    items: items ?? files.map((f) => ({ kind: 'file', type: f.type, getAsFile: () => f })),
    types: [...(files.length ? ['Files'] : []), ...Object.keys(data)],
    getData: (t) => data[t] ?? '',
  };
}
const PNG_BYTES = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7];
const PNG_DATA_URL = `data:image/png;base64,${Buffer.from(PNG_BYTES).toString('base64')}`;

test('a Finder copy of an image file is an image source, whatever its format', () => {
  for (const [name, type] of [['a.png', 'image/png'], ['a.heic', 'image/heic'], ['a.tiff', 'image/tiff'], ['a.bmp', 'image/bmp']]) {
    const { sources, text } = imageSources(dt({ files: [file(name, type)] }));
    assert.equal(sources.length, 1, name);
    assert.equal(sources[0].kind, 'file');
    assert.equal(sources[0].mime, type);
    assert.equal(text, '');
  }
});

test('a file with no type is recognised from its extension, and a non-image file is not', () => {
  assert.equal(imageMimeOf(file('IMG_0001.HEIC', '')), 'image/heic');
  assert.equal(imageMimeOf(file('notes.txt', '')), null);
  assert.equal(imageMimeOf(file('logo.svg', 'image/svg+xml')), null, 'SVG is text, not a picture to attach');
  assert.equal(imageSources(dt({ files: [file('notes.txt', 'text/plain')] })).sources.length, 0);
});

test('a bitmap clipboard (screenshot, Copy Image) arrives as an image/png item and is used once', () => {
  // Copy Image also puts markup describing the same picture on the clipboard;
  // the file must win or the image is attached twice.
  const png = file('image.png', 'image/png');
  const { sources } = imageSources(dt({
    files: [],
    items: [{ kind: 'file', type: 'image/png', getAsFile: () => png }, { kind: 'string', type: 'text/html' }],
    data: { 'text/html': '<img src="https://example.com/a.png">' },
  }));
  assert.equal(sources.length, 1);
  assert.equal(sources[0].file, png);
});

test('markup-only image copies yield their data: and http srcs', () => {
  const { sources, text } = imageSources(dt({ data: { 'text/plain': '', 'text/html': `<meta charset='utf-8'><img src="${PNG_DATA_URL}">` } }));
  assert.deepEqual(sources, [{ kind: 'url', url: PNG_DATA_URL }]);
  assert.equal(text, '');
  const http = imageSources(dt({ data: { 'text/plain': 'Look at this  thing', 'text/html': 'Look at this <img src="http://localhost:8765/a.png" alt=x> thing' } }));
  assert.deepEqual(http.sources, [{ kind: 'url', url: 'http://localhost:8765/a.png' }]);
  assert.equal(http.text, 'Look at this  thing', 'the words around the image are kept');
});

test('imgSrcsFromHtml: quoting styles, entities, duplicates, and unreadable schemes', () => {
  const html = `<img src=https://a.test/x.png><IMG alt="y" SRC='https://a.test/y.png?a=1&amp;b=2'>`
    + '<img src="https://a.test/x.png"><img src="blob:https://a.test/123"><img src="file:///etc/passwd"><img data-src="https://a.test/z.png">';
  assert.deepEqual(imgSrcsFromHtml(html), ['https://a.test/x.png', 'https://a.test/y.png?a=1&b=2']);
  assert.deepEqual(imgSrcsFromHtml('<img src="data:text/html;base64,PHNjcmlwdD4=">'), [], 'a data: URL that is not an image is ignored');
});

test('a data: image URL pasted as plain text is an image; any other text is left alone', () => {
  assert.deepEqual(imageSources(dt({ data: { 'text/plain': `  ${PNG_DATA_URL}\n` } })).sources, [{ kind: 'url', url: PNG_DATA_URL }]);
  for (const t of ['hello', 'https://example.com/cat.png', `see ${PNG_DATA_URL}`]) {
    const r = imageSources(dt({ data: { 'text/plain': t } }));
    assert.equal(r.sources.length, 0, t);
  }
});

test('nothing at all is not an image paste', () => {
  assert.deepEqual(imageSources(null).sources, []);
  assert.deepEqual(imageSources(dt()).sources, []);
});

test('sourceToFrame: a browser-storable file is sent as-is, untouched by the converter', async () => {
  let converted = false;
  const frame = await sourceToFrame({ kind: 'file', file: file('a.png', 'image/png', PNG_BYTES), mime: 'image/png' }, { toPng: async () => { converted = true; } });
  assert.equal(frame.mime, 'image/png');
  assert.deepEqual([...Buffer.from(frame.dataBase64, 'base64')], PNG_BYTES);
  assert.equal(converted, false);
});

test('sourceToFrame: a format the browser can draw (BMP) is re-encoded to PNG', async () => {
  const png = new Blob([new Uint8Array(PNG_BYTES)], { type: 'image/png' });
  const frame = await sourceToFrame({ kind: 'file', file: file('a.bmp', 'image/bmp', [0x42, 0x4d]), mime: 'image/bmp' }, { toPng: async () => png });
  assert.equal(frame.mime, 'image/png');
  assert.deepEqual([...Buffer.from(frame.dataBase64, 'base64')], PNG_BYTES);
});

test('sourceToFrame: HEIC/TIFF the browser cannot draw go raw for the server to convert', async () => {
  for (const mime of ['image/heic', 'image/tiff']) {
    const frame = await sourceToFrame({ kind: 'file', file: file('x', mime, [9, 9]), mime }, { toPng: async () => null });
    assert.equal(frame.mime, mime);
    assert.equal(frame.dataBase64, Buffer.from([9, 9]).toString('base64'));
  }
});

test('sourceToFrame: an undecodable format the server cannot convert is refused with a sentence', async () => {
  await assert.rejects(
    sourceToFrame({ kind: 'file', file: file('x.ico', 'image/x-icon'), mime: 'image/x-icon' }, { toPng: async () => null }),
    /cannot be pasted/,
  );
});

test('sourceToFrame: an http src is fetched by the browser, without credentials', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return { ok: true, blob: async () => new Blob([new Uint8Array(PNG_BYTES)], { type: 'image/png' }) }; };
  const frame = await sourceToFrame({ kind: 'url', url: 'https://a.test/x.png' }, { fetchImpl });
  assert.equal(frame.mime, 'image/png');
  assert.deepEqual(calls, [{ url: 'https://a.test/x.png', init: { mode: 'cors', credentials: 'omit' } }]);
});

test('sourceToFrame: a CORS-blocked or failing http src explains what to do instead', async () => {
  await assert.rejects(sourceToFrame({ kind: 'url', url: 'https://a.test/x.png' }, { fetchImpl: async () => { throw new TypeError('Failed to fetch'); } }), /Copy Image/);
  await assert.rejects(sourceToFrame({ kind: 'url', url: 'https://a.test/x.png' }, { fetchImpl: async () => ({ ok: false, status: 404 }) }), /HTTP 404/);
});

test('sourceToFrame: a data: URL decodes to its bytes', async () => {
  const frame = await sourceToFrame({ kind: 'url', url: PNG_DATA_URL });
  assert.equal(frame.mime, 'image/png');
  assert.deepEqual([...Buffer.from(frame.dataBase64, 'base64')], PNG_BYTES);
});

test('bytesToBase64 matches Buffer across the chunk boundary', () => {
  const bytes = new Uint8Array(0x8000 * 2 + 17).map((_, i) => i * 31);
  assert.equal(bytesToBase64(bytes), Buffer.from(bytes).toString('base64'));
});
