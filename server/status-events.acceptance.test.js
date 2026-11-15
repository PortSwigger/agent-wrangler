import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createSessionApi } from './session-api/index.js';
import { createStatusEventStore, createStatusEventHandler, STATUS_EVENT_MAX_BYTES } from './status-events.js';
import { STATUS_HOOK_PATH } from './status-hooks.js';
import { registerRuntime, unregisterRuntimesFor, findRuntime, takesStatusEvents } from './runtimes/index.js';
import { buildGraph } from './state-reader.js';
import { SESSIONS_DIR } from './claude-paths.js';

// The three acceptance scenarios end to end: the session API's own listener with
// the real caller check and token store, the status-event handler wired the way
// server/index.js wires it, the real hook script, and buildGraph reading the
// board's status. EVENTS runs on an extension runtime that opts in
// (`statusEvents: true`); FILES runs on the local runtime.
const EXT = 'events-acceptance';
const RT = 'events-test';
const entries = {
  EVENTS: { sessionId: 'EVENTS', agent: 'claude', runtime: RT, liveSessionId: 'live-events', tmux: 'aw_events', cwd: '/w' },
  PEER: { sessionId: 'PEER', agent: 'claude', runtime: RT, liveSessionId: 'live-peer', tmux: 'aw_peer', cwd: '/w' },
  FILES: { sessionId: 'FILES', agent: 'claude', liveSessionId: 'FILES', tmux: 'aw_files', cwd: '/w' },
};
const PIDS = { aw_events: 71001, aw_peer: 71002, aw_files: 71003 };
const byTmux = Object.fromEntries(Object.values(entries).map((e) => [e.tmux, e]));

function manager() {
  return {
    activeEntries: () => [],
    archivedEntries: () => [],
    entryFor: (id) => entries[id],
    entryByTmux: (t) => byTmux[t] || null,
    tmuxOwner: (t) => byTmux[t]?.sessionId || null,
    tmuxNameFor: (id) => entries[id]?.tmux || null,
    deadTmuxNameFor: () => null,
    isArchived: () => false,
    scanSockets: () => [''],
    socketOf: () => '',
    alive: new Set(Object.keys(byTmux)),
  };
}

const discover = async () => Object.entries(PIDS).map(([tmuxName, claudePid]) => ({ tmuxName, claudePid, agent: 'claude', cwd: '/w', command: 'claude', paneTitle: '' }));

function writeStatusFile(pid, data) {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  fs.writeFileSync(path.join(SESSIONS_DIR, `${pid}.json`), JSON.stringify({ pid: process.pid, ...data }));
}

async function setup(t) {
  registerRuntime({ id: RT, label: 'Events test', statusEvents: true, wrapLaunch: async ({ inner }) => inner }, EXT);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-status-acceptance-'));
  const store = createStatusEventStore({ file: path.join(dataDir, 'session-status.json') });
  const changed = [];
  const handler = createStatusEventHandler({
    store,
    accepts: (id) => {
      const entry = entries[id];
      return !entry || takesStatusEvents(findRuntime(entry.runtime), entry.agent ?? 'claude');
    },
    onEvent: (id) => changed.push(id),
  });
  const ok = (q, s) => s.end();
  const api = createSessionApi({ dataDir, cardState: (id) => (entries[id] ? 'running' : 'unknown'), handlers: { '/mcp': ok, '/pr-attach': ok, '/pr-model': ok, '/status-event': handler } });
  const port = await api.start({ port: 0 });
  const tokens = Object.fromEntries(Object.keys(entries).map((id) => [id, api.tokens.issue(id)]));
  // The status files say the opposite of every event below, so a card that read
  // one would show it.
  writeStatusFile(PIDS.aw_events, { sessionId: 'live-events', status: 'waiting', waitingFor: 'from the status file' });
  writeStatusFile(PIDS.aw_peer, { sessionId: 'live-peer', status: 'waiting', waitingFor: 'from the status file' });
  writeStatusFile(PIDS.aw_files, { sessionId: 'FILES', status: 'busy' });
  const reads = [];
  const realRead = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', function (file, ...rest) {
    if (typeof file === 'string' && file.startsWith(SESSIONS_DIR)) reads.push(path.basename(file));
    return realRead.call(this, file, ...rest);
  });
  t.after(() => { api.server.close(); unregisterRuntimesFor(EXT); });
  const url = `http://127.0.0.1:${port}/status-event`;
  const card = async (id) => {
    const graph = await buildGraph(manager(), async () => ({}), { discover, capture: async () => '', statusEvents: store });
    const s = graph.sessions.find((x) => x.sessionId === id);
    return { status: s.status, waitingFor: s.waitingFor, waitingReason: s.waitingReason ?? null };
  };
  return { store, url, tokens, reads, card, changed, port };
}

