import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { createTokenStore } from './session-api/tokens.js';

async function until(fn) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const value = fn();
    if (value) return value;
    await delay(10);
  }
  throw new Error('restart fixture timed out');
}

for (const mode of ['control', 'signal']) {
  test(`real server drains a committed MCP write before a ${mode} restart`, { timeout: 20000 }, async (t) => {
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-restart-'));
    const extension = path.join(data, 'extensions', 'restart-probe');
    fs.cpSync(new URL('./fixtures/restart-probe', import.meta.url), extension, { recursive: true });
    fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ extensions: { 'task-memory': false }, autoUpdate: 'off' }));
    const token = createTokenStore({ file: path.join(data, 'session-tokens.json') }).issue('probe');
    const child = spawn(process.execPath, ['server/index.js'], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      env: { ...process.env, AW_DATA_DIR: data, AW_DEV: '', AW_SUPERVISED: '1', AW_GIT_UPDATES: '', AW_PORT: '0', AW_DECK_PORT: '0', AW_SESSION_API_PORT: '0', AW_NO_OPEN: '1', AW_OPEN_BROWSER: '', CHOKIDAR_USEPOLLING: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (s) => { output += s; });
    child.stderr.on('data', (s) => { output += s; });
    const stopped = once(child, 'exit');
    let ws;
    t.after(async () => {
      ws?.terminate();
      if (child.exitCode === null) child.kill('SIGKILL');
      await stopped;
      fs.rmSync(data, { recursive: true, force: true });
    });
    const sessionPort = await until(() => /session API at http:\/\/127\.0\.0\.1:(\d+)/.exec(output)?.[1]);
    const deckPort = await until(() => /deck API at http:\/\/127\.0\.0\.1:(\d+)/.exec(output)?.[1]);
    const response = fetch(`http://127.0.0.1:${sessionPort}/mcp`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'restart_probe', arguments: {} } }),
    });
    await until(() => fs.existsSync(path.join(extension, 'committed')));
    if (mode === 'signal') child.kill('SIGTERM');
    else {
      ws = new WebSocket(`ws://127.0.0.1:${deckPort}/ws?api=1`);
      await once(ws, 'open');
      ws.send(JSON.stringify({ type: 'action', id: 2, action: 'admin.restart-server' }));
    }
    await until(() => output.includes('Waiting for in-flight requests'));
    const refused = await fetch(`http://127.0.0.1:${sessionPort}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: '{}' });
    assert.equal(refused.status, 503, output);
    assert.equal(child.exitCode, null, output);
    fs.writeFileSync(path.join(extension, 'release'), 'finish');
    const result = await (await response).json();
    assert.deepEqual(result.result?.structuredContent, { applied: true }, JSON.stringify(result));
    const [code, signal] = await stopped;
    assert.equal(code, 0, output);
    assert.equal(signal, null, output);
  });
}
