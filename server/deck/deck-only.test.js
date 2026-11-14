import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const holdPort = () => new Promise((res) => {
  const s = createServer();
  s.listen(0, '127.0.0.1', () => res(s));
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, { tries = 60, every = 250 } = {}) {
  for (let i = 0; i < tries; i++) {
    try { const v = await fn(); if (v) return v; } catch {}
    await sleep(every);
  }
  return null;
}

function open(url, origin, headers) {
  const ws = new WebSocket(url, { ...(origin ? { origin } : {}), ...(headers ? { headers } : {}) });
  const frames = [];
  ws.on('message', (raw) => { try { frames.push(JSON.parse(raw.toString())); } catch {} });
  const opened = new Promise((res) => { ws.on('open', () => res(true)); ws.on('error', () => res(false)); ws.on('close', () => res(false)); });
  return { ws, frames, opened };
}

async function startDeckOnly({ args = [], env = {}, config, tokens } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'aw-deck-only-'));
  if (config) writeFileSync(join(dataDir, 'config.json'), JSON.stringify(config));
  if (tokens) writeFileSync(join(dataDir, 'session-tokens.json'), JSON.stringify({ cards: tokens }));
  const boardHold = await holdPort();
  const boardPort = boardHold.address().port;
  let out = '';
  const server = spawn(process.execPath, ['server/cli.js', '--deck-only', '--data-dir', dataDir, ...args], {
    cwd: REPO_ROOT,
    env: { ...process.env, AW_DEV: '1', AW_DEV_IDLE_SHUTDOWN_MIN: '0', AW_PORT: String(boardPort), AW_DECK_PORT: '0', AW_OPEN_BROWSER: '', AW_ALLOWED_ORIGINS: '', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (c) => { out += c; });
  server.stderr.on('data', (c) => { out += c; });
  const deckPort = Number(await waitFor(() => out.match(/deck API at http:\/\/127\.0\.0\.1:(\d+)/)?.[1]));
  const base = `http://127.0.0.1:${deckPort}`;
  const deck = deckPort ? await waitFor(async () => { const r = await fetch(`${base}/deck`); return r.ok && r.json(); }) : null;
  const sockets = [];
  return {
    dataDir, deckPort, boardPort, base, deck, sockets, out: () => out,
    running: () => server.exitCode === null && server.signalCode === null,
    open: (path, origin, headers) => { const s = open(`ws://127.0.0.1:${deckPort}${path}`, origin, headers); sockets.push(s.ws); return s; },
    async stop() {
      for (const ws of sockets) try { ws.close(); } catch {}
      try { server.kill(); } catch {}
      await sleep(500);
      await new Promise((res) => boardHold.close(res));
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
    assert.ok(d.running(), `it never binds the board port, which this test holds:\n${d.out()}`);
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

test('a deck-only instance serves its session API on its own port, behind the token check', { timeout: 60_000 }, async () => {
  const token = 'awt_deck-only-test-token';
  const d = await startDeckOnly({ tokens: { 'deck-card': createHash('sha256').update(token).digest('hex') } });
  try {
    assert.ok(d.deck, `GET /deck never answered:\n${d.out()}`);
    const port = Number(await waitFor(() => d.out().match(/session API at http:\/\/127\.0\.0\.1:(\d+)/)?.[1]));
    assert.ok(port, `startup never named the session API port:\n${d.out()}`);
    assert.notEqual(port, d.deckPort, 'not the deck port');
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

test('the deck refuses a valid session token on GET /deck, the /ws action channel and /pty', { timeout: 60_000 }, async () => {
  const token = 'awt_deck-boundary-test-token';
  const board = 'http://localhost:7878';
  const d = await startDeckOnly({ args: ['--allowed-origins', board], tokens: { 'deck-card': createHash('sha256').update(token).digest('hex') } });
  try {
    assert.ok(d.deck, `GET /deck never answered:\n${d.out()}`);
    for (const headers of [{ Authorization: `Bearer ${token}` }, { 'X-AW-Session': token }]) {
      const r = await fetch(`${d.base}/deck`, { headers });
      assert.equal(r.status, 403, `GET /deck with ${Object.keys(headers)[0]}`);
      assert.deepEqual(await r.json(), { error: 'session-credential', reason: 'the deck API takes no session token; a session calls the session API' });
      const ws = d.open('/ws?api=1', board, headers);
      assert.equal(await ws.opened, false, `/ws?api=1 with ${Object.keys(headers)[0]}`);
      assert.equal(ws.frames.length, 0, 'no state, so no action can be sent');
      assert.equal(await d.open('/ws', undefined, headers).opened, false, 'nor the legacy /ws');
      assert.equal(await d.open('/pty?session=none', board, headers).opened, false, `/pty with ${Object.keys(headers)[0]}`);
    }
    assert.equal((await fetch(`${d.base}/deck`)).status, 200, 'GET /deck without one still answers');
    assert.equal(await d.open('/ws?api=1', board).opened, true, 'and /ws opens');
    assert.equal(await d.open('/pty?session=none', board).opened, true, 'and /pty');
  } finally {
    await d.stop();
  }
});

test('the old POST /mcp, /pr-attach and /pr-model on the deck port still work, behind the token check, with one deprecation warning', { timeout: 60_000 }, async () => {
  const token = 'awt_deck-legacy-test-token';
  const d = await startDeckOnly({ tokens: { 'deck-card': createHash('sha256').update(token).digest('hex') } });
  try {
    assert.ok(d.deck, `GET /deck never answered:\n${d.out()}`);
    const port = Number(await waitFor(() => d.out().match(/session API at http:\/\/127\.0\.0\.1:(\d+)/)?.[1]));
    const listSessions = (headers) => fetch(`${d.base}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_sessions', arguments: {} } }),
    }).then(async (r) => ({ status: r.status, body: await r.json() }));

    for (let i = 0; i < 3; i++) {
      const ok = await listSessions({ Authorization: `Bearer ${token}` });
      assert.equal(ok.status, 200);
      assert.equal(ok.body.result.isError, undefined, JSON.stringify(ok.body));
    }
    assert.equal((await listSessions({})).body.error, 'missing-token', 'the same token check');
    assert.equal((await listSessions({ Authorization: 'Bearer awt_forged' })).body.error, 'unknown-token');
    const model = await fetch(`${d.base}/pr-model`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{}' });
    assert.notEqual(model.status, 403, '/pr-model takes the token too');

    const lines = await waitFor(() => { const l = d.out().split('\n').filter((x) => x.includes('is deprecated') && x.includes('/pr-model')); return l.length ? l : null; });
    assert.equal(lines?.length, 1, `exactly one deprecation warning:\n${d.out()}`);
    assert.match(lines[0], new RegExp(`POST /mcp, /pr-attach and /pr-model on the deck's or board's port is deprecated.*session API at http://127\\.0\\.0\\.1:${port}`));
  } finally {
    await d.stop();
  }
});
