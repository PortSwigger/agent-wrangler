import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { REPO_ROOT, findChrome, freePort, openTab, sleep, startInstance, waitFor } from './browser-harness.js';

// One board half serving several decks, in a real browser: the board's own
// instance (deck A) and two deck-only instances (B, and C, whose copy of the
// extension declares another boardApi). The fixture's view shows one section
// per deck, an action in a section reaches only that deck, and deck C's
// section says it is incompatible. The builtin checklist shows the open card's
// own deck's list and writes only there.

const FIXTURE = join(REPO_ROOT, 'server', 'fixtures', 'per-deck-probe');

function seedDeck(dataDir, { sessions, checklists, boardApi = null }) {
  const work = join(dataDir, 'work');
  mkdirSync(work, { recursive: true });
  writeFileSync(join(dataDir, 'mappings.json'), JSON.stringify(Object.fromEntries(
    sessions.map(([sessionId, name]) => [sessionId, { sessionId, agent: 'claude', cwd: work, intent: name, name }]),
  )));
  writeFileSync(join(dataDir, 'checklists.json'), JSON.stringify(checklists));
  const extDir = join(dataDir, 'extensions', 'per-deck-probe');
  cpSync(FIXTURE, extDir, { recursive: true });
  if (boardApi) {
    const manifest = join(extDir, 'index.js');
    writeFileSync(manifest, readFileSync(manifest, 'utf8').replace("boardApi: '^1.78.0'", `boardApi: '${boardApi}'`));
  }
  writeFileSync(join(dataDir, 'extensions.json'), JSON.stringify({ 'per-deck-probe': { id: 'per-deck-probe', requires: ['board:rebuild'] } }));
}

