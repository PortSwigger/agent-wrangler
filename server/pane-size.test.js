import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { PaneSizeMemory, paneSizeOf, DEFAULT_PANE_SIZE } from './pane-size.js';
import { SessionManager } from './session-manager.js';
import { resolveTmuxBin } from './tmux-resolve.js';

const exec = promisify(execFile);

function tmpFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-pane-size-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'pane-size.json');
}

test('paneSizeOf keeps a readable size, clamps to tmux\'s maximum, and drops a mid-layout fit', () => {
  assert.deepEqual(paneSizeOf(132, 56), { cols: 132, rows: 56 });
  assert.deepEqual(paneSizeOf(20000, 12000), { cols: 10000, rows: 10000 });
  for (const [cols, rows] of [[2, 1], [19, 40], [120, 4], [0, 0], [-5, 30], [NaN, 30], [120.5, 30], ['x', 30], [undefined, undefined]]) {
    assert.equal(paneSizeOf(cols, rows), null, `${cols}x${rows}`);
  }
});

test('a new pane starts at a wide default until a terminal reports, then at the last size reported', (t) => {
  const mem = new PaneSizeMemory({ file: tmpFile(t), delayMs: 60_000 });
  assert.deepEqual(mem.get(), DEFAULT_PANE_SIZE);
  assert.ok(DEFAULT_PANE_SIZE.cols > 80 && DEFAULT_PANE_SIZE.rows > 24);
  mem.note(132, 56);
  mem.note(155, 40);
  mem.note(2, 1); // a hidden panel's fit is not a size anyone reads
  assert.deepEqual(mem.get(), { cols: 155, rows: 40 });
  mem.flush();
});

test('the last size survives a restart, written once it settles', async (t) => {
  const file = tmpFile(t);
  const mem = new PaneSizeMemory({ file, delayMs: 20 });
  mem.note(150, 40);
  mem.note(181, 52);
  assert.equal(fs.existsSync(file), false, 'nothing written mid-drag');
  await new Promise((r) => setTimeout(r, 80));
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { cols: 181, rows: 52 });
  assert.deepEqual(new PaneSizeMemory({ file }).get(), { cols: 181, rows: 52 });
});

test('a saved size out of bounds, or a corrupt file, falls back to the default', (t) => {
  const file = tmpFile(t);
  fs.writeFileSync(file, JSON.stringify({ cols: 3, rows: 1 }));
  assert.deepEqual(new PaneSizeMemory({ file }).get(), DEFAULT_PANE_SIZE);
  fs.writeFileSync(file, '{not json');
  const orig = console.error;
  console.error = () => {};
  try {
    assert.deepEqual(new PaneSizeMemory({ file }).get(), DEFAULT_PANE_SIZE);
  } finally {
    console.error = orig;
  }
});

// Real tmux on a throwaway socket: the size reaches the pane before any client attaches.
test('_newSession starts a detached pane at the size given, before any client attaches', async (t) => {
  const sm = new SessionManager();
  sm.tmuxBin = await resolveTmuxBin();
  const socket = `aw-pane-size-test-${crypto.randomBytes(4).toString('hex')}`;
  t.after(async () => {
    await exec(sm.tmuxBin, ['-L', socket, 'kill-server']).catch(() => {});
    fs.rmSync(path.join(process.env.TMUX_TMPDIR || '/tmp', `tmux-${process.getuid()}`, socket), { force: true });
  });
  await sm._newSession('sized', os.tmpdir(), 'sleep 30', socket, { cols: 181, rows: 52 });
  const { stdout } = await exec(sm.tmuxBin, ['-L', socket, 'display-message', '-p', '-t', 'sized', '#{window_width}x#{window_height}']);
  assert.equal(stdout.trim(), '181x52');
});
