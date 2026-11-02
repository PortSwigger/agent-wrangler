import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createConnection } from 'node:net';
import { createHttpServer } from './http-handler.js';

// The /ext/<id>/ route serves an extension's client module out of its own
// public/ subdir. Two things are asserted here because both fail silently in the
// browser otherwise: a disabled or unknown id is a 404 (the gate is membership
// in the loaded enabled list, so a disabled extension's client is never served),
// and nothing outside public/ is reachable — the manifest (index.js) sits one
// level up from it and is exactly what a `..` would fetch.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-ext-route-'));
const extDir = path.join(tmp, 'checklist');
fs.mkdirSync(path.join(extDir, 'public', 'nested'), { recursive: true });
fs.writeFileSync(path.join(extDir, 'index.js'), 'export default { id: "checklist" };\n');
fs.writeFileSync(path.join(extDir, 'public', 'index.js'), 'export default { register() {} };\n');
fs.writeFileSync(path.join(extDir, 'public', 'nested', 'dom.js'), 'export const x = 1;\n');
fs.writeFileSync(path.join(tmp, 'secret.txt'), 'nope\n');

const themeDir = path.join(tmp, 'themes');
fs.mkdirSync(path.join(themeDir, 'route-sky'), { recursive: true });
fs.writeFileSync(path.join(themeDir, 'route-sky', 'theme.json'), JSON.stringify({ name: 'Route sky', base: 'dark', icon: 'M0 0', assets: { wallpaper: 'w.svg' } }));
fs.writeFileSync(path.join(themeDir, 'route-sky', 'w.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');

const dirs = { checklist: extDir };
let themeDirs = [{ id: 'sky-ext', dir: themeDir }];
const server = createHttpServer({
  port: 0,
  mcpRequestHandler: (req, res) => res.end(),
  prAttachHandler: (req, res) => res.end(),
  prModelHandler: (req, res) => res.end('pr-model'),
  fileHandler: (req, res) => res.end(),
  extensionAssets: (id) => dirs[id] || null,
  extensionThemes: () => themeDirs,
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
after(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

// fetch() normalises `..` out of a URL before sending, so a traversal has to go
// down the raw socket the way a hand-crafted request would.
function rawGet(rawPath) {
  return new Promise((resolve, reject) => {
    const sock = createConnection(server.address().port, '127.0.0.1', () => {
      sock.write(`GET ${rawPath} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
    });
    let buf = '';
    sock.on('data', (d) => { buf += d; });
    sock.on('end', () => resolve({ status: Number(buf.split(' ')[1]), body: buf.split('\r\n\r\n').slice(1).join('\r\n\r\n') }));
    sock.on('error', reject);
  });
}

test('POST /pr-model reaches its handler; a cross-origin POST is refused', async () => {
  const ok = await fetch(`${base}/pr-model`, { method: 'POST' });
  assert.equal(await ok.text(), 'pr-model');
  const cross = await fetch(`${base}/pr-model`, { method: 'POST', headers: { Origin: 'https://example.com' } });
  assert.equal(cross.status, 403);
});

test('stateless MCP declines optional GET streams and session deletion without static fallback', async () => {
  for (const method of ['GET', 'DELETE']) {
    const response = await fetch(`${base}/mcp?fixture=1`, { method });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('allow'), 'POST');
  }
  const post = await fetch(`${base}/mcp`, { method: 'POST' });
  assert.equal(post.status, 200);
  const cross = await fetch(`${base}/mcp`, { method: 'POST', headers: { Origin: 'https://example.com' } });
  assert.equal(cross.status, 403);
});

test('serves an enabled extension client module from its public/ dir, no-store', async () => {
  const res = await fetch(`${base}/ext/checklist/index.js`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/javascript; charset=utf-8');
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.match(await res.text(), /register\(\)/);
  const nested = await fetch(`${base}/ext/checklist/nested/dom.js`);
  assert.equal(nested.status, 200);
});

test('an unknown or disabled extension id is 404, never a directory probe', async () => {
  assert.equal((await fetch(`${base}/ext/nope/index.js`)).status, 404);
  assert.equal((await rawGet('/ext/../server/index.js')).status, 404);
  assert.equal((await fetch(`${base}/ext/`)).status, 404);
});

test('traversal out of public/ is refused with 403', async () => {
  // Up one: the manifest itself, the most likely accidental target.
  const manifest = await rawGet('/ext/checklist/../index.js');
  assert.equal(manifest.status, 403);
  assert.doesNotMatch(manifest.body, /id: "checklist"/);
  assert.equal((await rawGet('/ext/checklist/..%2Findex.js')).status, 403);
  assert.equal((await rawGet('/ext/checklist/nested/../../index.js')).status, 403);
  assert.equal((await rawGet('/ext/checklist/../../secret.txt')).status, 403);
  // An absolute second segment must not re-root the resolve.
  assert.equal((await rawGet(`/ext/checklist//${path.join(tmp, 'secret.txt').replace(/^\//, '')}`)).status, 403);
  assert.equal((await rawGet('/ext/checklist/')).status, 403);
});

test('a missing file inside public/ is a plain 404', async () => {
  assert.equal((await fetch(`${base}/ext/checklist/missing.js`)).status, 404);
});

test('an enabled extension\'s themes are listed and their declared assets served; disabled, both go', async () => {
  themeDirs = [{ id: 'sky-ext', dir: themeDir }];
  const listed = (await (await fetch(`${base}/api/styles`)).json()).styles.find((s) => s.id === 'route-sky');
  assert.equal(listed.extension, 'sky-ext');
  assert.equal(listed.wallpaperUrl, '/styles/route-sky/w.svg');
  assert.equal((await fetch(`${base}/styles/route-sky/w.svg`)).status, 200);
  assert.equal((await fetch(`${base}/styles/route-sky/theme.json`)).status, 404);
  themeDirs = [];
  const gone = (await (await fetch(`${base}/api/styles`)).json()).styles;
  assert.equal(gone.some((s) => s.id === 'route-sky'), false);
  assert.equal((await fetch(`${base}/styles/route-sky/w.svg`)).status, 404);
});

test('a theme its extension has switched off is neither listed nor served', async () => {
  themeDirs = [{ id: 'sky-ext', dir: themeDir, off: ['route-sky'] }];
  const styles = (await (await fetch(`${base}/api/styles`)).json()).styles;
  assert.equal(styles.some((s) => s.id === 'route-sky'), false);
  assert.equal((await fetch(`${base}/styles/route-sky/w.svg`)).status, 404);
  themeDirs = [];
});
