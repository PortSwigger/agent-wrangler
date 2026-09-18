import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

// The board is only really "working" if a browser can load it, and two blank-dashboard
// regressions shipped through a green CI in one afternoon (a deleted element the module
// graph grabbed at import, and a syntax error in app.js). The static guards beside this
// file catch both of those shapes cheaply — but neither can see the OTHER half of the
// first one: #92 also deleted the .diff-row/.diff-cell-empty rules, which produce no
// error at all, just a silently unstyled side-by-side view.
//
// So this drives REAL headless Chrome over the DevTools Protocol. No new dependency:
// `ws` is already a runtime dep, and CDP is just JSON over a socket. Deliberately not
// Playwright/puppeteer — neither earns a browser download plus a dep for one smoke test,
// and jsdom can't do this at all (no layout engine, and app.js touches WebSocket/xterm
// at import).
//
// Runs against an ISOLATED instance (its own AW_DATA_DIR, so it can never see or touch
// the live board's tmux sessions — see the run-dev skill) and SKIPS when no Chrome is
// present, so a contributor without one still gets a green `npm test`.

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function findChrome() {
  // An explicitly-set CHROME_BIN is authoritative: falling back to some other browser
  // when it doesn't resolve would silently test something the caller didn't ask for.
  if (process.env.CHROME_BIN) return existsSync(process.env.CHROME_BIN) ? process.env.CHROME_BIN : null;
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
  ].filter(Boolean);
  return candidates.find((p) => existsSync(p)) || null;
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

// Chrome picks its own debug port and writes it to DevToolsActivePort — reading it back
// avoids racing another process for a hard-coded one.
async function launchChrome(chromePath, profile) {
  const proc = spawn(chromePath, [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--window-size=1400,900',
    'about:blank',
  ], { stdio: 'ignore' });
  const portFile = join(profile, 'DevToolsActivePort');
  const port = await waitFor(() => {
    const line = readFileSync(portFile, 'utf8').split('\n')[0].trim();
    return line ? Number(line) : null;
  });
  return { proc, port };
}

