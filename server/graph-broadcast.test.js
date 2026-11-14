import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { startInstance } from './browser-harness.js';

// deck/state.test.js proves the state stream drops an unchanged list or state; this
// proves the LIVE server's state actually IS unchanged tick to tick. Those are
// different claims, and only this one fails when the record starts jittering — a per-build timestamp, an unstable sort, a label recomputed off
// something live, a sampled cpu figure — which would leave the stream's skip a silent no-op
// with every unit test still green.
//
// Boots the real server against an ISOLATED AW_DATA_DIR (see the run-dev skill) seeded
// with ARCHIVED-ONLY entries: socketsToScan only adds the legacy/default socket for a
// socket-less entry that is NOT archived, so this can never see the live board's tmux.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, { tries = 60, every = 250 } = {}) {
  for (let i = 0; i < tries; i++) {
    try { const v = await fn(); if (v) return v; } catch {}
    await sleep(every);
  }
  return null;
}

test('the archived list rides the first state frame, and an idle server sends no frame after it', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'aw-hist-'));
  let instance, ws;

  const now = Date.now();
  const archived = (n, over) => [`0000000${n}-0000-0000-0000-00000000000${n}`, {
    agent: 'claude', createdAt: now - 7200e3, archivedAt: now - n * 3600e3,
    name: `Archived ${n}`, cwd: '/tmp/aw-hist-repo', model: 'sonnet', ...over,
  }];
  writeFileSync(join(dataDir, 'mappings.json'), JSON.stringify(Object.fromEntries([
    archived(1), archived(2, { viaTaskArchive: 't_x' }), archived(3),
  ])));

  try {
    instance = await startInstance(dataDir);
    assert.ok(instance.up, `dev instance never started serving:\n${instance.out()}`);
    const { port } = instance;

    // No trailing slash: origin-check.js compares the Origin header exactly, and a
    // `http://host:port/` form is rejected by the CSRF gate.
    ws = new WebSocket(`ws://127.0.0.1:${port}/ws?api=1`, { origin: `http://127.0.0.1:${port}` });
    const frames = [];
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.type === 'state') frames.push(m);
    });
    assert.ok(await waitFor(() => frames.length >= 1), 'no connect snapshot');
    // Three 4s rebuild ticks with nothing changing. Any frame in them means the
    // state moved on its own; history-less or not, the board re-renders for it.
    await sleep(12_500);

    assert.equal('history' in frames[0], true, 'the connect snapshot must always carry the full list');
    assert.equal(frames[0].history.length, 3);
    assert.deepEqual(
      Object.keys(frames[0].history[0]).sort(),
      ['archivedAt', 'cwd', 'effort', 'label', 'model', 'sessionId', 'viaTaskArchive'],
    );
    assert.deepEqual(frames.slice(1), [], 'nothing changed between these ticks, so none may be broadcast');
  } finally {
    try { ws?.close(); } catch {}
    try { instance?.server.kill(); } catch {}
    await sleep(500);
    rmSync(dataDir, { recursive: true, force: true });
  }
});
