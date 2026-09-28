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
// Bounds a HUNG call; it is not a latency budget. Every real CDP call here answers in
// single-digit ms, so this is deliberately far above any plausible slow-CI figure: the
// flag it sets is sticky, so one spurious trip would fail the whole test as "stopped
// answering", and that false failure is the costlier direction to be wrong in. The
// ceiling is the 180s outer timeout, and the worst case stays well inside it because a
// trip short-circuits every later call (30s + 79 * 250ms ≈ 50s).
const CDP_CALL_TIMEOUT_MS = 30_000;
// Returned in place of a reply that never came. Identity-compared, never read from, so
// an unanswered call can't be mistaken for a successful one — which for the `*.enable`
// commands would silently unsubscribe the console-error guard and pass regardless.
const UNANSWERED = Object.freeze({ unanswered: true });

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
      if (m.id && pending.has(m.id)) {
        const p = pending.get(m.id); pending.delete(m.id); clearTimeout(p.timer); p.settle(m);
      }
      if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails;
        errors.push(d.exception?.description || d.text);
      } else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
        errors.push(m.params.args.map((a) => a.value ?? a.description).join(' '));
      }
    });
    // A CDP call that never gets answered — renderer wedged, tab gone, socket dropped —
    // must not hang the caller. `waitFor` awaits each poll, so one unanswered reply would
    // otherwise stall the whole loop until the test's own 180s timeout and report nothing
    // but "timed out": the poll budget below only means anything if a call always settles.
    let socketClosed = false;
    // Set once any call has blown its bound. A wedged-but-open renderer answers nothing,
    // so without this every remaining poll pays the full timeout — 80 of those against a
    // 180s outer budget, and the loop would never reach the verdict below.
    let cdpStalled = false;
    ws.on('close', () => {
      socketClosed = true;
      // Clear the timers too, or the teardown below waits out every outstanding call.
      for (const p of pending.values()) { clearTimeout(p.timer); p.settle(UNANSWERED); }
      pending.clear();
    });
    const send = (method, params = {}) => new Promise((res) => {
      // Once the socket is gone nothing can answer, and letting each later call sit out
      // the full timeout would blow the test's own 180s budget before the poll loop below
      // ever reaches its verdict.
      if (socketClosed || cdpStalled) return res(UNANSWERED);
      const i = ++id;
      const timer = setTimeout(() => { cdpStalled = true; pending.delete(i); res(UNANSWERED); }, CDP_CALL_TIMEOUT_MS);
      pending.set(i, { settle: res, timer });
      ws.send(JSON.stringify({ id: i, method, params }));
    });
    // Unchecked: the poll loop and the failure diagnosis below WANT a falsy value for a
    // call that didn't land — they retry, and the diagnosis reports the transport state
    // itself. Anything asserting about the page uses evaluateChecked instead.
    const evaluate = async (expression) =>
      (await send('Runtime.evaluate', { expression, returnByValue: true })).result?.result?.value;
    // CDP can answer with an `error` as readily as a result, and both that and an
    // unanswered call collapse to `undefined` — which downstream reads as "the page says
    // no". So the assertions after the wait go through here and say what really happened
    // rather than blaming the DOM for a dead socket.
    const evaluateChecked = async (expression) => {
      const reply = await send('Runtime.evaluate', { expression, returnByValue: true });
      assert.notEqual(reply, UNANSWERED,
        `CDP stopped answering while evaluating \`${expression}\` (socket ${socketClosed ? 'closed' : 'open'})`);
      assert.ok(!reply.error, `CDP rejected \`${expression}\`: ${JSON.stringify(reply.error)}`);
      // A throw inside the page comes back as the THROWN VALUE in the same RemoteObject
      // slot as a real result, so `throw true` would satisfy a boolean assertion without
      // the expression ever having evaluated. exceptionDetails is the only thing that
      // distinguishes them.
      assert.ok(!reply.result?.exceptionDetails,
        `\`${expression}\` threw in the page: ${reply.result?.exceptionDetails?.text ?? ''} ${reply.result?.exceptionDetails?.exception?.description ?? ''}`.trim());
      return reply.result?.result?.value;
    };

    // Not fire-and-forget: if Runtime.enable is never acknowledged nothing subscribes to
    // Runtime.exceptionThrown/consoleAPICalled, and the console-error assertion at the end
    // then passes against a permanently empty list — a guard that silently checks nothing.
    const ack = async (method, params) => {
      const reply = await send(method, params);
      assert.notEqual(reply, UNANSWERED, `Chrome never acknowledged ${method}`);
      // An acknowledged FAILURE is not an acknowledgement: a rejected Runtime.enable
      // subscribes nothing, and the errors assertion at the end then proves nothing.
      assert.ok(!reply.error, `Chrome rejected ${method}: ${JSON.stringify(reply.error)}`);
      return reply;
    };
    await ack('Runtime.enable');
    await ack('Page.enable');
    const navigated = await ack('Page.navigate', { url });
    assert.ok(!navigated.result?.errorText,
      `Page.navigate failed: ${navigated.result?.errorText} — the tab may still show the page /json/new opened`);
    // The board renders off its first control-WS graph push, not DOMContentLoaded, and
    // #grid is empty in the HTML — so a child inside it means the client has rendered the
    // grid at all, which on this test's path (fresh data dir, no location hash) only
    // happens once that push has landed.
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
      // Three different failures reach here and the message must not conflate them —
      // a MISSING #grid is one of the very regressions this test exists to catch, and
      // the `?.` above reports it as the same falsy value as an empty one.
      const alive = !socketClosed && !cdpStalled && (await evaluate('1 + 1')) === 2;
      // `=== true` on purpose: a probe that times out yields undefined, which is NOT the
      // same answer as the page telling us #grid is absent.
      const hasGrid = alive && (await evaluate(`!!document.getElementById('grid')`)) === true;
      const readyState = alive ? await evaluate('document.readyState') : null;
      const bodyLen = alive ? await evaluate('document.body.innerText.trim().length') : null;
      // Re-read the transport flags AFTER the probes — one of them may be what broke.
      assert.fail(!alive || socketClosed || cdpStalled
        ? `the DevTools evaluate round trip stopped answering (socket ${socketClosed ? 'closed' : 'open'}${cdpStalled ? ', a call exceeded its bound' : ''}) — the tab or renderer died before the board rendered`
        : !hasGrid
          ? `#grid (the card grid) is missing from the document entirely (readyState=${readyState})`
          : `#grid never got a child: the first control-WS graph push never rendered (readyState=${readyState}, body text=${bodyLen} chars)`);
    }

    // Assert the page under test is the one we think it is — a stale or redirected tab
    // would otherwise be reported as a healthy board.
    assert.equal(await evaluateChecked('location.origin + "/"'), url, 'loaded a different page than expected');

    // A fresh instance legitimately has zero session cards, so "did it render" is the
    // shell being present — the blank-page regressions produced literally 0 characters.
    // Only meaningful now that the wait above holds it back until the graph has rendered:
    // against the FOUC window it was satisfied by markup the board never drew.
    assert.ok(await evaluateChecked(`document.body.innerText.trim().length > 0`), 'board rendered no text at all');
    assert.ok(await evaluateChecked(`!!document.getElementById('grid')`), '#grid (the card grid) is missing');

    // Contract points from the two real regressions: the element a module grabs at
    // import, and a CSS rule whose deletion is otherwise completely silent.
    assert.ok(await evaluateChecked(`!!document.getElementById('diff-layout-split')`), '#diff-layout-split is missing');
    assert.ok(
      await evaluateChecked(`[...document.styleSheets].flatMap(s=>{try{return [...s.cssRules]}catch{return []}}).some(r=>r.selectorText==='.diff-row')`),
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
