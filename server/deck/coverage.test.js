import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { CONTROL_HANDLERS } from '../control/handlers/index.js';
import { loadExtensions } from '../extensions/index.js';
import { buildGraph } from '../state-reader.js';
import { SESSIONS_DIR as HOOK_SESSIONS_DIR } from '../claude-paths.js';
import { CORE_ACTIONS, actionForHandler, buildActionRegistry } from './actions.js';
import { NATIVE_ACTIONS } from './native-actions.js';
import { deckDescriptor } from './descriptor.js';
import { SESSION_VIEW_DROPPED, SESSION_VIEW_FIELDS, sessionView } from './state.js';

const GROUPS = /^(session|task|schedule|deck|admin)\.[a-z][a-z0-9-]*$/;

test('every core control handler type maps to a grouped action, one to one', () => {
  const types = CONTROL_HANDLERS.map((h) => h.type);
  const unmapped = types.filter((t) => !CORE_ACTIONS[t]);
  assert.deepEqual(unmapped, [], 'add a CORE_ACTIONS row for each new handler');
  assert.deepEqual(Object.keys(CORE_ACTIONS).filter((t) => !types.includes(t)), [], 'no row for a handler that is gone');
  const names = Object.values(CORE_ACTIONS);
  assert.equal(new Set(names).size, names.length, 'action names are unique');
  for (const n of names) assert.match(n, GROUPS);
});

test('every builtin extension handler maps to ext.<id>.<type>', () => {
  const loaded = loadExtensions({ cfg: { extensions: new Proxy({}, { get: () => true }) }, coreHandlerTypes: CONTROL_HANDLERS.map((h) => h.type) });
  assert.ok(loaded.handlers.length > 0);
  for (const h of loaded.handlers) assert.equal(actionForHandler(h), `ext.${h.extId}.${h.type}`);
});

test('GET /deck advertises an action for every core and extension handler, plus the native reads', () => {
  const loaded = loadExtensions({ cfg: { extensions: new Proxy({}, { get: () => true }) }, coreHandlerTypes: CONTROL_HANDLERS.map((h) => h.type) });
  const handlers = [...CONTROL_HANDLERS, ...loaded.handlers];
  const registry = buildActionRegistry({ handlers, native: NATIVE_ACTIONS });
  const { actions } = deckDescriptor({ deckId: 'd', name: 'n', actions: registry.keys(), runtimes: [], extensions: loaded.list, boardApi: '1.0.0' });
  for (const h of handlers) assert.ok(actions.includes(actionForHandler(h)), `${h.type} is advertised`);
  assert.ok(actions.includes('session.file'));
  assert.ok(actions.includes('deck.ext-file'));
  assert.equal(actions.length, handlers.length + NATIVE_ACTIONS.length);
});

const manager = (entries, extra = {}) => {
  const byId = new Map(entries.map((e) => [e.sessionId, e]));
  return {
    activeEntries: () => entries.map((e) => ({ ...e })),
    archivedEntries: () => [],
    entryFor: (id) => byId.get(id),
    entryByTmux: () => null,
    tmuxOwner: () => null,
    tmuxNameFor: () => null,
    deadTmuxNameFor: () => null,
    isArchived: () => false,
    scanSockets: () => [''],
    socketOf: () => '',
    ...extra,
  };
};

// One record from each of buildGraph's session builders: a dormant mapping, a
// live status-file session, and a discovered tmux pane with no status file.
async function sampleSessions(t) {
  const dormant = await buildGraph(manager([{ sessionId: 'dormant-sid', agent: 'claude', cwd: '/nonexistent/c', intent: 'a' }]), async () => ({}));

  const hookPath = path.join(HOOK_SESSIONS_DIR, 'deck-coverage-test.json');
  const readdir = fs.readdirSync;
  const readFile = fs.readFileSync;
  t.mock.method(fs, 'readdirSync', (dir, ...args) => (dir === HOOK_SESSIONS_DIR ? ['deck-coverage-test.json'] : readdir(dir, ...args)));
  t.mock.method(fs, 'readFileSync', (file, ...args) => (file === hookPath ? JSON.stringify({ sessionId: 'live-sid', pid: process.pid, status: 'busy' }) : readFile(file, ...args)));
  const liveEntry = { sessionId: 'live-sid', agent: 'claude', tmux: 'cc_live' };
  const live = await buildGraph(manager([liveEntry], { alive: new Set(['cc_live']) }), async () => ({}), {
    discover: async () => [{ tmuxName: 'cc_live', claudePid: process.pid, agent: 'claude' }],
    capture: async () => '',
  });
  t.mock.restoreAll();

  const discEntry = { sessionId: 'disc-sid', agent: 'codex', liveSessionId: 'L1' };
  const discovered = await buildGraph(manager([], { entryFor: (id) => (id === 'disc-sid' ? discEntry : undefined), entryByTmux: (x) => (x === 'cx_d' ? discEntry : null) }), async () => ({}), {
    discover: async () => [{ tmuxName: 'cx_d', claudePid: 4242, agent: 'codex', command: 'codex' }],
    runtimeResolver: () => ({ analyze: async () => ({}) }),
    capture: async () => '',
  });
  return [...dormant.sessions, ...live.sessions, ...discovered.sessions];
}

test('every session-record field is either in the session view or dropped on purpose, and the view keeps every view field', async (t) => {
  const sessions = await sampleSessions(t);
  assert.ok(sessions.length >= 3, 'each builder produced a record');
  const keys = new Set(sessions.flatMap((s) => Object.keys(s)));
  const known = new Set([...SESSION_VIEW_FIELDS, ...SESSION_VIEW_DROPPED]);
  assert.deepEqual([...keys].filter((k) => !known.has(k)), [], 'classify each new field: add it to SESSION_VIEW_FIELDS, or to SESSION_VIEW_DROPPED after an audit of board code');
  for (const s of sessions) {
    const view = sessionView({ ...s, statusNoticeBlocked: false });
    for (const f of SESSION_VIEW_FIELDS) if (f in s || f === 'statusNoticeBlocked') assert.ok(f in view, `${f} is in the view`);
    for (const f of SESSION_VIEW_DROPPED) assert.ok(!(f in view), `${f} is dropped`);
  }
});

// The board stamps each session row with the deck it came from and the card key
// it names the card by (public/card-key.js stampDeck), so a deck field of either
// name would be overwritten on the board without a word.
test('no session-record field takes a name the board stamps on its cards', async (t) => {
  const sessions = await sampleSessions(t);
  const fields = new Set([...SESSION_VIEW_FIELDS, ...SESSION_VIEW_DROPPED, ...sessions.flatMap((s) => Object.keys(s))]);
  for (const name of ['deckId', 'cardKey']) assert.ok(!fields.has(name), `${name} is the board's own field on a session row`);
});