// Runs the hook script exactly as a launch's hook would: the state as its
// argument, the agent's hook payload on stdin, the session's env.
function runHook(state, payload, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [STATUS_HOOK_PATH, state], { env: { PATH: process.env.PATH, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code, out }));
    child.stdin.end(JSON.stringify(payload));
  });
}

const post = (url, { headers = {}, body, raw } = {}) => fetch(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers },
  body: raw ?? JSON.stringify(body),
}).then(async (r) => ({ status: r.status, body: r.status === 204 ? null : await r.json().catch(() => null) }));

test('acceptance: an opted-in card goes working -> waiting for permission -> idle from posted events, with no status-file reads', async (t) => {
  const { url, tokens, reads, card, changed } = await setup(t);
  const env = { AW_STATUS_EVENT_URL: url, AW_SESSION_TOKEN: tokens.EVENTS };
  const steps = [
    ['working', { hook_event_name: 'UserPromptSubmit', session_id: 'live-events', prompt: 'run the tests' }],
    ['waiting-permission', { hook_event_name: 'PermissionRequest', session_id: 'live-events', tool_name: 'Bash', tool_input: { command: 'npm test' } }],
    ['idle', { hook_event_name: 'Stop', session_id: 'live-events' }],
  ];
  const seen = [];
  for (const [state, payload] of steps) {
    const hook = await runHook(state, payload, env);
    assert.deepEqual(hook, { code: 0, out: '' }, 'the hook exits 0 and prints nothing');
    const c = await card('EVENTS');
    console.log(`hook ${payload.hook_event_name} -> ${state}: EVENTS card ${JSON.stringify(c)}`);
    seen.push(c);
  }
  assert.deepEqual(seen, [
    { status: 'working', waitingFor: null, waitingReason: null },
    { status: 'needs-you', waitingFor: 'Permission to use Bash', waitingReason: 'permission' },
    { status: 'idle', waitingFor: null, waitingReason: null },
  ]);
  assert.deepEqual(changed, ['EVENTS', 'EVENTS', 'EVENTS'], 'each accepted event asks for a rebuild');
  const eventFile = `${PIDS.aw_events}.json`;
  console.log(`status files read during the run: ${JSON.stringify([...new Set(reads)].sort())} (EVENTS' is ${eventFile})`);
  assert.ok(!reads.includes(eventFile), 'the opted-in card\'s status file is never read');
  assert.ok(!reads.includes(`${PIDS.aw_peer}.json`));
});