function startDeckOnly(dataDir, port, origins) {
  let out = '';
  const proc = spawn(process.execPath, ['server/cli.js', '--deck-only', '--port', String(port), '--data-dir', dataDir, '--allowed-origins', origins], {
    cwd: REPO_ROOT,
    env: { ...process.env, AW_DEV: '1', AW_DEV_IDLE_SHUTDOWN_MIN: '0', AW_OPEN_BROWSER: '', AW_ALLOWED_ORIGINS: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', (c) => { out += c; });
  proc.stderr.on('data', (c) => { out += c; });
  return { proc, out: () => out };
}

// One extension's state as the deck itself reports it on its state frame.
async function deckExt(port, extId) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?api=1`);
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.type !== 'state') return;
      ws.close();
      resolve(m.ext?.[extId] ?? null);
    });
    ws.on('error', reject);
  });
}

const SECTIONS = `JSON.stringify([...document.querySelectorAll('.pdp-deck')].map((s) => ({
  deck: s.dataset.deck, status: s.dataset.status, title: s.querySelector('h3').textContent,
  count: s.querySelector('.pdp-count')?.textContent ?? null, note: s.querySelector('.pdp-status')?.textContent ?? null,
})))`;

test('one board half shows a section per deck, acts on that deck alone, and marks a deck with another boardApi incompatible', { timeout: 180_000 }, async (t) => {
  const chromePath = findChrome();
  if (!chromePath) {
    assert.ok(!process.env.AW_REQUIRE_BROWSER, 'AW_REQUIRE_BROWSER is set but no Chrome/Chromium was found');
    return t.skip('no Chrome/Chromium found (set CHROME_BIN to enable)');
  }
  const dirs = ['a', 'b', 'c'].map((x) => mkdtempSync(join(tmpdir(), `aw-multideck-ext-${x}-`)));
  const item = (id, text) => [{ id, text, done: false, createdAt: 1 }];
  seedDeck(dirs[0], { sessions: [['shared-0001', 'Login form']], checklists: { 'shared-0001': item('a1', 'Deck A step') } });
  seedDeck(dirs[1], { sessions: [['shared-0001', 'Importer profiling']], checklists: { 'shared-0001': item('b1', 'Deck B step') } });
  seedDeck(dirs[2], { sessions: [['c-only', 'CI tidy-up']], checklists: {}, boardApi: '^1.76.0' });
  let a, b, c, tab;
  try {
    a = await startInstance(dirs[0]);
    assert.ok(a.up, `deck A never started:\n${a.out()}`);
    const board = `http://127.0.0.1:${a.port}`;
    const origins = `${board},http://localhost:${a.port}`;
    const [portB, portC] = [await freePort(), await freePort()];
    b = startDeckOnly(dirs[1], portB, origins);
    c = startDeckOnly(dirs[2], portC, origins);
    for (const [port, d] of [[portB, b], [portC, c]]) {
      assert.ok(await waitFor(async () => (await fetch(`http://127.0.0.1:${port}/deck`)).ok), `a deck never started:\n${d.out()}`);
    }
    const listed = await waitFor(async () => (await (await fetch(`http://127.0.0.1:${portC}/deck`)).json()).extensions.find((e) => e.id === 'per-deck-probe'));
    assert.equal(listed?.boardApi, '^1.76.0', 'deck C lists the extension with its own boardApi');

    const post = (body) => fetch(`${board}/api/decks`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: board }, body: JSON.stringify(body) });
    assert.equal((await post({ op: 'update', id: 'own', name: 'Laptop A' })).status, 200);
    assert.equal((await post({ op: 'add', url: `http://127.0.0.1:${portB}`, name: 'Laptop B' })).status, 200);
    assert.equal((await post({ op: 'add', url: `http://127.0.0.1:${portC}`, name: 'Laptop C' })).status, 200);

    tab = await openTab(chromePath, `${board}/#view=ext:per-deck-probe:main`);
    const three = await waitFor(async () => {
      const s = JSON.parse(await tab.evaluate(SECTIONS) || '[]');
      return s.length === 3 && s.every((x) => x.status !== 'unreachable') && s;
    });
    assert.ok(three, `the view never showed a section per deck: ${await tab.evaluate(SECTIONS)}`);
    assert.deepEqual(three.map((s) => [s.title.replace(/ \(.*/, ''), s.status, s.count]), [
      ['Laptop A', 'ready', '0'], ['Laptop B', 'ready', '0'], ['Laptop C', 'incompatible', null],
    ]);
    assert.match(three[2].note, /Incompatible.*\^1\.76\.0/);
    assert.equal(await tab.evaluate("document.querySelectorAll('link[data-ext=\"per-deck-probe\"]').length"), 1, 'the board half is loaded once, from the board\'s install');

    // Bump on deck B: only deck B counts it.
    await tab.evaluate(`document.querySelector('.pdp-deck[data-deck="${three[1].deck}"] .pdp-bump').click()`);
    const bumped = await waitFor(async () => { const s = JSON.parse(await tab.evaluate(SECTIONS)); return s[1].count === '1' && s; });
    assert.ok(bumped, `deck B's section never showed its bump: ${await tab.evaluate(SECTIONS)}`);
    assert.equal(bumped[0].count, '0', 'deck A\'s section is unchanged');
    assert.deepEqual(await deckExt(portB, 'per-deck-probe'), { count: 1 });
    assert.deepEqual(await deckExt(a.deckPort(), 'per-deck-probe'), { count: 0 }, 'deck A heard nothing');

    // The builtin checklist shows deck B's list on deck B's card and writes there alone.
    const cardB = `${three[1].deck}/shared-0001`;
    await tab.evaluate(`(() => { location.hash = ''; })()`);
    await sleep(300);
    const opened = await waitFor(async () => tab.evaluate(`(() => {
      const card = document.querySelector('.session-card[data-card="${cardB}"]');
      if (!card) return false;
      card.click();
      const pill = document.getElementById('panel-checklist-toggle');
      if (!pill) return false;
      if (pill.getAttribute('aria-expanded') !== 'true') pill.click();
      return [...document.querySelectorAll('#checklist .ck-row .ck-text')].map((r) => r.textContent.trim()).join('|') || false;
    })()`));
    assert.equal(opened, 'Deck B step', 'deck B\'s card shows deck B\'s checklist, not deck A\'s');
    await tab.evaluate(`document.querySelector('#checklist .ck-row .ck-check').click()`);
    const done = await waitFor(async () => (await deckExt(portB, 'checklist'))?.checklists?.['shared-0001']?.[0]?.done === true);
    assert.ok(done, 'deck B recorded the tick');
    assert.equal((await deckExt(a.deckPort(), 'checklist')).checklists['shared-0001'][0].done, false, 'deck A\'s item with the same session id is untouched');
    assert.deepEqual(tab.errors, [], 'no console errors');
  } finally {
    await tab?.close();
    for (const d of [b, c]) { try { d?.proc.kill(); } catch {} }
    try { a?.server.kill(); } catch {}
    await sleep(500);
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  }
});
