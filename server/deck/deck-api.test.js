import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { CONTROL_HANDLERS } from '../control/handlers/index.js';
import { CORE_ACTIONS } from './actions.js';
import { startInstance } from '../browser-harness.js';

// Boots the real server on an isolated AW_DATA_DIR with no mappings, so it never
// scans the live board's tmux (see the run-dev skill).
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

test('the deck API: descriptor, state stream, actions with results; the legacy protocol and file routes answer through adapters', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'aw-deck-'));
  const note = join(dataDir, 'note.md');
  writeFileSync(note, '# Deck note\n');
  let instance;
  const sockets = [];
  try {
    instance = await startInstance(dataDir);
    assert.ok(instance.up, `dev instance never started serving:\n${instance.out()}`);
    const { port } = instance;
    const base = `http://127.0.0.1:${port}`;
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
    assert.equal(await legacy.opened, true, 'a client that names no API version gets the legacy adapter');
    const file = await fetch(`${base}/file?path=${encodeURIComponent(note)}`);
    assert.equal(file.status, 200);
    assert.deepEqual(await file.json(), { path: realpathSync(note), content: '# Deck note\n' }, 'GET /file answers as it always did');
    const missing = await fetch(`${base}/file?path=${encodeURIComponent(join(dataDir, 'nope.md'))}`);
    assert.equal(missing.status, 404);
    assert.deepEqual(await (await fetch(`${base}/ext-file?ext=no-such-ext&path=a.md`)).json(), { ok: false, reason: 'not-permitted' }, 'GET /ext-file answers as it always did');
    assert.equal(await client.opened, true);

    const graph = await waitFor(() => legacy.frames.find((f) => f.type === 'graph'));
    assert.ok(graph, 'a legacy client gets a graph frame built from the state frame');
    for (const k of ['sessions', 'history', 'nodes', 'edges', 'tasks', 'schedules', 'defaultRuntime', 'extensions', 'codeVersion']) assert.ok(k in graph.graph, `graph carries ${k}`);
    for (const k of ['rev', 'settings', 'status', 'ext', 'compat']) assert.ok(!(k in graph.graph), `graph has no ${k}`);
    assert.ok(legacy.frames.some((f) => f.type === 'config'), 'a legacy client gets announcements unwrapped');
    assert.ok(!legacy.frames.some((f) => f.type === 'state' || f.type === 'event'));

    const state = await waitFor(() => client.frames.find((f) => f.type === 'state'));
    assert.ok(state, 'no state frame on connect');
    assert.equal(typeof state.rev, 'number');
    for (const k of ['sessions', 'history', 'nodes', 'edges', 'tasks', 'schedules', 'settings', 'ext']) assert.ok(k in state, `state carries ${k}`);
    assert.ok(!client.frames.some((f) => f.type === 'graph'), 'a deck client gets state, not graph');
    assert.ok(client.frames.some((f) => f.type === 'event' && f.event === 'config'), 'announcements arrive as events');

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

    const resultsBefore = client.frames.filter((f) => f.type === 'result').length;
    client.ws.send(JSON.stringify({ type: 'task-create', name: 'Legacy task' }));
    await sleep(1500);
    assert.equal(client.frames.filter((f) => f.type === 'result').length, resultsBefore, 'a legacy message gets no answer');
    assert.ok(!client.frames.some((f) => f.type === 'state' && f.tasks.tasks.some((t) => t.name === 'Legacy task')), 'and does nothing');

    legacy.ws.send(JSON.stringify({ type: 'task-create', name: 'Adapted task' }));
    const reply = await waitFor(() => legacy.frames.find((f) => f.type === 'task-created'));
    assert.ok(reply?.taskId, 'on a legacy connection it runs as task.create and gets its old reply');
    assert.ok(await waitFor(() => legacy.frames.find((f) => f.type === 'graph' && f.graph.tasks.tasks.some((t) => t.id === reply.taskId))), 'and the next graph frame carries it');
    assert.ok(await waitFor(() => client.frames.find((f) => f.type === 'state' && f.tasks.tasks.some((t) => t.id === reply.taskId))), 'the same state reaches the deck client');
  } finally {
    for (const ws of sockets) try { ws.close(); } catch {}
    try { instance?.server.kill(); } catch {}
    await sleep(500);
    rmSync(dataDir, { recursive: true, force: true });
  }
});

