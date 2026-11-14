import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { REPO_ROOT, findChrome, openTab, sleep, startInstance, waitFor } from './browser-harness.js';

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

async function startDeckOnly(dataDir, origins, port = 0) {
  let out = '';
  const proc = spawn(process.execPath, ['server/cli.js', '--deck-only', '--data-dir', dataDir, '--allowed-origins', origins], {
    cwd: REPO_ROOT,
    env: { ...process.env, AW_DEV: '1', AW_DEV_IDLE_SHUTDOWN_MIN: '0', AW_DECK_PORT: String(port), AW_OPEN_BROWSER: '', AW_ALLOWED_ORIGINS: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', (c) => { out += c; });
  proc.stderr.on('data', (c) => { out += c; });
  const bound = Number(await waitFor(() => /deck API at http:\/\/127\.0\.0\.1:(\d+)/.exec(out)?.[1])) || null;
  return { proc, port: bound, out: () => out };
}

async function deckState(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?api=1`);
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.type !== 'state') return;
      ws.close();
      resolve(m);
    });
    ws.on('error', reject);
  });
}

async function deckSession(port, sessionId) {
  return (await deckState(port)).sessions.find((s) => s.sessionId === sessionId) || null;
}

function seedTasks(dataDir, tasks, assignments) {
  writeFileSync(join(dataDir, 'tasks.json'), JSON.stringify({
    tasks: tasks.map(([id, name]) => ({ id, name })), order: [...tasks.map(([id]) => id), 'adhoc'], assignments,
  }));
}

function seedSchedule(dataDir, id, name, sessionId) {
  writeFileSync(join(dataDir, 'schedules.json'), JSON.stringify({ schedules: [{
    id, name, enabled: true, when: { kind: 'cron', cron: '0 9 * * 1' }, action: { kind: 'session', sessionId, message: '' },
    createdAt: new Date().toISOString(), lastRunAt: null, lastSessionId: null, nextRunAt: null, missed: false,
  }] }));
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
    b = await startDeckOnly(dirB, `${board},http://localhost:${a.port}`);
    const portB = b.port;
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
    b = await startDeckOnly(dirB, `${board},http://localhost:${a.port}`, portB);
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

const TILES = `JSON.stringify([...document.querySelectorAll('.task-cell:not(.no-task)')].map((e) => ({
  id: e.dataset.taskid, deck: e.querySelector('.task-deck')?.textContent ?? null, name: e.querySelector('.task-name').textContent,
  cards: [...e.querySelectorAll('.session-card')].map((c) => c.dataset.card),
})))`;

test('each deck\'s tasks and schedules show under its name, and each task or schedule action reaches only its own deck', { timeout: 180_000 }, async (t) => {
  const chromePath = findChrome();
  if (!chromePath) {
    assert.ok(!process.env.AW_REQUIRE_BROWSER, 'AW_REQUIRE_BROWSER is set but no Chrome/Chromium was found');
    return t.skip('no Chrome/Chromium found (set CHROME_BIN to enable)');
  }
  const dirA = mkdtempSync(join(tmpdir(), 'aw-multitask-a-'));
  const dirB = mkdtempSync(join(tmpdir(), 'aw-multitask-b-'));
  // The same task id and schedule id on both decks: each is its own deck's.
  seedSessions(dirA, [['a-1', 'Login form']]);
  seedTasks(dirA, [['t_00000001', 'Auth revamp']], { 'a-1': 't_00000001' });
  seedSchedule(dirA, 'sch_00000001', 'Morning check', 'a-1');
  seedSessions(dirB, [['b-1', 'Importer profiling']]);
  seedTasks(dirB, [['t_00000001', 'Data pipeline'], ['t_00000002', 'Flaky tests']], { 'b-1': 't_00000001' });
  seedSchedule(dirB, 'sch_00000001', 'Nightly report', 'b-1');
  let a, b, tab;
  try {
    a = await startInstance(dirA);
    assert.ok(a.up, `deck A never started:\n${a.out()}`);
    const board = `http://127.0.0.1:${a.port}`;
    b = await startDeckOnly(dirB, `${board},http://localhost:${a.port}`);
    const portB = b.port;
    assert.ok(await waitFor(async () => (await fetch(`http://127.0.0.1:${portB}/deck`)).ok), `deck B never started:\n${b.out()}`);

    tab = await openTab(chromePath, `${board}/`);
    const single = await waitFor(async () => { const x = JSON.parse(await tab.evaluate(TILES) || '[]'); return x.length === 1 && x; });
    assert.deepEqual(single.map((x) => [x.deck, x.name]), [[null, 'Auth revamp']], 'with only its own deck, task tiles name no deck');

    const post = (body) => fetch(`${board}/api/decks`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: board }, body: JSON.stringify(body) });
    assert.equal((await post({ op: 'update', id: 'own', name: 'Laptop A' })).status, 200);
    assert.equal((await post({ op: 'add', url: `http://127.0.0.1:${portB}`, name: 'Laptop B' })).status, 200);

    const tiles = await waitFor(async () => { const x = JSON.parse(await tab.evaluate(TILES) || '[]'); return x.length === 3 && x.every((y) => y.cards.length || y.name === 'Flaky tests') && x; });
    assert.ok(tiles, `the board never showed both decks' tasks: ${await tab.evaluate(TILES)}`);
    assert.deepEqual(tiles.map((x) => [x.deck, x.name]), [['Laptop A', 'Auth revamp'], ['Laptop B', 'Data pipeline'], ['Laptop B', 'Flaky tests']]);
    const [authA, pipelineB, flakyB] = tiles;
    assert.notEqual(pipelineB.id, authA.id, 'the same task id on two decks is two tasks');
    assert.ok(authA.cards[0].endsWith('/a-1') && pipelineB.cards[0].endsWith('/b-1'), 'each card sits in its own deck\'s task');

    // Rename deck B's task from its tile.
    await tab.evaluate(`(() => {
      document.querySelector('.task-cell[data-taskid="${flakyB.id}"] .task-name').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      const input = document.querySelector('.task-name-input');
      input.value = 'Flaky tests (triaged)';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    })()`);
    const renamed = await waitFor(async () => (await deckState(portB)).tasks.tasks.find((x) => x.id === 't_00000002' && x.name === 'Flaky tests (triaged)'));
    assert.ok(renamed, 'deck B renamed its task');
    assert.deepEqual((await deckState(a.deckPort())).tasks.tasks.map((x) => x.name), ['Auth revamp'], 'deck A heard nothing');

    // A session cannot be moved onto another deck's task.
    const moved = await tab.send('Runtime.evaluate', { awaitPromise: true, returnByValue: true, expression: `import('/app.js').then((m) => m.send({ type: 'task-assign', sessionId: 'b-1', card: '${pipelineB.cards[0]}', taskId: '${authA.id}' }))` });
    assert.equal(moved.result?.result?.value, false, 'a cross-deck move is refused on the board');

    // The Schedules panel lists each deck's schedules under its name; a toggle
    // reaches only the schedule's own deck.
    await tab.evaluate(`document.getElementById('schedules-btn').click()`);
    const SCHED = `JSON.stringify([...document.querySelectorAll('.sched-deck')].map((g) => [g.querySelector('.sched-deck-name').textContent, [...g.querySelectorAll('.sched-name')].map((n) => n.textContent)]))`;
    const groups = await waitFor(async () => { const x = JSON.parse(await tab.evaluate(SCHED) || '[]'); return x.length === 2 && x; });
    assert.deepEqual(groups, [['Laptop A', ['Morning check']], ['Laptop B', ['Nightly report']]]);
    await tab.evaluate(`(() => { const box = [...document.querySelectorAll('.sched-deck')][1].querySelector('.sched-enable input'); box.checked = false; box.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    const off = await waitFor(async () => (await deckState(portB)).schedules.schedules.find((x) => x.id === 'sch_00000001' && x.enabled === false));
    assert.ok(off, 'deck B disabled its schedule');
    assert.equal((await deckState(a.deckPort())).schedules.schedules[0].enabled, true, 'deck A\'s schedule with the same id is untouched');
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

// The new-session dialog on a board with two decks. Deck B runs a runtime of
// its own (server/fixtures/deck-runtime-probe, whose pane runs `sleep`), so
// sessions really start there without an agent.
const DIALOG = `JSON.stringify({
  open: !document.getElementById('modal').classList.contains('hidden'),
  pickerShown: getComputedStyle(document.getElementById('m-deck-row')).display !== 'none',
  decks: [...document.getElementById('m-deck').options].map((o) => [o.value, o.textContent, o.disabled]),
  deck: document.getElementById('m-deck').value,
  deckLocked: document.getElementById('m-deck').disabled,
  task: document.getElementById('m-task').value,
  tasks: [...document.getElementById('m-task').options].map((o) => o.textContent),
  runtimes: [...document.getElementById('m-runtime').options].map((o) => o.value),
  intent: document.getElementById('m-intent').value,
})`;
const LAUNCH_ON_PROBE = (intent) => `(() => {
  const rt = document.getElementById('m-runtime');
  rt.value = 'probe-shell';
  rt.dispatchEvent(new Event('change', { bubbles: true }));
  const box = document.getElementById('m-intent');
  if (${JSON.stringify(intent)}) box.value = ${JSON.stringify(intent)};
  document.getElementById('m-go').click();
})()`;

test('the new-session dialog starts a session on the deck picked, in that deck\'s task, and an unreachable deck cannot be picked', { timeout: 180_000 }, async (t) => {
  const chromePath = findChrome();
  if (!chromePath) {
    assert.ok(!process.env.AW_REQUIRE_BROWSER, 'AW_REQUIRE_BROWSER is set but no Chrome/Chromium was found');
    return t.skip('no Chrome/Chromium found (set CHROME_BIN to enable)');
  }
  const dirA = mkdtempSync(join(tmpdir(), 'aw-multidispatch-a-'));
  const dirB = mkdtempSync(join(tmpdir(), 'aw-multidispatch-b-'));
  seedSessions(dirA, [['a-1', 'Login form']]);
  seedTasks(dirA, [['t_00000001', 'Auth revamp']], { 'a-1': 't_00000001' });
  seedSessions(dirB, [['b-1', 'Importer profiling']]);
  seedTasks(dirB, [['t_00000001', 'Data pipeline'], ['t_00000002', 'Flaky tests']], { 'b-1': 't_00000001' });
  writeFileSync(join(dirB, 'todos.json'), JSON.stringify({ migrated: true, todos: { t_00000002: [{ id: 'td_00000001', text: 'Fix the flaky login test', createdAt: Date.now() }] } }));
  cpSync(join(REPO_ROOT, 'server', 'fixtures', 'deck-runtime-probe'), join(dirB, 'extensions', 'deck-runtime-probe'), { recursive: true });
  let a, b, tab;
  try {
    a = await startInstance(dirA);
    assert.ok(a.up, `deck A never started:\n${a.out()}`);
    const board = `http://127.0.0.1:${a.port}`;
    b = await startDeckOnly(dirB, `${board},http://localhost:${a.port}`);
    const portB = b.port;
    assert.ok(await waitFor(async () => (await (await fetch(`http://127.0.0.1:${portB}/deck`)).json()).runtimes.some((r) => r.id === 'probe-shell')), `deck B never offered its runtime: ${JSON.stringify(await (await fetch(`http://127.0.0.1:${portB}/deck`)).json().catch(() => null))}\n${b.out()}`);
    const deckB = (await (await fetch(`http://127.0.0.1:${portB}/deck`)).json()).deckId;
    const dialog = async () => JSON.parse(await tab.evaluate(DIALOG));

    // With only its own deck the dialog has no picker and offers its own runtimes.
    tab = await openTab(chromePath, `${board}/`);
    assert.ok(await waitFor(async () => JSON.parse(await tab.evaluate(TILES) || '[]').length === 1), 'the board never drew its task');
    await tab.evaluate(`document.getElementById('new-session').click()`);
    const alone = await dialog();
    assert.equal(alone.open, true);
    assert.equal(alone.pickerShown, false, 'one deck: no deck picker');
    assert.ok(alone.runtimes.includes('local') && !alone.runtimes.includes('probe-shell'));
    await tab.evaluate(`document.getElementById('m-cancel').click()`);

    const post = (body) => fetch(`${board}/api/decks`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: board }, body: JSON.stringify(body) });
    assert.equal((await post({ op: 'update', id: 'own', name: 'Laptop A' })).status, 200);
    assert.equal((await post({ op: 'add', url: `http://127.0.0.1:${portB}`, name: 'Laptop B' })).status, 200);
    const tiles = await waitFor(async () => { const x = JSON.parse(await tab.evaluate(TILES) || '[]'); return x.length === 3 && x.every((y) => y.cards.length || y.name === 'Flaky tests') && x; });
    assert.ok(tiles, `the board never showed both decks' tasks: ${await tab.evaluate(TILES)}`);
    const [, pipelineB, flakyB] = tiles;

    // Deck B's task tile has a new-session button; it opens the dialog on deck B, in that task.
    assert.equal(await tab.evaluate(`Boolean(document.querySelector('.task-cell[data-taskid="${pipelineB.id}"] .task-new-sess'))`), true);
    await tab.evaluate(`document.querySelector('.task-cell[data-taskid="${pipelineB.id}"] .task-new-sess').click()`);
    const onB = await dialog();
    assert.equal(onB.pickerShown, true);
    assert.deepEqual(onB.decks, [['', 'Laptop A', false], [deckB, 'Laptop B', false]]);
    assert.equal(onB.deck, deckB);
    assert.equal(onB.task, pipelineB.id);
    assert.deepEqual(onB.tasks, ['Unassigned (no task)', 'Data pipeline', 'Flaky tests'], 'deck B\'s tasks only');
    assert.ok(onB.runtimes.includes('probe-shell'), `deck B's own runtime is offered: ${onB.runtimes}`);

    // Picking deck A offers deck A's tasks and runtimes; picking B again offers B's.
    const pick = (value) => tab.evaluate(`(() => { const s = document.getElementById('m-deck'); s.value = ${JSON.stringify(value)}; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await pick('');
    const onA = await dialog();
    assert.deepEqual(onA.tasks, ['Unassigned (no task)', 'Auth revamp']);
    assert.ok(!onA.runtimes.includes('probe-shell'), 'deck A does not run deck B\'s runtime');
    await pick(deckB);
    await tab.evaluate(`(() => { const s = document.getElementById('m-task'); s.value = ${JSON.stringify(pipelineB.id)}; })()`);

    const before = (await deckState(a.deckPort())).sessions.length;
    await tab.evaluate(LAUNCH_ON_PROBE('Profile the importer again'));
    const launched = await waitFor(async () => {
      const st = await deckState(portB);
      const s = st.sessions.find((x) => x.intent === 'Profile the importer again');
      return s && st.tasks.assignments[s.sessionId] === 't_00000001' && s;
    }, { tries: 120 });
    assert.ok(launched, `deck B started the session in its task:\n${b.out().slice(-2000)}`);
    assert.equal((await deckState(a.deckPort())).sessions.length, before, 'deck A started nothing');

    // Deck B's TODO starts a session on deck B, in its task, and is consumed there.
    const spawnBtn = `.task-cell[data-taskid="${flakyB.id}"] .todo-spawn`;
    assert.ok(await waitFor(async () => tab.evaluate(`Boolean(document.querySelector('${spawnBtn}'))`)), 'deck B\'s TODO has a start button');
    await tab.evaluate(`document.querySelector('${spawnBtn}').click()`);
    const fromTodo = await waitFor(async () => { const d = await dialog(); return d.open && d.deck === deckB && d; });
    assert.ok(fromTodo, 'the TODO opened the dialog on deck B');
    assert.equal(fromTodo.task, flakyB.id);
    assert.equal(fromTodo.deckLocked, true, 'locked to the TODO\'s task, so to its deck');
    assert.match(fromTodo.intent, /Fix the flaky login test/);
    await tab.evaluate(LAUNCH_ON_PROBE(''));
    const fromTodoLaunched = await waitFor(async () => {
      const st = await deckState(portB);
      const s = st.sessions.find((x) => /Fix the flaky login test/.test(x.intent || ''));
      return s && st.tasks.assignments[s.sessionId] === 't_00000002' && !(st.ext?.todos?.todos?.t_00000002 || []).length && s;
    }, { tries: 120 });
    assert.ok(fromTodoLaunched, 'deck B started the TODO\'s session in its task and consumed the TODO');
    assert.equal((await deckState(a.deckPort())).sessions.length, before, 'deck A still started nothing');

    // Deck B stops: its tiles offer no new session and the picker lists it disabled.
    b.proc.kill();
    assert.ok(await waitFor(async () => tab.evaluate(`document.querySelector('.task-cell[data-taskid="${pipelineB.id}"]').classList.contains('deck-unreachable')`)), 'deck B\'s tiles turned unreachable');
    assert.equal(await tab.evaluate(`Boolean(document.querySelector('.task-cell[data-taskid="${pipelineB.id}"] .task-new-sess'))`), false);
    await tab.evaluate(`document.getElementById('new-session').click()`);
    const down = await dialog();
    assert.deepEqual(down.decks, [['', 'Laptop A', false], [deckB, 'Laptop B (unreachable)', true]]);
    assert.equal(down.deck, '');
    await tab.evaluate(`document.getElementById('m-cancel').click()`);
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
