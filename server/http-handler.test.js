import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createConnection } from 'node:net';
import WebSocket, { WebSocketServer } from 'ws';
import { createBoardServer, BOARD_CSP } from './http-handler.js';
import { createDeckServer, refuseSessionCredentialUpgrade } from './deck/http.js';
import { carriesSessionCredential } from './session-api/check.js';
import { createBoardDecks } from './board-decks.js';

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
const deck = createDeckServer({
  boardPort: 0,
  mcpRequestHandler: (req, res) => res.end('mcp'),
  prAttachHandler: (req, res) => res.end(),
  prModelHandler: (req, res) => res.end('pr-model'),
  fileHandler: (req, res) => res.end(`file ${req.headers.host}`),
  extFileHandler: (req, res) => res.end('ext-file'),
  deckHandler: (req, res) => res.end(JSON.stringify({ api: '1.0' })),
});
const deckWss = new WebSocketServer({ noServer: true });
deck.on('upgrade', (req, socket, head) => (carriesSessionCredential(req) ? refuseSessionCredentialUpgrade(socket) : deckWss.handleUpgrade(req, socket, head, (ws) => ws.send(`deck ${req.url} ${req.headers.origin}`))));
await new Promise((resolve) => deck.listen(0, '127.0.0.1', resolve));

