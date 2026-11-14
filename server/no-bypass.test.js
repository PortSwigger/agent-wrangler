import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, dirname, sep } from 'node:path';
import { REPO_ROOT, findChrome, waitFor, startInstance, openTab, sleep } from './browser-harness.js';

// The board reaches each deck only through the deck API: GET /deck, /ws and
// /pty on that deck's own origin (its own deck's, or the URL another deck was
// added by, through originForDeck). Its same-origin calls are the board
// server's /api/styles, since styles come from the board's own install, and
// its deck list (/api/decks and its stream). And no board code imports from
// server/. Board code is public/, each builtin extension's board half, and the
// per-deck fixture's board half (server/multi-deck-extensions.test.js).
const DECK_ROUTE = /^`\$\{(?:deckOrigin\(\)|origin\(\)|originForDeck\([\w.]+\))\.(http|ws)\}\/(deck|ws|pty)[?`]/;
const BOARD_ROUTES = new Set(["'/api/styles'", "'/api/decks'", "'/api/decks/stream'"]);
// Calls that never reach a deck, by file: a pasted image's own URL.
const NOT_DECK = { [join('public', 'clipboard-images.js')]: ['source.url'] };
const CALL = /\b(fetch|fetchImpl|WebSocket|WebSocketImpl|EventSource|EventSourceImpl|sendBeacon|\.open)\(\s*/g;
const IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|^\s*import\s*)(['"])([^'"]+)\1/gm;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { if (name !== 'vendor' && name !== 'node_modules') walk(p, out); }
    else if (p.endsWith('.js') && !p.endsWith('.test.js')) out.push(p);
  }
  return out;
}

export function boardFiles(root = REPO_ROOT) {
  const files = walk(join(root, 'public'));
  const builtin = join(root, 'server', 'extensions', 'builtin');
  for (const id of readdirSync(builtin)) {
    const pub = join(builtin, id, 'public');
    try { if (statSync(pub).isDirectory()) walk(pub, files); } catch {}
  }
  walk(join(root, 'server', 'fixtures', 'per-deck-probe', 'public'), files);
  return files;
}

// The argument text of a call: up to the first top-level comma or close paren.
function firstArg(src, from) {
  let depth = 0;
  let quote = null;
  const holes = [];
  for (let i = from; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === '\\') { i++; continue; }
      if (c === quote) quote = null;
      else if (quote === '`' && c === '$' && src[i + 1] === '{') { holes.push(depth); depth++; quote = null; i++; }
      continue;
    }
    if (c === '"' || c === "'" || c === '`') quote = c;
    else if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      if (c === '}' && holes.at(-1) === depth - 1) { holes.pop(); depth--; quote = '`'; continue; }
      if (depth === 0) return src.slice(from, i).trim();
      depth--;
    } else if (c === ',' && depth === 0) return src.slice(from, i).trim();
  }
  return src.slice(from).trim();
}

// Every network call and import in `src` that leaves the deck API, as
// "line: what".
export function bypasses(src, file, root = REPO_ROOT) {
  const found = [];
  const line = (i) => src.slice(0, i).split('\n').length;
  for (const m of src.matchAll(CALL)) {
    if (m[1] === '.open' && !/XMLHttpRequest|xhr/i.test(src)) continue;
    const arg = firstArg(src, m.index + m[0].length);
    if (arg === '...a') continue;
    const deck = DECK_ROUTE.exec(arg);
    if (deck && ((deck[1] === 'http' && deck[2] === 'deck') || (deck[1] === 'ws' && deck[2] !== 'deck'))) continue;
    if (BOARD_ROUTES.has(arg) || NOT_DECK[relative(root, file)]?.includes(arg)) continue;
    found.push(`${line(m.index)}: ${m[1]}(${arg})`);
  }
  const serverDir = join(root, 'server') + sep;
  const ownPublic = file.includes(`${sep}server${sep}extensions${sep}`) ? file.slice(0, file.indexOf(`${sep}public${sep}`) + `${sep}public${sep}`.length) : null;
  for (const m of src.matchAll(IMPORT)) {
    const spec = m[2];
    if (!spec.startsWith('.') && !spec.startsWith('/')) continue;
    const target = spec.startsWith('/') ? resolve(root, '.' + spec) : resolve(dirname(file), spec);
    if (target.startsWith(serverDir) && !(ownPublic && target.startsWith(ownPublic))) found.push(`${line(m.index)}: import ${spec}`);
  }
  return found;
}

test('board code reaches the deck only through /deck, /ws and /pty on the deck origin, and imports nothing from server/', () => {
  const files = boardFiles();
  assert.ok(files.some((f) => f.endsWith(`${sep}public${sep}app.js`)) && files.some((f) => f.includes(`builtin${sep}todos${sep}public`)));
  assert.ok(files.some((f) => f.endsWith(`${sep}public${sep}card-key.js`)), 'the card-key module is board code');
  assert.ok(files.some((f) => f.endsWith(`${sep}public${sep}decks.js`)) && files.some((f) => f.endsWith(`${sep}public${sep}decks-panel.js`)), 'the multi-deck modules are board code');
  assert.ok(files.some((f) => f.endsWith(`checklist${sep}public${sep}index.js`)), 'the checklist board half, which reads each card\'s own deck, is board code');
  const all = files.flatMap((f) => bypasses(readFileSync(f, 'utf8'), f).map((b) => `${relative(REPO_ROOT, f)}:${b}`));
  assert.deepEqual(all, []);
});

