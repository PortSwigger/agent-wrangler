import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { REPO_ROOT, browserTestSkipReason, findChrome, openTab, sleep, startInstance, waitFor } from './browser-harness.js';

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

async function startDeckOnly(dataDir, origins, port = 0, env = {}) {
  let out = '';
  const proc = spawn(process.execPath, ['server/cli.js', '--deck-only', '--data-dir', dataDir, '--allowed-origins', origins], {
    cwd: REPO_ROOT,
    env: { ...process.env, ...env, AW_DEV: '1', AW_DEV_IDLE_SHUTDOWN_MIN: '0', AW_DECK_PORT: String(port), AW_OPEN_BROWSER: '', AW_ALLOWED_ORIGINS: '' },
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

test('one board shows two decks\' cards, routes each card\'s action to its own deck, and keeps a stopped deck\'s cards disabled', { timeout: 180_000, skip: browserTestSkipReason() }, async (t) => {
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

test('each deck\'s tasks and schedules show under its name, and each task or schedule action reaches only its own deck', { timeout: 180_000, skip: browserTestSkipReason() }, async (t) => {
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
const LAUNCH_ON_PROBE = (intent, runtime = 'probe-shell') => `(() => {
  const rt = document.getElementById('m-runtime');
  rt.value = ${JSON.stringify(runtime)};
  rt.dispatchEvent(new Event('change', { bubbles: true }));
  const box = document.getElementById('m-intent');
  if (${JSON.stringify(intent)}) box.value = ${JSON.stringify(intent)};
  document.getElementById('m-go').click();
})()`;

test('the new-session dialog starts a session on the deck picked, in that deck\'s task, and an unreachable deck cannot be picked', { timeout: 180_000, skip: browserTestSkipReason() }, async (t) => {
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

// New tasks and schedules on a board with two decks: each lands only on the
// deck picked, and with one deck neither asks for a deck.
const MENU = `JSON.stringify([...document.querySelectorAll('.context-menu > *')].map((e) => [e.textContent.trim(), Boolean(e.disabled)]))`;

test('a new task or schedule lands on the deck picked, and an unreachable deck cannot be picked', { timeout: 180_000, skip: browserTestSkipReason() }, async (t) => {
  const chromePath = findChrome();
  if (!chromePath) {
    assert.ok(!process.env.AW_REQUIRE_BROWSER, 'AW_REQUIRE_BROWSER is set but no Chrome/Chromium was found');
    return t.skip('no Chrome/Chromium found (set CHROME_BIN to enable)');
  }
  const dirA = mkdtempSync(join(tmpdir(), 'aw-multinew-a-'));
  const dirB = mkdtempSync(join(tmpdir(), 'aw-multinew-b-'));
  seedSessions(dirA, [['a-1', 'Login form']]);
  seedTasks(dirA, [['t_00000001', 'Auth revamp']], { 'a-1': 't_00000001' });
  seedSessions(dirB, [['b-1', 'Importer profiling']]);
  seedTasks(dirB, [['t_00000001', 'Data pipeline'], ['t_00000002', 'Flaky tests']], { 'b-1': 't_00000001' });
  cpSync(join(REPO_ROOT, 'server', 'fixtures', 'deck-runtime-probe'), join(dirB, 'extensions', 'deck-runtime-probe'), { recursive: true });
  let a, b, tab;
  try {
    a = await startInstance(dirA);
    assert.ok(a.up, `deck A never started:\n${a.out()}`);
    const board = `http://127.0.0.1:${a.port}`;
    b = await startDeckOnly(dirB, `${board},http://localhost:${a.port}`);
    const portB = b.port;
    assert.ok(await waitFor(async () => (await (await fetch(`http://127.0.0.1:${portB}/deck`)).json()).runtimes.some((r) => r.id === 'probe-shell')), `deck B never offered its runtime:\n${b.out()}`);
    const deckB = (await (await fetch(`http://127.0.0.1:${portB}/deck`)).json()).deckId;
    const dialog = async () => JSON.parse(await tab.evaluate(DIALOG));
    const taskNames = async (port) => (await deckState(port)).tasks.tasks.map((x) => x.name);
    const scheduleNames = async (port) => (await deckState(port)).schedules.schedules.map((x) => x.name);

    // With only its own deck, New task makes a task straight away and the
    // schedule dialog has no picker.
    tab = await openTab(chromePath, `${board}/`);
    assert.ok(await waitFor(async () => JSON.parse(await tab.evaluate(TILES) || '[]').length === 1), 'the board never drew its task');
    await tab.evaluate(`document.getElementById('new-task').click()`);
    assert.ok(await waitFor(async () => (await taskNames(a.deckPort())).length === 2), 'one deck: New task made a task on the board\'s own deck');
    assert.deepEqual(JSON.parse(await tab.evaluate(MENU)), [], 'one deck: New task opens no deck menu');
    await tab.evaluate(`document.activeElement?.blur?.(); document.body.click()`);
    await tab.evaluate(`document.getElementById('schedules-btn').click(); document.getElementById('schedules-new').click()`);
    const alone = await dialog();
    assert.equal(alone.open, true);
    assert.equal(alone.pickerShown, false, 'one deck: no deck picker in the schedule dialog');
    await tab.evaluate(`document.getElementById('m-cancel').click(); document.getElementById('schedules-close')?.click()`);

    const post = (body) => fetch(`${board}/api/decks`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: board }, body: JSON.stringify(body) });
    assert.equal((await post({ op: 'update', id: 'own', name: 'Laptop A' })).status, 200);
    assert.equal((await post({ op: 'add', url: `http://127.0.0.1:${portB}`, name: 'Laptop B' })).status, 200);
    const tiles = await waitFor(async () => { const x = JSON.parse(await tab.evaluate(TILES) || '[]'); return x.filter((y) => y.deck === 'Laptop B').length === 2 && x; });
    assert.ok(tiles, `the board never showed deck B's tasks: ${await tab.evaluate(TILES)}`);
    const flakyB = tiles.find((x) => x.name === 'Flaky tests');
    const tasksA = await taskNames(a.deckPort());

    // New task asks for a deck; picking deck B makes the task there alone.
    await tab.evaluate(`document.getElementById('new-task').click()`);
    assert.deepEqual(JSON.parse(await tab.evaluate(MENU)), [['New task on', false], ['Laptop A', false], ['Laptop B', false]]);
    await tab.evaluate(`[...document.querySelectorAll('.context-menu-item')].find((x) => x.textContent.trim() === 'Laptop B').click()`);
    const madeB = await waitFor(async () => { const names = await taskNames(portB); return names.length === 3 && names; });
    assert.ok(madeB, 'deck B made the new task');
    assert.deepEqual(await taskNames(a.deckPort()), tasksA, 'deck A made nothing');
    const newTile = await waitFor(async () => JSON.parse(await tab.evaluate(TILES)).filter((y) => y.deck === 'Laptop B').length === 3);
    assert.ok(newTile, 'the new task shows under deck B');

    // The schedule dialog's picker: deck B offers its tasks, runtimes and sessions.
    await tab.evaluate(`document.getElementById('schedules-btn').click(); document.getElementById('schedules-new').click()`);
    const sched = await dialog();
    assert.equal(sched.pickerShown, true);
    assert.deepEqual(sched.decks, [['', 'Laptop A', false], [deckB, 'Laptop B', false]]);
    assert.equal(sched.deck, '', 'the board\'s own deck is picked by default');
    await tab.evaluate(`(() => { const s = document.getElementById('m-deck'); s.value = ${JSON.stringify(deckB)}; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    const schedB = await dialog();
    assert.deepEqual(schedB.tasks.slice(0, 3), ['Unassigned (no task)', 'Data pipeline', 'Flaky tests'], 'deck B\'s tasks only');
    assert.ok(schedB.runtimes.includes('probe-shell'), `deck B's own runtime is offered: ${schedB.runtimes}`);
    assert.deepEqual(JSON.parse(await tab.evaluate(`JSON.stringify([...document.getElementById('m-sch-target').options].map((o) => o.value))`)), ['b-1'], 'deck B\'s sessions only');
    const schedulesA = await scheduleNames(a.deckPort());
    await tab.evaluate(`(() => {
      document.getElementById('m-sch-name').value = 'Nightly flake sweep';
      const c = document.getElementById('m-sch-cadence'); c.value = 'daily'; c.dispatchEvent(new Event('change', { bubbles: true }));
      document.getElementById('m-task').value = ${JSON.stringify(flakyB.id)};
      document.getElementById('m-intent').value = 'Rerun the flaky suite';
      const rt = document.getElementById('m-runtime'); rt.value = 'probe-shell'; rt.dispatchEvent(new Event('change', { bubbles: true }));
      document.getElementById('m-go').click();
    })()`);
    const savedB = await waitFor(async () => (await deckState(portB)).schedules.schedules.find((x) => x.name === 'Nightly flake sweep'));
    assert.ok(savedB, `deck B saved the schedule:\n${b.out().slice(-2000)}`);
    assert.equal(savedB.action.kind, 'dispatch');
    assert.equal(savedB.action.dispatch.taskId, 't_00000002', 'named by deck B\'s own task id');
    assert.equal(savedB.action.dispatch.runtime, 'probe-shell');
    assert.deepEqual(await scheduleNames(a.deckPort()), schedulesA, 'deck A saved nothing');
    const SCHED = `JSON.stringify([...document.querySelectorAll('.sched-deck')].map((g) => [g.querySelector('.sched-deck-name').textContent, [...g.querySelectorAll('.sched-name')].map((n) => n.textContent)]))`;
    assert.ok(await waitFor(async () => JSON.parse(await tab.evaluate(SCHED) || '[]').some(([deck, names]) => deck === 'Laptop B' && names.includes('Nightly flake sweep'))), `listed under deck B: ${await tab.evaluate(SCHED)}`);

    // Deck B stops: both pickers list it, disabled.
    b.proc.kill();
    assert.ok(await waitFor(async () => tab.evaluate(`document.querySelector('.task-cell[data-taskid="${flakyB.id}"]').classList.contains('deck-unreachable')`)), 'deck B\'s tiles turned unreachable');
    await tab.evaluate(`document.getElementById('schedules-new').click()`);
    const down = await dialog();
    assert.deepEqual(down.decks, [['', 'Laptop A', false], [deckB, 'Laptop B (unreachable)', true]]);
    assert.equal(down.deck, '');
    await tab.evaluate(`document.getElementById('m-cancel').click()`);
    await tab.evaluate(`document.getElementById('new-task').click()`);
    assert.deepEqual(JSON.parse(await tab.evaluate(MENU)), [['New task on', false], ['Laptop A', false], ['Laptop B (unreachable)', true]]);
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

// A deck-only instance whose agent command is not installed: each launch fails
// at once. The first lands on a tmux server with no other sessions, the second
// on one that still holds the first's corpse; both keep their dead pane, so the
// board shows the card with the command's output, and the deck logs the failure.
test('a launch whose agent command is missing shows its card with the command\'s output, and the deck logs it', { timeout: 180_000 }, async (t) => {
  const chromePath = findChrome();
  if (!chromePath) {
    assert.ok(!process.env.AW_REQUIRE_BROWSER, 'AW_REQUIRE_BROWSER is set but no Chrome/Chromium was found');
    return t.skip('no Chrome/Chromium found (set CHROME_BIN to enable)');
  }
  const dirA = mkdtempSync(join(tmpdir(), 'aw-failedlaunch-a-'));
  const dirB = mkdtempSync(join(tmpdir(), 'aw-failedlaunch-b-'));
  seedSessions(dirA, [['a-1', 'Login form']]);
  writeFileSync(join(dirB, 'mappings.json'), '{}');
  cpSync(join(REPO_ROOT, 'server', 'fixtures', 'deck-runtime-probe'), join(dirB, 'extensions', 'deck-runtime-probe'), { recursive: true });
  let a, b, tab;
  try {
    a = await startInstance(dirA);
    assert.ok(a.up, `deck A never started:\n${a.out()}`);
    const board = `http://127.0.0.1:${a.port}`;
    b = await startDeckOnly(dirB, `${board},http://localhost:${a.port}`);
    const portB = b.port;
    assert.ok(await waitFor(async () => (await (await fetch(`http://127.0.0.1:${portB}/deck`)).json()).runtimes.some((r) => r.id === 'probe-missing')), `deck B never offered its runtime:\n${b.out()}`);
    const deckB = (await (await fetch(`http://127.0.0.1:${portB}/deck`)).json()).deckId;
    const post = (body) => fetch(`${board}/api/decks`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: board }, body: JSON.stringify(body) });
    assert.equal((await post({ op: 'add', url: `http://127.0.0.1:${portB}`, name: 'Laptop B' })).status, 200);
    tab = await openTab(chromePath, `${board}/`);
    assert.ok(await waitFor(async () => JSON.parse(await tab.evaluate(CARDS) || '[]').length === 1), 'the board never drew its card');

    for (const intent of ['Launch on an empty tmux server', 'Launch beside another session']) {
      await tab.evaluate(`document.getElementById('new-session').click()`);
      assert.ok(await waitFor(async () => tab.evaluate(`[...document.getElementById('m-deck').options].some((o) => o.value === ${JSON.stringify(deckB)} && !o.disabled)`)), 'deck B is offered');
      await tab.evaluate(`(() => { const s = document.getElementById('m-deck'); s.value = ${JSON.stringify(deckB)}; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
      await tab.evaluate(LAUNCH_ON_PROBE(intent, 'probe-missing'));
      const failed = await waitFor(async () => {
        const s = (await deckState(portB)).sessions.find((x) => x.intent === intent);
        return s?.exitOutput && s;
      }, { tries: 120 });
      assert.ok(failed, `${intent}: deck B kept the dead pane's output:\n${b.out().slice(-2000)}`);
      assert.match(failed.exitOutput, /aw-probe-missing-agent-cli/);
      assert.match(failed.exitOutput, /not found/);
      const logged = await waitFor(() => new RegExp(`launch failed ${failed.sessionId} \\(tmux \\S+\\) — exit 127: .*aw-probe-missing-agent-cli`).test(b.out()));
      assert.ok(logged, `${intent}: deck B logged the failed launch:\n${b.out().slice(-2000)}`);

      const card = `.session-card[data-card$="/${failed.sessionId}"]`;
      assert.ok(await waitFor(async () => tab.evaluate(`Boolean(document.querySelector('${card}'))`)), `${intent}: the board shows the card`);
      await tab.evaluate(`document.querySelector('${card}').click()`);
      const shown = await waitFor(async () => tab.evaluate(`[...document.querySelectorAll('#term .term-exit, #chat-exit-notice:not([hidden])')].map((e) => e.textContent).join('\\n')`));
      assert.match(shown || '', /aw-probe-missing-agent-cli/, `${intent}: the card's panel shows the command's output`);
    }
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

// A deck whose PATH holds tmux and git but no agent CLI: the board offers no
// agent on it until one is installed there.
const AGENTS = `JSON.stringify({
  agents: [...new Set([...document.getElementById('m-model').options].map((o) => o.dataset.agent))],
  noneShown: !document.getElementById('m-no-agents').classList.contains('hidden'),
  pickerHidden: document.getElementById('m-model-picker').classList.contains('hidden'),
  runtime: document.getElementById('m-runtime').value,
  note: document.getElementById('m-no-agents').textContent,
  goDisabled: document.getElementById('m-go').disabled,
})`;

test('the dialog offers only the agents a deck has installed, and says so when it has none', { timeout: 180_000 }, async (t) => {
  const chromePath = findChrome();
  if (!chromePath) {
    assert.ok(!process.env.AW_REQUIRE_BROWSER, 'AW_REQUIRE_BROWSER is set but no Chrome/Chromium was found');
    return t.skip('no Chrome/Chromium found (set CHROME_BIN to enable)');
  }
  const dirA = mkdtempSync(join(tmpdir(), 'aw-multiagents-a-'));
  const dirB = mkdtempSync(join(tmpdir(), 'aw-multiagents-b-'));
  const bin = mkdtempSync(join(tmpdir(), 'aw-multiagents-bin-'));
  for (const tool of ['tmux', 'git']) {
    const at = spawnSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim();
    if (at) symlinkSync(at, join(bin, tool));
  }
  seedTasks(dirB, [['t_00000001', 'Data pipeline']], {});
  let a, b, tab;
  try {
    a = await startInstance(dirA);
    assert.ok(a.up, `deck A never started:\n${a.out()}`);
    const board = `http://127.0.0.1:${a.port}`;
    b = await startDeckOnly(dirB, `${board},http://localhost:${a.port}`, 0, { PATH: `${bin}:/usr/bin:/bin` });
    const portB = b.port;
    const localAgents = async () => (await (await fetch(`http://127.0.0.1:${portB}/deck`)).json()).runtimes.find((r) => r.id === 'local')?.agents;
    assert.deepEqual(await waitFor(localAgents), [], `deck B listed agents it cannot run:\n${b.out()}`);
    const deckB = (await (await fetch(`http://127.0.0.1:${portB}/deck`)).json()).deckId;

    tab = await openTab(chromePath, `${board}/`);
    const post = (body) => fetch(`${board}/api/decks`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: board }, body: JSON.stringify(body) });
    assert.equal((await post({ op: 'add', url: `http://127.0.0.1:${portB}`, name: 'Laptop B' })).status, 200);
    const pick = (value) => tab.evaluate(`(() => { const s = document.getElementById('m-deck'); s.value = ${JSON.stringify(value)}; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    const agents = async () => JSON.parse(await tab.evaluate(AGENTS));
    const pickable = `[...document.getElementById('m-deck').options].some((o) => o.value === ${JSON.stringify(deckB)} && !o.disabled)`;

    assert.ok(await waitFor(async () => { await tab.evaluate(`document.getElementById('new-session').click()`); return tab.evaluate(pickable); }), 'deck B never became pickable');
    await pick(deckB);
    const none = await waitFor(async () => { const d = await agents(); return d.noneShown && d; });
    assert.ok(none, `the dialog never said deck B has no agent: ${JSON.stringify(await agents())}`);
    assert.deepEqual(none.agents, [], 'no agent offered');
    assert.equal(none.pickerHidden, true);
    assert.equal(none.runtime, 'local');
    assert.equal(none.note, 'No agent is installed on this deck.');
    assert.equal(none.goDisabled, true, 'Launch is disabled');
    const runtime = (value) => tab.evaluate(`(() => { const s = document.getElementById('m-runtime'); s.value = ${JSON.stringify(value)}; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await runtime('devcontainer');
    const inContainer = await agents();
    assert.deepEqual(inContainer.agents, ['claude'], 'the devcontainer runtime still runs its own agent');
    assert.equal(inContainer.noneShown, false);
    await runtime('local');
    assert.equal((await agents()).noneShown, true);
    await pick('');
    const own = await agents();
    assert.equal(own.noneShown, false, 'the board\'s own deck still offers its agents');
    assert.ok(own.agents.includes('claude'));
    await tab.evaluate(`document.getElementById('m-cancel').click()`);

    writeFileSync(join(bin, 'claude'), '#!/bin/sh\nexit 0\n');
    chmodSync(join(bin, 'claude'), 0o755);
    assert.deepEqual(await waitFor(async () => { const l = await localAgents(); return l?.length && l; }, { tries: 60, every: 500 }), ['claude'], 'deck B saw the CLI installed after it started');

    await tab.evaluate(`document.getElementById('new-session').click()`);
    await pick(deckB);
    const claudeOnly = await waitFor(async () => { const d = await agents(); return !d.noneShown && d.agents.length && d; });
    assert.ok(claudeOnly, `the dialog never offered deck B's agent: ${JSON.stringify(await agents())}`);
    assert.deepEqual(claudeOnly.agents, ['claude'], 'only the agent deck B has installed');
    assert.equal(claudeOnly.goDisabled, false, 'Launch is enabled');
    await tab.evaluate(`document.getElementById('m-cancel').click()`);
    assert.deepEqual(tab.errors, [], 'no console errors');
  } finally {
    await tab?.close();
    try { b?.proc.kill(); } catch {}
    try { a?.server.kill(); } catch {}
    await sleep(500);
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
  }
});
