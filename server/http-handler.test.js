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

const dirs = { checklist: extDir };
const server = createHttpServer({
  port: 0,
  mcpRequestHandler: (req, res) => res.end(),
  prAttachHandler: (req, res) => res.end(),
  fileHandler: (req, res) => res.end(),
  extensionAssets: (id) => dirs[id] || null,
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