test('the scan catches each kind of bypass', () => {
  const f = join(REPO_ROOT, 'public', 'x.js');
  const ext = join(REPO_ROOT, 'server', 'extensions', 'builtin', 'todos', 'public', 'x.js');
  assert.deepEqual(bypasses("fetch('/file?path=' + p)", f), ["1: fetch('/file?path=' + p)"]);
  assert.deepEqual(bypasses('fetch(`${deckOrigin().http}/mcp`)', f), ['1: fetch(`${deckOrigin().http}/mcp`)']);
  assert.deepEqual(bypasses('new WebSocket(`ws://${location.host}/ws`)', f), ['1: WebSocket(`ws://${location.host}/ws`)']);
  assert.deepEqual(bypasses('new WebSocket(`${deckOrigin().http}/ws`)', f), ['1: WebSocket(`${deckOrigin().http}/ws`)']);
  assert.deepEqual(bypasses("import { x } from '../server/log.js';", f), ['1: import ../server/log.js']);
  assert.deepEqual(bypasses("const m = await import('../../index.js');", ext), ['1: import ../../index.js']);
  assert.deepEqual(bypasses("import { y } from './dom.js';", ext), []);
  assert.deepEqual(bypasses('fetch(`${deckOrigin().http}/deck`); new WebSocket(`${origin().ws}/ws?api=1`); new WebSocket(`${deckOrigin().ws}/pty?sessionId=${id}`)', f), []);
  assert.deepEqual(bypasses('new WebSocket(`${originForDeck(s.deckId).ws}/pty?sessionId=${id}`); fetchImpl(\'/api/decks\'); new EventSourceImpl(\'/api/decks/stream\')', f), []);
  assert.deepEqual(bypasses('new WebSocket(`${originForDeck(d).ws}/mcp`)', f), ['1: WebSocket(`${originForDeck(d).ws}/mcp`)']);
  assert.deepEqual(bypasses("new EventSourceImpl('/events')", f), ["1: EventSourceImpl('/events')"]);
});

// The same rule on the running board: every request the page makes either
// fetches a static board asset from the board's port or goes to the deck's
// port on /deck, /ws or /pty.
test('the running board loads from the board port and talks to the deck cross-origin', { timeout: 120_000 }, async (t) => {
  const chromePath = findChrome();
  if (!chromePath) {
    assert.ok(!process.env.AW_REQUIRE_BROWSER, 'AW_REQUIRE_BROWSER is set but no Chrome/Chromium was found');
    return t.skip('no Chrome/Chromium found (set CHROME_BIN to enable)');
  }
  const dataDir = mkdtempSync(join(tmpdir(), 'aw-nobypass-'));
  writeFileSync(join(dataDir, 'mappings.json'), '{}');
  let instance, tab;
  try {
    instance = await startInstance(dataDir);
    assert.ok(instance.up, 'dev instance never started serving');
    const deckPort = instance.deckPort();
    assert.ok(deckPort && deckPort !== instance.port, `the deck reported its own port:\n${instance.out()}`);
    tab = await openTab(chromePath, `http://127.0.0.1:${instance.port}/`);
    const ready = await waitFor(async () => tab.requests.some((u) => u.startsWith(`ws://127.0.0.1:${deckPort}/ws?api=1`)));
    assert.ok(ready, `the board never opened the deck's /ws:\n${tab.requests.join('\n')}`);
    await sleep(1000);
    const local = tab.requests.map((u) => new URL(u)).filter((u) => ['127.0.0.1', 'localhost'].includes(u.hostname));
    const toDeck = local.filter((u) => Number(u.port) === deckPort);
    const toBoard = local.filter((u) => Number(u.port) === instance.port);
    assert.equal(toDeck.length + toBoard.length, local.length, 'no loopback request goes anywhere else');
    assert.ok(toDeck.some((u) => u.protocol === 'http:' && u.pathname === '/deck'), 'GET /deck went to the deck');
    for (const u of toDeck) assert.ok(['/deck', '/ws', '/pty'].includes(u.pathname), `deck request outside the API: ${u.href}`);
    for (const u of toBoard) {
      assert.equal(u.protocol, 'http:', `no socket to the board's port: ${u.href}`);
      assert.ok(!['/deck', '/file', '/ext-file', '/mcp', '/ws', '/pty'].includes(u.pathname), `board code used a forwarded route: ${u.href}`);
    }
  } finally {
    await tab?.close();
    try { instance?.server.kill(); } catch {}
    await sleep(500);
    rmSync(dataDir, { recursive: true, force: true });
  }
});
