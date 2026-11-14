import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

// An isolated dev instance and a headless Chrome tab on it, for tests that pin
// what extension board code sees in a real browser.
export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export function findChrome() {
  if (process.env.CHROME_BIN) return existsSync(process.env.CHROME_BIN) ? process.env.CHROME_BIN : null;
  return [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
  ].find((p) => existsSync(p)) || null;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(fn, { tries = 80, every = 250 } = {}) {
  for (let i = 0; i < tries; i++) {
    try { const v = await fn(); if (v) return v; } catch {}
    await sleep(every);
  }
  return null;
}

// Starts server/index.js on `dataDir` with every port left to the OS, resolving
// once GET /deck answers on the board port it logged. `out()` is everything it
// has printed; `deckPort()` the port the deck said it listens on.
export async function startInstance(dataDir) {
  let out = '';
  const server = spawn(process.execPath, ['server/index.js'], {
    cwd: REPO_ROOT,
    env: { ...process.env, AW_DEV: '1', AW_DEV_IDLE_SHUTDOWN_MIN: '0', AW_DATA_DIR: dataDir, AW_PORT: '0', AW_OPEN_BROWSER: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (c) => { out += c; });
  server.stderr.on('data', (c) => { out += c; });
  const port = Number(await waitFor(() => /running at http:\/\/localhost:(\d+)/.exec(out)?.[1])) || null;
  const up = port && await waitFor(async () => (await fetch(`http://127.0.0.1:${port}/deck`)).ok);
  const deckPort = () => Number(/deck API at http:\/\/127\.0\.0\.1:(\d+)/.exec(out)?.[1]) || null;
  return { port, deckPort, server, up: Boolean(up), out: () => out };
}

// Opens `url` in a headless Chrome tab with the console captured. `evaluate`
// returns an expression's value. `requests` lists every URL the page asked
// for, WebSockets included.
export async function openTab(chromePath, url) {
  const profile = mkdtempSync(join(tmpdir(), 'aw-chrome-'));
  const chrome = spawn(chromePath, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-sandbox', '--disable-gpu', '--window-size=1400,900', 'about:blank'], { stdio: 'ignore' });
  const close = async (cdp) => {
    try { cdp?.close(); } catch {}
    try { chrome.kill(); } catch {}
    await sleep(500);
    rmSync(profile, { recursive: true, force: true });
  };
  const devPort = await waitFor(() => Number(readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]) || null);
  if (!devPort) { await close(); throw new Error('Chrome never reported a DevTools port'); }
  const target = await waitFor(async () => {
    const r = await fetch(`http://127.0.0.1:${devPort}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
    return r.ok ? r.json() : null;
  });
  if (!target?.webSocketDebuggerUrl) { await close(); throw new Error('could not open a Chrome tab'); }
  const cdp = new WebSocket(target.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
  await new Promise((res, rej) => { cdp.once('open', res); cdp.once('error', rej); });
  let id = 0;
  const pending = new Map();
  const warnings = [];
  const errors = [];
  const requests = [];
  cdp.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    if (m.method === 'Runtime.consoleAPICalled') {
      const text = m.params.args.map((a) => a.value ?? a.description).join(' ');
      if (m.params.type === 'warning') warnings.push(text);
      if (m.params.type === 'error') errors.push(text);
    }
    if (m.method === 'Network.requestWillBeSent') requests.push(m.params.request.url);
    if (m.method === 'Network.webSocketCreated') requests.push(m.params.url);
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  });
  const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); cdp.send(JSON.stringify({ id: i, method, params })); });
  await send('Runtime.enable');
  await send('Network.enable');
  await send('Page.reload');
  const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true })).result?.result?.value;
  return { send, evaluate, warnings, errors, requests, close: () => close(cdp) };
}
