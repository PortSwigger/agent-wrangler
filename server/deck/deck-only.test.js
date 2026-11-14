import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, connect as netConnect } from 'node:net';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const freePort = () => new Promise((res) => {
  const s = createServer();
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); });
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, { tries = 60, every = 250 } = {}) {
  for (let i = 0; i < tries; i++) {
    try { const v = await fn(); if (v) return v; } catch {}
    await sleep(every);
  }
  return null;
}
const listening = (port) => new Promise((res) => {
  const c = netConnect(port, '127.0.0.1');
  c.once('connect', () => { c.destroy(); res(true); });
  c.once('error', () => res(false));
});

function open(url, origin) {
  const ws = new WebSocket(url, origin ? { origin } : {});
  const frames = [];
  ws.on('message', (raw) => { try { frames.push(JSON.parse(raw.toString())); } catch {} });
  const opened = new Promise((res) => { ws.on('open', () => res(true)); ws.on('error', () => res(false)); ws.on('close', () => res(false)); });
  return { ws, frames, opened };
}

async function startDeckOnly({ args = [], env = {}, config, tokens } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'aw-deck-only-'));
  if (config) writeFileSync(join(dataDir, 'config.json'), JSON.stringify(config));
  if (tokens) writeFileSync(join(dataDir, 'session-tokens.json'), JSON.stringify({ cards: tokens }));
  const deckPort = await freePort();
  await freePort(); // left free: the session API takes the port next to the deck
  const boardPort = await freePort();
  let out = '';
  const server = spawn(process.execPath, ['server/cli.js', '--deck-only', '--port', String(deckPort), '--data-dir', dataDir, ...args], {
    cwd: REPO_ROOT,
    env: { ...process.env, AW_DEV: '1', AW_DEV_IDLE_SHUTDOWN_MIN: '0', AW_PORT: String(boardPort), AW_OPEN_BROWSER: '', AW_ALLOWED_ORIGINS: '', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (c) => { out += c; });
  server.stderr.on('data', (c) => { out += c; });
  const base = `http://127.0.0.1:${deckPort}`;
  const deck = await waitFor(async () => { const r = await fetch(`${base}/deck`); return r.ok && r.json(); });
  const sockets = [];
  return {
    dataDir, deckPort, boardPort, base, deck, sockets, out: () => out,
    open: (path, origin) => { const s = open(`ws://127.0.0.1:${deckPort}${path}`, origin); sockets.push(s.ws); return s; },
    async stop() {
      for (const ws of sockets) try { ws.close(); } catch {}
      try { server.kill(); } catch {}
      await sleep(500);
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

test('a deck-only instance serves the deck API on its own port, no board, and only its allowlisted origins', { timeout: 60_000 }, async () => {
  const board = 'http://localhost:7878';
  const d = await startDeckOnly({ args: ['--allowed-origins', board] });
  try {
    assert.ok(d.deck, `GET /deck never answered:\n${d.out()}`);
    assert.equal(d.deck.deckId, JSON.parse(readFileSync(join(d.dataDir, 'deck.json'), 'utf8')).deckId, 'its deckId lives in its own data dir');
    assert.ok(d.deck.actions.includes('session.file'));
    assert.equal(await listening(d.boardPort), false, 'no board server on the board port');

    for (const p of ['/', '/index.html', '/app.js', '/deck-client.js', '/api/styles', '/ext/jobs/board.js']) {
      assert.equal((await fetch(`${d.base}${p}`)).status, 404, `${p} is not served`);
    }

    const cors = await fetch(`${d.base}/deck`, { headers: { Origin: board } });
    assert.equal(cors.headers.get('access-control-allow-origin'), board, 'an allowlisted board reads /deck cross-origin');
    const ownLoopback = await fetch(`${d.base}/deck`, { headers: { Origin: `http://localhost:${d.boardPort}` } });
    assert.equal(ownLoopback.headers.get('access-control-allow-origin'), null, 'the unused board port is no board origin');

    const client = d.open('/ws?api=1', board);
    assert.equal(await client.opened, true, '/ws?api=1 opens for an allowlisted board');
    assert.ok(await waitFor(() => client.frames.find((f) => f.type === 'state')), 'and streams state');
    client.ws.send(JSON.stringify({ type: 'action', id: 't', action: 'task.create', args: { name: 'On the deck' } }));
    assert.equal((await waitFor(() => client.frames.find((f) => f.type === 'result' && f.id === 't')))?.ok, true, 'actions run');
    assert.equal(await d.open('/pty?session=none', board).opened, true, '/pty opens for an allowlisted board');

    assert.equal(await d.open('/ws?api=1', 'http://evil.example').opened, false, 'a foreign origin is refused on /ws');
    assert.equal(await d.open('/pty?session=none', 'http://evil.example').opened, false, 'and on /pty');
    assert.equal(await d.open('/ws?api=1', `http://localhost:${d.boardPort}`).opened, false, 'and so is the board port it does not serve');
    const post = await fetch(`${d.base}/mcp`, { method: 'POST', headers: { Origin: 'http://evil.example' }, body: '{}' });
    assert.equal(post.status, 403, 'a foreign POST /mcp is refused');
  } finally {
    await d.stop();
  }
});

test('a deck-only instance takes its board allowlist from config.json too', { timeout: 60_000 }, async () => {
  const d = await startDeckOnly({ config: { allowedOrigins: ['http://board.example:7878'] } });
  try {
    assert.ok(d.deck, `GET /deck never answered:\n${d.out()}`);
    assert.equal(await d.open('/ws?api=1', 'http://board.example:7878').opened, true);
    assert.equal(await d.open('/ws?api=1', 'http://localhost:7878').opened, false, 'with nothing configured for it, the usual board is not let in');
  } finally {
    await d.stop();
  }
});

test('a deck-only instance serves its session API on the port next to its deck, behind the token check', { timeout: 60_000 }, async () => {
  const token = 'awt_deck-only-test-token';
  const d = await startDeckOnly({ tokens: { 'deck-card': createHash('sha256').update(token).digest('hex') } });
  try {
    assert.ok(d.deck, `GET /deck never answered:\n${d.out()}`);
    const port = Number(await waitFor(() => d.out().match(/session API at http:\/\/127\.0\.0\.1:(\d+)/)?.[1]));
    assert.ok(port, `startup never named the session API port:\n${d.out()}`);
    assert.equal(port, d.deckPort + 1, 'it takes the port next to the deck');
    const listSessions = (headers) => fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_sessions', arguments: {} } }),
    }).then(async (r) => ({ status: r.status, body: await r.json() }));

    const ok = await listSessions({ Authorization: `Bearer ${token}` });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.result.isError, undefined, JSON.stringify(ok.body));
    assert.deepEqual(await listSessions({}), { status: 403, body: { error: 'missing-token', reason: 'missing token' } });
    assert.equal((await listSessions({ Authorization: 'Bearer awt_forged' })).body.error, 'unknown-token');
    assert.equal((await listSessions({ 'X-AW-Session': 'deck-card' })).body.error, 'missing-token', 'a card id is no token here');
    assert.equal((await fetch(`http://127.0.0.1:${port}/deck`)).status, 404, 'the session API port serves no deck API');
  } finally {
    await d.stop();
  }
});
