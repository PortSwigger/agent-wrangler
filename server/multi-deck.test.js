import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { REPO_ROOT, findChrome, freePort, openTab, sleep, startInstance, waitFor } from './browser-harness.js';

// One board, two decks, in a real browser: the board's own instance (deck A)
// and a deck-only instance (deck B), each holding a session with the same id.
// The board shows both as separate cards, sends a card's action only to its
// own deck, and keeps deck B's cards, disabled, while deck B is down.

function seedSessions(dataDir, sessions) {
  const work = join(dataDir, 'work');
  mkdirSync(work, { recursive: true });
  writeFileSync(join(dataDir, 'mappings.json'), JSON.stringify(Object.fromEntries(
    sessions.map(([sessionId, name]) => [sessionId, { sessionId, agent: 'claude', cwd: work, intent: name, name }]),
  )));
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

async function deckSession(port, sessionId) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?api=1`);
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.type !== 'state') return;
      ws.close();
      resolve(m.sessions.find((s) => s.sessionId === sessionId) || null);
    });
    ws.on('error', reject);
  });
}

const CARDS = `JSON.stringify([...document.querySelectorAll('.session-card')].map((e) => ({
  card: e.dataset.card, name: e.querySelector('.card-name').textContent,
  deck: e.querySelector('.deck-badge')?.textContent ?? null, unreachable: e.classList.contains('deck-unreachable'),
})))`;

test('one board shows two decks\' cards, routes each card\'s action to its own deck, and keeps a stopped deck\'s cards disabled', { timeout: 180_000 }, async (t) => {
  const chromePath = findChrome();
  if (!chromePath) {
    assert.ok(!process.env.AW_REQUIRE_BROWSER, 'AW_REQUIRE_BROWSER is set but no Chrome/Chromium was found');
    return t.skip('no Chrome/Chromium found (set CHROME_BIN to enable)');
  }
  const dirA = mkdtempSync(join(tmpdir(), 'aw-multideck-a-'));
  const dirB = mkdtempSync(join(tmpdir(), 'aw-multideck-b-'));
  seedSessions(dirA, [['shared-0001', 'Login form'], ['a-only', 'Release notes']]);
  seedSessions(dirB, [['shared-0001', 'Importer profiling'], ['b-only', 'CI tidy-up']]);
  let a, b, tab;
  try {
    a = await startInstance(dirA);
    assert.ok(a.up, `deck A never started:\n${a.out()}`);
    const board = `http://127.0.0.1:${a.port}`;
    const portB = await freePort();
    const origins = `${board},http://localhost:${a.port}`;
    b = startDeckOnly(dirB, portB, origins);
    assert.ok(await waitFor(async () => (await fetch(`http://127.0.0.1:${portB}/deck`)).ok), `deck B never started:\n${b.out()}`);

    const post = (body) => fetch(`${board}/api/decks`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: board }, body: JSON.stringify(body) });
    assert.equal((await post({ op: 'update', id: 'own', name: 'Laptop A' })).status, 200);
    assert.equal((await post({ op: 'add', url: `http://127.0.0.1:${portB}`, name: 'Laptop B' })).status, 200);

    tab = await openTab(chromePath, `${board}/`);
    const four = await waitFor(async () => { const c = JSON.parse(await tab.evaluate(CARDS) || '[]'); return c.length === 4 && c.every((x) => x.deck) && c; });
    assert.ok(four, `the board never showed both decks' cards: ${await tab.evaluate(CARDS)}`);
    const shared = four.filter((c) => c.card.endsWith('/shared-0001'));
    assert.equal(shared.length, 2, 'the same session id on two decks is two cards');
    assert.deepEqual(shared.map((c) => [c.name, c.deck]).sort(), [['Importer profiling', 'Laptop B'], ['Login form', 'Laptop A']]);
    const cardB = shared.find((c) => c.deck === 'Laptop B').card;

    // Snooze deck B's copy from its own card menu.
    await tab.evaluate(`(() => {
      const el = document.querySelector('.session-card[data-card="${cardB}"]');
      const r = el.getBoundingClientRect();
      el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.x + 50, clientY: r.y + 20 }));
      const item = (label) => [...document.querySelectorAll('.context-menu button')].find((x) => x.textContent.trim().startsWith(label));
      item('Snooze').click();
      item('1 hour').click();
    })()`);
    const snoozedB = await waitFor(async () => (await deckSession(portB, 'shared-0001'))?.snooze);
    assert.ok(snoozedB, 'deck B snoozed its session');
    assert.equal((await deckSession(a.deckPort(), 'shared-0001')).snooze ?? null, null, 'deck A heard nothing');

    // Deck B stops: its cards stay, disabled. It comes back: they are live.
    b.proc.kill();
    const down = await waitFor(async () => {
      const rows = JSON.parse(await tab.evaluate(`JSON.stringify([...document.querySelectorAll('[data-card]')].filter((e) => e.matches('.session-card, .snoozed-row')).map((e) => [e.dataset.card, e.classList.contains('deck-unreachable')]))`));
      const onB = rows.filter(([card]) => !card.startsWith(four.find((c) => c.deck === 'Laptop A').card.split('/')[0]));
      return onB.length === 2 && onB.every(([, off]) => off) && rows;
    });
    assert.ok(down, 'deck B\'s cards stayed on the board, marked unreachable');
    b = startDeckOnly(dirB, portB, origins);
    const back = await waitFor(async () => { const c = JSON.parse(await tab.evaluate(CARDS)); return c.length >= 3 && c.every((x) => !x.unreachable) && c; });
    assert.ok(back, 'deck B\'s cards were live again once it restarted');
    assert.deepEqual(tab.errors, [], 'no console errors');
  } finally {
    await tab?.close();
    try { b?.proc.kill(); } catch {}
    try { a?.server.kill(); } catch {}
    await sleep(500);
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  }
});
