import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

// Pins the surfaces an extension written before the deck API reaches: the
// fixture in fixtures/compat-probe reads dropped session fields off the graph,
// fetches GET /file and GET /ext-file, and opens a /ws without ?api= from its
// board code, in a real headless Chrome against an isolated instance. Each must
// answer in its old shape, and each must have gone through its adapter, which
// the one deprecation warning per surface shows. Skips without Chrome, like
// board-acceptance.test.js.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = join(REPO_ROOT, 'server', 'fixtures', 'compat-probe');

function findChrome() {
  if (process.env.CHROME_BIN) return existsSync(process.env.CHROME_BIN) ? process.env.CHROME_BIN : null;
  return [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
  ].find((p) => existsSync(p)) || null;
}

const freePort = () => new Promise((res) => {
  const s = createServer();
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); });
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, { tries = 80, every = 250 } = {}) {
  for (let i = 0; i < tries; i++) {
    try { const v = await fn(); if (v) return v; } catch {}
    await sleep(every);
  }
  return null;
}

test('an extension using the pre-deck surfaces still works, each through its adapter', { timeout: 120_000 }, async (t) => {
  const chromePath = findChrome();
  if (!chromePath) {
    assert.ok(!process.env.AW_REQUIRE_BROWSER, 'AW_REQUIRE_BROWSER is set but no Chrome/Chromium was found');
    return t.skip('no Chrome/Chromium found (set CHROME_BIN to enable)');
  }
  const dataDir = mkdtempSync(join(tmpdir(), 'aw-compat-'));
  const profile = mkdtempSync(join(tmpdir(), 'aw-chrome-'));
  const extDir = join(dataDir, 'extensions', 'compat-probe');
  mkdirSync(dirname(extDir), { recursive: true });
  cpSync(FIXTURE, extDir, { recursive: true });
  writeFileSync(join(dataDir, 'extensions.json'), JSON.stringify({ 'compat-probe': { id: 'compat-probe', requires: ['files:view'] } }));
  const sid = '0000000c-0000-0000-0000-00000000000c';
  const suspendedAt = 1_700_000_000_000;
  writeFileSync(join(dataDir, 'mappings.json'), JSON.stringify({ [sid]: { agent: 'claude', cwd: dataDir, name: 'Compat card', createdAt: Date.now(), suspendedAt } }));
  const port = await freePort();
  const url = `http://127.0.0.1:${port}/#view=ext:compat-probe:main`;
  let server, chrome, cdp;
  let serverOut = '';
  try {
    server = spawn(process.execPath, ['server/index.js'], {
      cwd: REPO_ROOT,
      env: { ...process.env, AW_DEV: '1', AW_DEV_IDLE_SHUTDOWN_MIN: '0', AW_DATA_DIR: dataDir, AW_PORT: String(port), AW_OPEN_BROWSER: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    server.stdout.on('data', (c) => { serverOut += c; });
    server.stderr.on('data', (c) => { serverOut += c; });
    assert.ok(await waitFor(async () => (await fetch(`http://127.0.0.1:${port}/deck`)).ok), 'dev instance never started serving');

    chrome = spawn(chromePath, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-sandbox', '--disable-gpu', '--window-size=1400,900', 'about:blank'], { stdio: 'ignore' });
    const devPort = await waitFor(() => Number(readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]) || null);
    assert.ok(devPort, 'Chrome never reported a DevTools port');
    const target = await waitFor(async () => {
      const r = await fetch(`http://127.0.0.1:${devPort}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
      return r.ok ? r.json() : null;
    });
    assert.ok(target?.webSocketDebuggerUrl, 'could not open a Chrome tab');
    cdp = new WebSocket(target.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
    await new Promise((res, rej) => { cdp.once('open', res); cdp.once('error', rej); });

    let id = 0;
    const pending = new Map();
    const warnings = [];
    const errors = [];
    cdp.on('message', (raw) => {
      const m = JSON.parse(raw);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
      if (m.method === 'Runtime.consoleAPICalled') {
        const text = m.params.args.map((a) => a.value ?? a.description).join(' ');
        if (m.params.type === 'warning') warnings.push(text);
        if (m.params.type === 'error') errors.push(text);
      }
      if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    });
    const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); cdp.send(JSON.stringify({ id: i, method, params })); });
    await send('Runtime.enable');
    await send('Page.reload');
    const probe = async () => (await send('Runtime.evaluate', { expression: 'JSON.stringify(window.__compatProbe || null)', returnByValue: true })).result?.result?.value;

    const done = await waitFor(async () => {
      const r = JSON.parse((await probe()) || 'null');
      return r?.fields && r.extFile && r.legacyWs?.pong != null ? r : null;
    });
    assert.ok(done, `the fixture never finished: ${await probe()}`);

    assert.deepEqual(done.fields, { sessionId: sid, hasPid: true, pid: null, suspendedAt, jobId: null }, 'the graph extensions see carries the dropped fields');
    assert.equal(done.file.status, 200);
    assert.equal(done.file.body.content, readFileSync(join(extDir, 'note.md'), 'utf8'));
    assert.deepEqual(done.extFile, { status: 200, ok: true });
    assert.ok(done.legacyWs.types.includes('config') && done.legacyWs.types.includes('graph'), 'a legacy socket gets config and graph frames');
    assert.ok(!done.legacyWs.types.includes('state') && !done.legacyWs.types.includes('event'));
    assert.deepEqual(done.legacyWs.graphSessions, [{ sessionId: sid, hasPid: true, suspendedAt }], 'its graph frame carries the full record');
    assert.equal(done.legacyWs.pong, 7, 'a legacy message reaches its handler and the reply comes back unwrapped');

    for (const field of ['pid', 'suspendedAt', 'jobId']) {
      assert.equal(warnings.filter((w) => w.includes(`session.${field} is deprecated`)).length, 1, `one warning for session.${field}`);
    }
    for (const [surface, replacement] of [['GET /file', 'session.file'], ['GET /ext-file', 'deck.ext-file'], ['A /ws connection without ?api=', '/ws?api=1']]) {
      const lines = serverOut.split('\n').filter((l) => l.includes(`${surface} is deprecated`));
      assert.equal(lines.length, 1, `one server warning for ${surface}:\n${serverOut}`);
      assert.ok(lines[0].includes(replacement), `${surface}'s warning names ${replacement}`);
    }
    assert.deepEqual(errors, [], 'no console errors');
  } finally {
    try { cdp?.close(); } catch {}
    try { chrome?.kill(); } catch {}
    try { server?.kill(); } catch {}
    await sleep(500);
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(profile, { recursive: true, force: true });
  }
});