let boardPort = 0;
const server = createBoardServer({
  boardPort: () => boardPort,
  deckPort: () => deck.address().port,
  extensionAssets: (id) => dirs[id] || null,
  extensionThemes: () => themeDirs,
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
boardPort = server.address().port;
const base = `http://127.0.0.1:${server.address().port}`;
after(() => { server.close(); deck.close(); deckWss.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

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

test('POST /pr-model on the board\'s port is forwarded to the deck; a cross-origin POST is refused there', async () => {
  const ok = await fetch(`${base}/pr-model`, { method: 'POST' });
  assert.equal(await ok.text(), 'pr-model');
  const cross = await fetch(`${base}/pr-model`, { method: 'POST', headers: { Origin: 'https://example.com' } });
  assert.equal(cross.status, 403);
});

test('GET /file, /ext-file and /deck on the board\'s port reach the deck with the board\'s Host', async () => {
  assert.equal(await (await fetch(`${base}/file?path=x`)).text(), `file 127.0.0.1:${boardPort}`);
  assert.equal(await (await fetch(`${base}/ext-file?ext=a&path=x`)).text(), 'ext-file');
  assert.deepEqual(await (await fetch(`${base}/deck`)).json(), { api: '1.0' });
});

test('the deck allows a board origin to read GET /deck cross-origin, and no other', async () => {
  const deckBase = `http://127.0.0.1:${deck.address().port}`;
  const own = await fetch(`${deckBase}/deck`, { headers: { Origin: `http://127.0.0.1:${0}` } });
  assert.equal(own.headers.get('access-control-allow-origin'), 'http://127.0.0.1:0');
  const foreign = await fetch(`${deckBase}/deck`, { headers: { Origin: 'https://example.com' } });
  assert.equal(foreign.headers.get('access-control-allow-origin'), null);
  assert.equal((await fetch(`${deckBase}/index.html`)).status, 404, 'the deck serves no UI');
});

const wsOnce = (url, origin, headers) => new Promise((resolve) => {
  const ws = new WebSocket(url, { origin, headers });
  ws.once('message', (m) => { resolve(String(m)); ws.close(); });
  ws.once('error', () => resolve('refused'));
  ws.once('close', () => resolve('refused'));
});

test('/ws and /pty upgrades on the board\'s port are piped to the deck; a foreign origin is refused', async () => {
  const wsBase = `ws://127.0.0.1:${boardPort}`;
  assert.equal(await wsOnce(`${wsBase}/ws`, base), `deck /ws ${base}`);
  assert.equal(await wsOnce(`${wsBase}/pty?sessionId=a`, base), `deck /pty?sessionId=a ${base}`);
  assert.equal(await wsOnce(`${wsBase}/ws`, 'https://example.com'), 'refused');
  assert.equal(await wsOnce(`${wsBase}/elsewhere`, base), 'refused');
});

test('a session token sent to the board\'s port reaches the deck and is refused on /deck, /ws and /pty', async () => {
  for (const headers of [{ Authorization: 'Bearer awt_x' }, { 'X-AW-Session': 'awt_x' }]) {
    const r = await fetch(`${base}/deck`, { headers });
    assert.equal(r.status, 403);
    assert.equal((await r.json()).error, 'session-credential');
    const wsBase = `ws://127.0.0.1:${boardPort}`;
    assert.equal(await wsOnce(`${wsBase}/ws?api=1`, base, headers), 'refused');
    assert.equal(await wsOnce(`${wsBase}/pty?sessionId=a`, base, headers), 'refused');
  }
});

test('the board page names the deck\'s port and carries a Report-Only CSP', async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.headers.get('content-security-policy-report-only'), BOARD_CSP);
  assert.match(BOARD_CSP, /script-src 'self'/);
  assert.equal(res.headers.get('content-security-policy'), null, 'never enforced, so inline extension code keeps running');
  assert.match(await res.text(), new RegExp(`<meta name="aw-deck-port" content="${deck.address().port}" />`));
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

// The board's deck list lives in the board server, so every browser on the
// board reads one list: GET reads it, POST changes it (JSON from a board
// origin only), and the stream tells every open page about each change.
test('the deck list is read, changed from a board page, and streamed to every page', async (t) => {
  let decksBoard = null;
  const store = createBoardDecks({ file: path.join(tmp, 'board-decks.json'), onChange: (snap) => decksBoard.announceDecks(snap) });
  let port = 0;
  decksBoard = createBoardServer({ boardPort: () => port, deckPort: () => deck.address().port, decks: store });
  await new Promise((resolve) => decksBoard.listen(0, '127.0.0.1', resolve));
  port = decksBoard.address().port;
  t.after(() => decksBoard.close());
  const at = `http://127.0.0.1:${port}`;
  const post = (body, headers = {}) => fetch(`${at}/api/decks`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: at, ...headers }, body: JSON.stringify(body) });

  assert.deepEqual((await (await fetch(`${at}/api/decks`)).json()).decks.map((d) => d.id), ['own']);

  const streams = [new AbortController(), new AbortController()];
  const frames = streams.map(() => []);
  await Promise.all(streams.map(async (c, i) => {
    const res = await fetch(`${at}/api/decks/stream`, { signal: c.signal });
    assert.equal(res.headers.get('content-type'), 'text/event-stream');
    const reader = res.body.getReader();
    (async () => {
      const dec = new TextDecoder();
      try { for (;;) { const { value, done } = await reader.read(); if (done) break; frames[i].push(...dec.decode(value).split('\n\n').filter(Boolean).map((f) => JSON.parse(f.replace(/^data: /, '')))); } } catch {}
    })();
  }));
  t.after(() => streams.forEach((c) => c.abort()));

  assert.equal((await post({ op: 'add', url: 'http://127.0.0.1:7890' }, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await fetch(`${at}/api/decks`, { method: 'POST', headers: { Origin: at, 'Content-Type': 'text/plain' }, body: '{"op":"add","url":"http://127.0.0.1:7890"}' })).status, 403);
  const bad = await post({ op: 'add', url: 'ftp://x' });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /URL/);

  const added = await post({ op: 'add', url: 'http://127.0.0.1:7890', name: 'Laptop B' });
  assert.equal(added.status, 200);
  assert.deepEqual((await added.json()).decks.map((d) => d.name), ['', 'Laptop B']);
  for (let i = 0; i < 40 && frames.some((f) => f.length < 2); i++) await new Promise((r) => setTimeout(r, 25));
  assert.deepEqual(frames[0].at(-1), frames[1].at(-1), 'both pages hold the same list');
  assert.deepEqual(frames[1].at(-1).decks.map((d) => d.url ?? 'own'), ['own', 'http://127.0.0.1:7890']);
});