test('acceptance: another card\'s token, no token, a malformed or oversized body is refused and no card changes', async (t) => {
  const { url, tokens, card, store, changed } = await setup(t);
  await post(url, { headers: { Authorization: `Bearer ${tokens.EVENTS}` }, body: { state: 'working', at: 1 } });
  await post(url, { headers: { Authorization: `Bearer ${tokens.PEER}` }, body: { state: 'idle', at: 1 } });
  changed.length = 0;
  const before = { EVENTS: await card('EVENTS'), PEER: await card('PEER'), FILES: await card('FILES') };
  const auth = { Authorization: `Bearer ${tokens.PEER}` };
  const cases = [
    ['PEER\'s token claiming EVENTS', { headers: { ...auth, 'X-AW-Session': 'EVENTS' }, body: { state: 'waiting-permission' } }, 403, 'claim-mismatch'],
    ['a card id as the bearer', { headers: { Authorization: 'Bearer EVENTS' }, body: { state: 'idle' } }, 403, 'unknown-token'],
    ['a forged token', { headers: { Authorization: 'Bearer awt_forged' }, body: { state: 'idle' } }, 403, 'unknown-token'],
    ['no token', { body: { state: 'idle' } }, 403, 'missing-token'],
    ['a bare card id claim, no token', { headers: { 'X-AW-Session': 'EVENTS' }, body: { state: 'idle' } }, 403, 'missing-token'],
    ['not JSON', { headers: auth, raw: '{state:' }, 400, 'bad-body'],
    ['an unknown state', { headers: auth, body: { state: 'busy' } }, 400, 'bad-body'],
    ['a card field in the body', { headers: auth, body: { state: 'waiting-permission', card: 'EVENTS' } }, 400, 'bad-body'],
    ['an array', { headers: auth, body: [{ state: 'idle' }] }, 400, 'bad-body'],
    [`a body over ${STATUS_EVENT_MAX_BYTES} bytes`, { headers: auth, body: { state: 'idle', detail: 'x'.repeat(STATUS_EVENT_MAX_BYTES) } }, 413, 'too-large'],
    ['not application/json', { headers: { ...auth, 'Content-Type': 'text/plain' }, body: { state: 'idle' } }, 415, 'bad-content-type'],
    ['a file-status card\'s own token', { headers: { Authorization: `Bearer ${tokens.FILES}` }, body: { state: 'waiting-permission' } }, 409, 'not-opted-in'],
  ];
  for (const [label, req, code, error] of cases) {
    const res = await post(url, req);
    console.log(`${label}: ${res.status} ${res.body?.error}`);
    assert.equal(res.status, code, label);
    assert.equal(res.body?.error, error, label);
  }
  const after = { EVENTS: await card('EVENTS'), PEER: await card('PEER'), FILES: await card('FILES') };
  console.log(`cards before: ${JSON.stringify(before)}`);
  console.log(`cards after:  ${JSON.stringify(after)}`);
  assert.deepEqual(after, before);
  assert.deepEqual(changed, [], 'no rebuild was asked for');
  assert.equal(store.get('FILES'), null);
  const own = await post(url, { headers: auth, body: { state: 'waiting-input' } });
  assert.equal(own.status, 204, 'the same token still reports for its own card');
  assert.equal((await card('PEER')).status, 'needs-you');
  assert.equal((await card('EVENTS')).status, 'working');
});

test('acceptance: a session on a runtime without the opt-in keeps file-based status', async (t) => {
  const { reads, card } = await setup(t);
  const first = await card('FILES');
  console.log(`FILES status file busy -> card ${JSON.stringify(first)}`);
  writeStatusFile(PIDS.aw_files, { sessionId: 'FILES', status: 'waiting', waitingFor: 'approve the plan?' });
  const second = await card('FILES');
  console.log(`FILES status file waiting -> card ${JSON.stringify(second)}`);
  writeStatusFile(PIDS.aw_files, { sessionId: 'FILES', status: 'idle' });
  const third = await card('FILES');
  console.log(`FILES status file idle -> card ${JSON.stringify(third)}`);
  assert.equal(first.status, 'working');
  assert.deepEqual([second.status, second.waitingFor], ['needs-you', 'approve the plan?']);
  assert.equal(third.status, 'idle');
  assert.ok(reads.includes(`${PIDS.aw_files}.json`), 'its status file is read');
  assert.ok(!reads.includes(`${PIDS.aw_events}.json`));
});
