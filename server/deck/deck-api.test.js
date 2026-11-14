import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { CONTROL_HANDLERS } from '../control/handlers/index.js';
import { CORE_ACTIONS } from './actions.js';

// Boots the real server on an isolated AW_DATA_DIR with no mappings, so it never
// scans the live board's tmux (see the run-dev skill).
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

function connect(port, query = '') {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws${query}`, { origin: `http://127.0.0.1:${port}` });
  const frames = [];
  ws.on('message', (raw) => frames.push(JSON.parse(raw.toString())));
  const opened = new Promise((res) => { ws.on('open', () => res(true)); ws.on('error', () => res(false)); ws.on('close', () => res(false)); });
  return { ws, frames, opened };
}

test('the deck API: descriptor, state stream, actions with results, and the legacy protocol alongside', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'aw-deck-'));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const note = join(dataDir, 'note.md');
  writeFileSync(note, '# Deck note\n');
  let server;
  const sockets = [];
  try {
    server = spawn(process.execPath, ['server/index.js'], {
      cwd: REPO_ROOT,
      env: { ...process.env, AW_DEV: '1', AW_DEV_IDLE_SHUTDOWN_MIN: '0', AW_DATA_DIR: dataDir, AW_PORT: String(port), AW_OPEN_BROWSER: '' },
      stdio: 'ignore',
    });
    const deck = await waitFor(async () => { const r = await fetch(`${base}/deck`); return r.ok && r.json(); });
    assert.ok(deck, 'GET /deck never answered');
    assert.equal(deck.api, '1.0');
    assert.equal(deck.deckId, JSON.parse(readFileSync(join(dataDir, 'deck.json'), 'utf8')).deckId);
    for (const t of CONTROL_HANDLERS.map((h) => h.type)) assert.ok(deck.actions.includes(CORE_ACTIONS[t]), `${t} advertised`);
    assert.ok(deck.actions.includes('session.file'));
    assert.ok(deck.runtimes.some((r) => r.id === 'local'));
    assert.ok(deck.extensions.every((e) => typeof e.id === 'string' && 'version' in e && 'boardApi' in e));

    const legacy = connect(port);
    const client = connect(port, '?api=1');
    const refused = connect(port, '?api=2');
    sockets.push(legacy.ws, client.ws, refused.ws);
    assert.equal(await refused.opened, false, 'a major this deck cannot serve is refused');
    assert.equal(await client.opened, true);

    const state = await waitFor(() => client.frames.find((f) => f.type === 'state'));
    assert.ok(state, 'no state frame on connect');
    assert.equal(typeof state.rev, 'number');
    for (const k of ['sessions', 'history', 'nodes', 'edges', 'tasks', 'schedules', 'settings', 'ext']) assert.ok(k in state, `state carries ${k}`);
    assert.ok(!client.frames.some((f) => f.type === 'graph'), 'a deck client gets state, not graph');
    assert.ok(client.frames.some((f) => f.type === 'event' && f.event === 'config'), 'announcements arrive as events');
    assert.ok(await waitFor(() => legacy.frames.some((f) => f.type === 'graph')), 'the legacy board still gets its graph');
    assert.ok(!legacy.frames.some((f) => f.type === 'state'));

    const call = async (id, body) => {
      client.ws.send(JSON.stringify({ type: 'action', id, ...body }));
      return waitFor(() => client.frames.find((f) => f.type === 'result' && f.id === id));
    };
    assert.deepEqual(await call('u', { action: 'session.teleport', args: {} }), { type: 'result', id: 'u', ok: false, data: null, error: { code: 'unsupported', message: 'This deck does not offer session.teleport' } });
    assert.deepEqual(await call('f', { action: 'session.file', args: { path: note } }), { type: 'result', id: 'f', ok: true, data: { path: realpathSync(note), content: '# Deck note\n' } });
    assert.equal((await call('n', { action: 'session.rename', session: 'no-such-card', args: { name: 'x' } })).error.code, 'not-found');

    const before = client.frames.filter((f) => f.type === 'state').at(-1).rev;
    const created = await call('t', { action: 'task.create', args: { name: 'Deck task' } });
    assert.equal(created.ok, true);
    assert.equal(created.data.type, 'task-created');
    const after = await waitFor(() => client.frames.find((f) => f.type === 'state' && f.tasks.tasks.some((t) => t.id === created.data.taskId && t.name === 'Deck task')));
    assert.ok(after, 'the new task arrives on the state stream');
    assert.ok(after.rev > before, 'rev rose');

    legacy.ws.send(JSON.stringify({ type: 'task-create', name: 'Legacy task' }));
    assert.ok(await waitFor(() => legacy.frames.some((f) => f.type === 'graph' && f.graph.tasks?.tasks?.some((t) => t.name === 'Legacy task'))), 'a legacy message still works');
  } finally {
    for (const ws of sockets) try { ws.close(); } catch {}
    try { server?.kill(); } catch {}
    await sleep(500);
    rmSync(dataDir, { recursive: true, force: true });
  }
});