test('the board loads in a real browser with no console errors', { timeout: 180_000 }, async (t) => {
  const chromePath = findChrome();
  if (!chromePath) {
    // CI sets AW_REQUIRE_BROWSER so a runner that loses its Chrome fails loudly instead
    // of skipping forever — a permanently-skipped acceptance test is worse than none,
    // because it still reads as green.
    assert.ok(!process.env.AW_REQUIRE_BROWSER, 'AW_REQUIRE_BROWSER is set but no Chrome/Chromium was found');
    return t.skip('no Chrome/Chromium found (set CHROME_BIN to enable)');
  }

  const dataDir = mkdtempSync(join(tmpdir(), 'aw-accept-'));
  const profile = mkdtempSync(join(tmpdir(), 'aw-chrome-'));
  const port = await freePort();
  const url = `http://127.0.0.1:${port}/`;
  let server, chrome, ws;

  try {
    server = spawn(process.execPath, ['server/index.js'], {
      cwd: REPO_ROOT,
      env: { ...process.env, AW_DEV: '1', AW_DATA_DIR: dataDir, AW_PORT: String(port), AW_OPEN_BROWSER: '' },
      stdio: 'ignore',
    });
    const up = await waitFor(async () => (await fetch(url)).ok);
    assert.ok(up, 'dev instance never started serving');

    const launched = await launchChrome(chromePath, profile);
    chrome = launched.proc;
    assert.ok(launched.port, 'Chrome never reported a DevTools port');

    const target = await waitFor(async () => {
      const r = await fetch(`http://127.0.0.1:${launched.port}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
      return r.ok ? r.json() : null;
    });
    assert.ok(target?.webSocketDebuggerUrl, 'could not open a Chrome tab');

    ws = new WebSocket(target.webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 });
    await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });

    let id = 0;
    const pending = new Map();
    const errors = [];
    ws.on('message', (raw) => {
      const m = JSON.parse(raw);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
      if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails;
        errors.push(d.exception?.description || d.text);
      } else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
        errors.push(m.params.args.map((a) => a.value ?? a.description).join(' '));
      }
    });
    const send = (method, params = {}) => new Promise((res) => {
      const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params }));
    });
    const evaluate = async (expression) =>
      (await send('Runtime.evaluate', { expression, returnByValue: true })).result?.result?.value;

    await send('Runtime.enable');
    await send('Page.enable');
    await send('Page.navigate', { url });
    // The board renders off its first control-WS graph push, not DOMContentLoaded, and
    // #grid is empty in the HTML — so a child inside it IS that push having landed.
    // Waiting on document.body text instead was BOTH flaky and vacuous, and no increase
    // in `tries` could fix it, because that wait returned EARLY rather than timing out:
    // every local asset is `Cache-Control: no-store` (http-handler.js), so the navigate
    // above re-fetches styles.css every run, and until it applies
    // `#modal.hidden { display: none }` is not in force — the dialogs and sidebar render,
    // putting ~1.5k characters on a board that has drawn nothing. The old wait latched
    // onto that FOUC text on its first poll, then two round trips later asserted either
    // against the same text (passing with #grid still EMPTY, catching nothing) or, once
    // styles had landed but the graph had not, against the genuinely-0 gap behind it —
    // the "board rendered no text at all" failure. Counts CHILDREN rather than matching
    // #grid's text so the signal survives a copy change to the empty-board hint.
    const rendered = await waitFor(async () => evaluate(`document.getElementById('grid')?.children.length > 0`));
    if (!rendered) {
      // waitFor yields null on a timeout and `evaluate` yields undefined on a dead tab,
      // so without this the two reach the assertions below indistinguishable from a board
      // that really did render blank — the reason a timeout used to surface as the
      // flatly misleading "board rendered no text at all".
      const alive = (await evaluate('1 + 1')) === 2;
      assert.fail(alive
        ? `#grid never got a child: the first control-WS graph push never rendered (readyState=${await evaluate('document.readyState')}, body text=${await evaluate('document.body.innerText.trim().length')} chars)`
        : 'the DevTools evaluate round trip stopped answering — the tab or renderer died before the board rendered');
    }

    // Assert the page under test is the one we think it is — a stale or redirected tab
    // would otherwise be reported as a healthy board.
    assert.equal(await evaluate('location.origin + "/"'), url, 'loaded a different page than expected');

    // A fresh instance legitimately has zero session cards, so "did it render" is the
    // shell being present — the blank-page regressions produced literally 0 characters.
    // Only meaningful now that the wait above holds it back until the graph has rendered:
    // against the FOUC window it was satisfied by markup the board never drew.
    assert.ok(await evaluate(`document.body.innerText.trim().length > 0`), 'board rendered no text at all');
    assert.ok(await evaluate(`!!document.getElementById('grid')`), '#grid (the card grid) is missing');

    // Contract points from the two real regressions: the element a module grabs at
    // import, and a CSS rule whose deletion is otherwise completely silent.
    assert.ok(await evaluate(`!!document.getElementById('diff-layout-split')`), '#diff-layout-split is missing');
    assert.ok(
      await evaluate(`[...document.styleSheets].flatMap(s=>{try{return [...s.cssRules]}catch{return []}}).some(r=>r.selectorText==='.diff-row')`),
      'the .diff-row side-by-side rule is missing from the stylesheet',
    );

    assert.deepEqual(errors, [], `browser reported console errors:\n${errors.join('\n')}`);
  } finally {
    try { ws?.close(); } catch {}
    try { chrome?.kill(); } catch {}
    try { server?.kill(); } catch {}
    await sleep(500);
    // Cleanup must never fail the test — Chrome writes to its profile as it exits.
    for (const dir of [profile, dataDir]) { try { rmSync(dir, { recursive: true, force: true }); } catch {} }
  }
});
