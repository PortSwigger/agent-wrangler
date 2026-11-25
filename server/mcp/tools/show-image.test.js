import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { showImageTool, MAX_SHOW_IMAGE_BYTES } from './show-image.js';

// A real 1×1 PNG, and the magic bytes of the other three rasters.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]);
const GIF = Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00;', 'latin1');
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x1a, 0, 0, 0]), Buffer.from('WEBPVP8 ')]);

function setup() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aw-show-image-')));
  const put = (name, bytes) => { const p = path.join(dir, name); fs.writeFileSync(p, bytes); return p; };
  return { dir, put };
}

function deps(entry = { cwd: '/work/app' }) {
  return { sessionManager: { entryFor: (id) => (id === 'CARD1' ? entry : null) } };
}

const call = (args, { entry, caller = 'CARD1' } = {}) => showImageTool.handler({ deps: deps(entry), caller }, args);
const textOf = (r) => r.content.find((b) => b.type === 'text')?.text;

test('returns the image as an MCP image block plus one text line', async () => {
  const { put } = setup();
  const p = put('home.png', PNG);
  const r = await call({ path: p });
  assert.equal(r.isError, undefined);
  assert.deepEqual(r.content, [
    { type: 'text', text: `Shown in Chat: home.png (PNG, ${PNG.length} B).` },
    { type: 'image', data: PNG.toString('base64'), mimeType: 'image/png' },
  ]);
});

test('the bytes decide the MIME type, for each of the four rasters', async () => {
  const { put } = setup();
  for (const [name, bytes, mimeType] of [['a.jpg', JPEG, 'image/jpeg'], ['b.gif', GIF, 'image/gif'], ['c.webp', WEBP, 'image/webp'], ['d.png', JPEG, 'image/jpeg']]) {
    const r = await call({ path: put(name, bytes) });
    assert.equal(r.content.find((b) => b.type === 'image')?.mimeType, mimeType, name);
  }
});

test('follows a symlink to an image, and refuses one whose target is not an image', async () => {
  const { dir, put } = setup();
  const real = put('real.png', PNG);
  fs.symlinkSync(real, path.join(dir, 'link.png'));
  assert.equal((await call({ path: path.join(dir, 'link.png') })).isError, undefined);
  const txt = put('notes.txt', 'hello');
  fs.symlinkSync(txt, path.join(dir, 'fake.png'));
  const r = await call({ path: path.join(dir, 'fake.png') });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /is not a PNG, JPEG, GIF or WebP file/);
});

test('refuses a relative path, naming the absolute one it would be', async () => {
  const r = await call({ path: 'shots/home.png' });
  assert.equal(r.isError, true);
  assert.equal(textOf(r), 'show_image needs an absolute path, and "shots/home.png" is relative. Pass the full path such as "/work/app/shots/home.png".');
});

test('refuses a missing path', async () => {
  const { dir } = setup();
  const r = await call({ path: path.join(dir, 'nope.png') });
  assert.equal(r.isError, true);
  assert.equal(textOf(r), `No file at "${path.join(dir, 'nope.png')}".`);
});

test('refuses an empty path', async () => {
  const r = await call({ path: '  ' });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /^Pass `path`/);
});

test('refuses non-image extensions, SVG included, and a directory named like an image', async () => {
  const { dir, put } = setup();
  for (const name of ['notes.txt', 'chart.svg', 'report.pdf']) {
    const r = await call({ path: put(name, 'x') });
    assert.equal(r.isError, true, name);
    assert.match(textOf(r), /is not a PNG, JPEG, GIF or WebP file/, name);
  }
  fs.mkdirSync(path.join(dir, 'folder.png'));
  assert.match(textOf(await call({ path: path.join(dir, 'folder.png') })), /is not a PNG, JPEG, GIF or WebP file/);
});

test('refuses a file named like an image whose bytes are not one', async () => {
  const { put } = setup();
  const r = await call({ path: put('lie.png', '<svg xmlns="http://www.w3.org/2000/svg"/>') });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /is named like an image, but its contents are not PNG, JPEG, GIF or WebP/);
  assert.equal(r.content.some((b) => b.type === 'image'), false);
});

test('refuses a file over the cap, saying its size and the limit', async () => {
  const { put } = setup();
  const p = put('huge.png', PNG);
  fs.truncateSync(p, MAX_SHOW_IMAGE_BYTES + 1);
  const r = await call({ path: p });
  assert.equal(r.isError, true);
  assert.equal(textOf(r), `"${p}" is 5.1 MB; show_image takes images up to 5 MB. Save a smaller copy (downscaled, or JPEG for a photo) and show that.`);
  fs.truncateSync(p, Math.round(7.25 * 1024 * 1024));
  assert.match(textOf(await call({ path: p })), /is 7.3 MB; show_image takes images up to 5 MB/);
  const exact = put('exact.png', PNG);
  fs.truncateSync(exact, MAX_SHOW_IMAGE_BYTES);
  assert.equal((await call({ path: exact })).isError, undefined);
});

test('refuses a session in a container or at a location, whose paths are not the board\'s', async () => {
  const { put } = setup();
  const p = put('home.png', PNG);
  const container = await call({ path: p }, { entry: { cwd: '/workspaces/app', runtime: 'devcontainer' } });
  assert.equal(container.isError, true);
  assert.match(textOf(container), /runs in the "Devcontainer" runtime, whose paths are not the board's/);
  const remote = await call({ path: p }, { entry: { cwd: '/srv/app', runtime: 'acme-remote', location: { host: 'a' } } });
  assert.equal(remote.isError, true);
  assert.match(textOf(remote), /runs in the "acme-remote" runtime/);
  assert.equal((await call({ path: p }, { entry: { cwd: '/work', runtime: 'local' } })).isError, undefined);
});

test('refuses a request with no session identity or an unknown session', async () => {
  assert.equal((await call({ path: '/x.png' }, { caller: null })).isError, true);
  assert.equal((await call({ path: '/x.png' }, { caller: 'GONE' })).isError, true);
});
