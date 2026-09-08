import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

// history-gate.test.js proves the gate omits an unchanged list; this proves the LIVE
// server's list actually IS unchanged tick to tick. Those are different claims, and
// only this one fails when the record starts jittering — a per-build timestamp, an
// unstable sort, a label recomputed off something live — which would leave the gate
// a silent no-op with every unit test still green.
//
// Boots the real server against an ISOLATED AW_DATA_DIR (see the run-dev skill) seeded
// with ARCHIVED-ONLY entries: socketsToScan only adds the legacy/default socket for a
// socket-less entry that is NOT archived, so this can never see the live board's tmux.

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
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

test('the archived list rides the first graph and is omitted by every unchanged one after', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'aw-hist-'));
  const port = await freePort();
  const url = `http://127.0.0.1:${port}/`;
  let server, ws;

  const now = Date.now();
  const archived = (n, over) => [`0000000${n}-0000-0000-0000-00000000000${n}`, {
    agent: 'claude', createdAt: now - 7200e3, archivedAt: now - n * 3600e3,
    name: `Archived ${n}`, cwd: '/tmp/aw-hist-repo', model: 'sonnet', ...over,
  }];
  writeFileSync(join(dataDir, 'mappings.json'), JSON.stringify(Object.fromEntries([
    archived(1), archived(2, { viaTaskArchive: 't_x' }), archived(3),
  ])));

  try {
    server = spawn(process.execPath, ['server/index.js'], {
      cwd: REPO_ROOT,
      env: { ...process.env, AW_DEV: '1', AW_DEV_IDLE_SHUTDOWN_MIN: '0', AW_DATA_DIR: dataDir, AW_PORT: String(port), AW_OPEN_BROWSER: '' },
      stdio: 'ignore',
    });
    assert.ok(await waitFor(async () => (await fetch(url)).ok), 'dev instance never started serving');

    // No trailing slash: origin-check.js compares the Origin header exactly, and a
    // `http://host:port/` form is rejected by the CSRF gate.
    ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin: `http://127.0.0.1:${port}` });
    const graphs = [];
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.type === 'graph') graphs.push(m.graph);
    });
    // Four graphs is one connect snapshot plus three ordinary rebuild broadcasts.
    assert.ok(await waitFor(() => graphs.length >= 4, { tries: 60, every: 500 }), `only saw ${graphs.length} graphs`);

    assert.equal('history' in graphs[0], true, 'the connect snapshot must always carry the full list');
    assert.equal(graphs[0].history.length, 3);
    assert.deepEqual(
      Object.keys(graphs[0].history[0]).sort(),
      ['archivedAt', 'cwd', 'label', 'model', 'sessionId', 'viaTaskArchive'],
    );
    const later = graphs.slice(1, 4).map((g) => 'history' in g);
    assert.deepEqual(later, [false, false, false], 'nothing archived between these ticks, so none may re-send the list');
  } finally {
    try { ws?.close(); } catch {}
    try { server?.kill(); } catch {}
    await sleep(500);
    rmSync(dataDir, { recursive: true, force: true });
  }
});
