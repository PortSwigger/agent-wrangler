import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createClientStore, CLIENT_DEFAULT_DAYS, isClientToken } from './clients.js';
import { createClientAdmin } from './client-admin.js';
import { clientViewFor } from './client-view.js';
import { createTokenStore, hashToken } from './tokens.js';
import { createLaptopCheck, REFUSALS, isLoopbackAddress } from './check.js';
import { createSessionApi } from './index.js';
import { guarded } from './server.js';
import { createMcpRequestHandler, clientTools } from '../mcp/server.js';
import { getExtensions, loadExtensions, createToolFilter, _resetExtensionsForTests } from '../extensions/index.js';
import { NATIVE_ACTIONS } from '../deck/native-actions.js';

const DAY = 24 * 60 * 60 * 1000;
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aw-clients-'));
const req = (headers, remoteAddress = '127.0.0.1') => ({
  headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])),
  socket: { remoteAddress },
});
const bearer = (token) => ({ Authorization: `Bearer ${token}` });

function store({ at = 1_000_000 } = {}) {
  const clock = { at };
  const file = path.join(tmpDir(), 'outside-clients.json');
  const clients = createClientStore({ file, now: () => clock.at });
  return { clients, clock, file };
}

test('store: a minted token is awc_ + 32 random bytes, kept only as its SHA-256 in a 0600 file', () => {
  const { clients, file } = store();
  const { client, token } = clients.mint({ name: 'jobs-bot', scopes: ['fake:jobs'] });
  assert.match(token, /^awc_[A-Za-z0-9_-]{43}$/);
  assert.ok(isClientToken(token));
  assert.equal(client.name, 'jobs-bot');
  assert.deepEqual(client.scopes, ['fake:jobs']);
  assert.equal(client.expiresAt - client.createdAt, CLIENT_DEFAULT_DAYS * DAY, '30 days by default');
  const raw = fs.readFileSync(file, 'utf8');
  assert.ok(!raw.includes(token), 'the file never holds the token');
  assert.ok(raw.includes(hashToken(token)));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(clients.list()[0].hash, undefined, 'a listing never carries the hash');
  const reloaded = createClientStore({ file, now: () => 1_000_000 });
  assert.equal(reloaded.resolve(token).client.id, client.id, 'a restart keeps the client');
});

test('store: an unknown, revoked or expired token resolves to no client', () => {
  const { clients, clock } = store();
  const a = clients.mint({ name: 'a', scopes: ['fake:jobs'], days: 1 });
  const b = clients.mint({ name: 'b', scopes: ['fake:jobs'] });
  assert.deepEqual(clients.resolve(a.token).client, { id: a.client.id, name: 'a', scopes: ['fake:jobs'] });
  assert.equal(clients.resolve('awc_nope').reason, 'unknown');
  assert.equal(clients.resolve('awt_session').reason, 'unknown', 'a session token is never looked up here');
  assert.equal(clients.revoke(b.client.id).name, 'b');
  assert.equal(clients.resolve(b.token).reason, 'unknown', 'revoked');
  assert.equal(clients.revoke(b.client.id), null);
  clock.at += DAY;
  assert.deepEqual(clients.resolve(a.token), { reason: 'expired', name: 'a' });
  assert.equal(clients.list()[0].expired, true);
});

test('store: names, scopes and expiry are checked; an exclusive scope has one live holder', () => {
  const { clients, clock } = store();
  assert.throws(() => clients.mint({ name: ' ', scopes: ['x:y'] }), /Give the client a name/);
  assert.throws(() => clients.mint({ name: 'x'.repeat(41), scopes: ['x:y'] }), /at most 40/);
  assert.throws(() => clients.mint({ name: 'a"b', scopes: ['x:y'] }), /quotes/);
  assert.throws(() => clients.mint({ name: 'a', scopes: [] }), /at least one scope/);
  assert.throws(() => clients.mint({ name: 'a', scopes: ['x:y'], known: () => false }), /Unknown scope "x:y"/);
  assert.throws(() => clients.mint({ name: 'a', scopes: ['x:y'], days: 0 }), /from 1 to 365/);
  assert.throws(() => clients.mint({ name: 'a', scopes: ['x:y'], days: 366 }), /from 1 to 365/);
  assert.throws(() => clients.mint({ name: 'a', scopes: ['x:y'], days: 1.5 }), /whole number/);
  const exclusive = new Set(['fake:human']);
  clients.mint({ name: 'Bot', scopes: ['fake:human'], exclusive, days: 1 });
  assert.throws(() => clients.mint({ name: 'bot', scopes: ['fake:jobs'] }), /named "bot" already exists/);
  assert.throws(() => clients.mint({ name: 'other', scopes: ['fake:human'], exclusive }), /Only one client may hold fake:human, and "Bot" does/);
  clock.at += DAY;
  assert.ok(clients.mint({ name: 'other', scopes: ['fake:human'], exclusive }).token, 'an expired holder frees the scope');
});

test('store: a use is noted in memory and written at most every 30 seconds, the last one when the window closes', () => {
  const clock = { at: 1_000_000 };
  const timers = [];
  const file = path.join(tmpDir(), 'outside-clients.json');
  const clients = createClientStore({ file, now: () => clock.at, setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; } });
  const onDisk = () => JSON.parse(fs.readFileSync(file, 'utf8')).clients[0];
  const { client } = clients.mint({ name: 'a', scopes: ['fake:jobs'] });
  clock.at += 1000;
  clients.noteUse(client.id, 'fake_list');
  clients.noteUse(client.id, 'fake_list');
  assert.equal(clients.get(client.id).lastUsedAt, clock.at);
  assert.equal(clients.get(client.id).lastTool, 'fake_list');
  assert.equal(onDisk().lastUsedAt, null, 'not written yet');
  assert.deepEqual(timers.map((t) => t.ms), [29_000], 'one trailing write, when the window closes');
  clock.at += 29_000;
  timers[0].fn();
  assert.equal(onDisk().lastUsedAt, 1_001_000);
  assert.equal(onDisk().lastTool, 'fake_list');
  clock.at += 30_000;
  clients.noteUse(client.id);
  assert.equal(onDisk().lastUsedAt, clock.at, 'a use after a quiet window is written at once');
  assert.equal(timers.length, 1);
});

test('loopback addresses: 127/8 and ::1, plain or IPv4-mapped, and nothing else', () => {
  for (const a of ['127.0.0.1', '127.1.2.3', '::1', '::ffff:127.0.0.1']) assert.ok(isLoopbackAddress(a), a);
  for (const a of ['0.0.0.0', '::', '10.0.0.1', '192.168.1.2', '::ffff:10.0.0.1', '', null, undefined, '127.0.0.1.evil']) assert.ok(!isLoopbackAddress(a), String(a));
});

function check({ bound = '127.0.0.1' } = {}) {
  const tokens = createTokenStore({ file: path.join(tmpDir(), 'session-tokens.json') });
  const { clients, clock } = store();
  const resolve = createLaptopCheck({ tokens, clients, boundAddress: () => bound, cardState: () => 'running' });
  return { tokens, clients, clock, resolve };
}

test('check: a live client token resolves to { client }, never a card', () => {
  const { clients, resolve } = check();
  const { client, token } = clients.mint({ name: 'bot', scopes: ['fake:jobs'] });
  const who = resolve(req(bearer(token)));
  assert.deepEqual(who, { client: { id: client.id, name: 'bot', scopes: ['fake:jobs'] } });
  assert.equal(who.cardId, undefined);
  assert.deepEqual(resolve(req(bearer(token), '::1')).client.id, client.id);
  assert.deepEqual(resolve(req(bearer(token), '::ffff:127.0.0.1')).client.id, client.id);
});

test('check: an unknown, revoked or expired client token is refused', () => {
  const { clients, clock, resolve } = check();
  const a = clients.mint({ name: 'a', scopes: ['fake:jobs'], days: 1 });
  const b = clients.mint({ name: 'b', scopes: ['fake:jobs'] });
  assert.equal(resolve(req(bearer('awc_unknown'))).refuse, REFUSALS.unknown);
  clients.revoke(b.client.id);
  assert.equal(resolve(req(bearer(b.token))).refuse, REFUSALS.unknown);
  clock.at += DAY;
  const expired = resolve(req(bearer(a.token)));
  assert.equal(expired.refuse, REFUSALS.unknown);
  assert.match(expired.reason, /"a" has expired/);
});

test('check: a client token is refused from a non-loopback peer, on a non-loopback bind, with a card claim and on the legacy routes', () => {
  const { clients, resolve } = check();
  const { token } = clients.mint({ name: 'bot', scopes: ['fake:jobs'] });
  assert.equal(resolve(req(bearer(token), '192.168.1.20')).refuse, REFUSALS.notLoopback);
  assert.equal(resolve(req(bearer(token), null)).refuse, REFUSALS.notLoopback);
  assert.equal(resolve(req({ ...bearer(token), 'X-AW-Session': 'LIVE' })).refuse, REFUSALS.mismatch);
  assert.equal(resolve(req(bearer(token)), { legacy: true }).refuse, REFUSALS.unknown);
  for (const bound of ['0.0.0.0', '::', '192.168.1.2', null]) {
    const c = check({ bound });
    const t = c.clients.mint({ name: 'bot', scopes: ['fake:jobs'] }).token;
    assert.equal(c.resolve(req(bearer(t))).refuse, REFUSALS.notLoopback, `bound to ${bound}`);
  }
  const noStore = createLaptopCheck({ tokens: createTokenStore({ file: path.join(tmpDir(), 't.json') }), cardState: () => 'running' });
  assert.equal(noStore(req(bearer(token))).refuse, REFUSALS.unknown, 'no store, no client');
});

test('check: session tokens are unaffected', () => {
  const { tokens, resolve } = check();
  assert.deepEqual(resolve(req(bearer(tokens.issue('LIVE')), '10.0.0.1')), { cardId: 'LIVE' });
});

test('guarded: an outside client reaches only a route that takes clients, never a legacy one', async () => {
  const calls = [];
  const handler = (...a) => calls.push(a.slice(2));
  const who = () => ({ client: { id: 'c_1', name: 'bot', scopes: [] } });
  const res = () => ({ code: null, body: '', writeHead(c) { this.code = c; return this; }, end(b) { this.body = b; } });
  const r1 = res();
  await guarded(who, handler, { clients: true })({ resume() {} }, r1);
  assert.deepEqual(calls, [[null, { id: 'c_1', name: 'bot', scopes: [] }]]);
  const r2 = res();
  await guarded(who, handler)({ resume() {} }, r2);
  assert.equal(r2.code, 403);
  assert.equal(JSON.parse(r2.body).error, REFUSALS.notSession);
  const r3 = res();
  await guarded(who, handler, { clients: true, legacy: true })({ resume() {} }, r3);
  assert.equal(r3.code, 403);
  assert.equal(calls.length, 1);
});

test('clientTools: only an extension tool its own extension lists under a held scope', () => {
  const tools = [
    { name: 'list_sessions' },
    { name: 'send_message' },
    { name: 'fake_list', extId: 'fake' },
    { name: 'fake_press', extId: 'fake' },
    { name: 'other_tool', extId: 'other' },
  ];
  const scopes = [
    { key: 'fake:jobs', extId: 'fake', tools: ['fake_list'] },
    { key: 'fake:human', extId: 'fake', tools: ['fake_list', 'fake_press'] },
    // A scope can only name its own extension's tools; a forged entry naming a
    // core tool still never reaches one, since core tools carry no extId.
    { key: 'other:x', extId: 'other', tools: ['list_sessions', 'fake_press'] },
  ];
  const names = (scopesHeld) => clientTools(tools, { scopes: scopesHeld }, scopes).map((t) => t.name);
  assert.deepEqual(names(['fake:jobs']), ['fake_list']);
  assert.deepEqual(names(['fake:human']), ['fake_list', 'fake_press']);
  assert.deepEqual(names(['other:x']), []);
  assert.deepEqual(names([]), []);
  assert.deepEqual(names(['fake:gone']), []);
});

test('clientViewFor: an extension sees the client\'s id, name and only its own scopes', () => {
  const client = { id: 'c_1', name: 'bot', scopes: ['fake:jobs', 'fake:human', 'other:x'] };
  assert.deepEqual(clientViewFor(client, 'fake'), { id: 'c_1', name: 'bot', scopes: ['jobs', 'human'] });
  assert.deepEqual(clientViewFor(client, 'other'), { id: 'c_1', name: 'bot', scopes: ['x'] });
  assert.equal(clientViewFor(null, 'fake'), null);
});

function scoped(overrides = {}) {
  const seen = [];
  return {
    seen,
    manifest: {
      id: 'fake',
      label: 'Fake',
      defaultEnabled: true,
      tools: [
        { name: 'fake_list', description: 'List', inputSchema: {}, handler: (frame) => { seen.push(['fake_list', frame]); return { content: [{ type: 'text', text: 'listed' }] }; } },
        { name: 'fake_press', description: 'Press', inputSchema: {}, handler: (frame) => { seen.push(['fake_press', frame]); return { content: [{ type: 'text', text: 'pressed' }] }; } },
        { name: 'fake_boom', description: 'Throws', inputSchema: {}, handler: () => { throw new Error('boom'); } },
      ],
      clientScopes: [
        { id: 'jobs', label: 'Jobs', description: 'Job tools', tools: ['fake_list', 'fake_boom'] },
        { id: 'human', label: 'Human', tools: ['fake_list', 'fake_press'], exclusive: true },
      ],
      ...overrides,
    },
  };
}

test('manifest: clientScopes are validated and may name only the extension\'s own tools', () => {
  const quarantine = (clientScopes) => loadExtensions({ cfg: {}, builtin: [scoped({ clientScopes }).manifest] }).list.at(-1).quarantine;
  assert.match(quarantine('x'), /clientScopes must be an array/);
  assert.match(quarantine([{ id: 'Bad', label: 'x', tools: ['fake_list'] }]), /clientScopes\[0\]\.id must match/);
  assert.match(quarantine([{ id: 'a', label: '', tools: ['fake_list'] }]), /label must be a non-empty string/);
  assert.match(quarantine([{ id: 'a', label: 'A', tools: [] }]), /must name at least one tool/);
  assert.match(quarantine([{ id: 'a', label: 'A', tools: ['list_sessions'] }]), /names "list_sessions", which is not one of this extension's tools/);
  assert.match(quarantine([{ id: 'a', label: 'A', tools: ['fake_list'] }, { id: 'a', label: 'B', tools: ['fake_list'] }]), /two scopes with id "a"/);
  assert.match(quarantine([{ id: 'a', label: 'A', tools: ['fake_list'], exclusive: 'yes' }]), /exclusive must be a boolean/);
  const loaded = loadExtensions({ cfg: {}, builtin: [scoped().manifest] });
  assert.deepEqual(loaded.clientScopes.map((s) => [s.key, s.tools, s.exclusive]), [
    ['fake:jobs', ['fake_list', 'fake_boom'], false],
    ['fake:human', ['fake_list', 'fake_press'], true],
  ]);
  assert.deepEqual(loadExtensions({ cfg: { extensions: { fake: false } }, builtin: [scoped().manifest] }).clientScopes, [], 'a disabled extension offers no scopes');
});

test('hideTool sees an outside client as its own extension\'s view of it', () => {
  const asked = [];
  const loaded = loadExtensions({ cfg: {}, builtin: [scoped({ hideTool: ({ caller, tool, client }) => { asked.push({ caller, tool, client }); return client?.scopes.includes('jobs') && tool === 'fake_boom'; } }).manifest] });
  const hide = createToolFilter(loaded, () => ({}));
  const client = { id: 'c_1', name: 'bot', scopes: ['fake:jobs', 'other:x'] };
  assert.equal(hide(null, 'fake_boom', client), true);
  assert.equal(hide('CARD1', 'fake_boom'), false);
  assert.deepEqual(asked[0].client, { id: 'c_1', name: 'bot', scopes: ['jobs'] });
  assert.equal(asked[1].client, null, 'a session is no client');
});

// End to end: the real session API listener, check, MCP handler and admin.
async function withClientApi(fn, { seed } = {}) {
  const { manifest, seen } = scoped();
  _resetExtensionsForTests();
  const ext = getExtensions({ cfg: {}, builtin: [manifest] });
  const logs = [];
  const dataDir = tmpDir();
  seed?.(dataDir);
  let admin = null;
  const deps = {
    graph: () => ({ sessions: [{ sessionId: 'LIVE', label: 'LIVE', agent: 'claude', status: 'idle', cwd: '/a' }] }),
    taskStore: { taskFor: () => null },
    hostApiFor: () => ({ id: 'fake' }),
    ext: { hideTool: createToolFilter(ext, () => ({})), clientScopes: () => ext.clientScopes },
    outsideClients: { seen: (c) => admin.seen(c), called: (...a) => admin.called(...a) },
  };
  const api = createSessionApi({ dataDir, cardState: () => 'running', handlers: { '/mcp': createMcpRequestHandler(deps), '/pr-attach': (q, s, c) => s.end(String(c)) } });
  admin = createClientAdmin({ clients: api.clients, scopes: () => ext.clientScopes, extLabel: () => 'Fake', endpoint: () => api.endpoint(), log: (m) => logs.push(m) });
  const port = await api.start({ port: 0 });
  try {
    return await fn({ api, admin, port, logs, seen });
  } finally {
    api.server.close();
    _resetExtensionsForTests();
  }
}

async function rpc(port, method, params, headers = {}) {
  const r = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const text = await r.text();
  return { status: r.status, body: text.startsWith('{') ? JSON.parse(text) : text };
}

test('session API: a client token lists only its scopes\' extension tools, no session tools', async () => {
  await withClientApi(async ({ api, admin, port }) => {
    const { token } = admin.mint({ name: 'jobs-bot', scopes: ['fake:jobs'], days: 30 });
    const listed = await rpc(port, 'tools/list', {}, bearer(token));
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.body.result.tools.map((t) => t.name).sort(), ['fake_boom', 'fake_list']);
    const human = admin.mint({ name: 'desk', scopes: ['fake:human'] }).token;
    assert.deepEqual((await rpc(port, 'tools/list', {}, bearer(human))).body.result.tools.map((t) => t.name).sort(), ['fake_list', 'fake_press']);
    const session = await rpc(port, 'tools/list', {}, bearer(api.tokens.issue('LIVE')));
    assert.ok(session.body.result.tools.some((t) => t.name === 'list_sessions'), 'a session still sees core tools');
    const core = await rpc(port, 'tools/call', { name: 'list_sessions', arguments: {} }, bearer(token));
    assert.equal(core.body.result?.isError ?? Boolean(core.body.error), true, 'a core tool cannot be called');
    const press = await rpc(port, 'tools/call', { name: 'fake_press', arguments: {} }, bearer(token));
    assert.equal(press.body.result?.isError ?? Boolean(press.body.error), true, 'a tool outside its scopes cannot be called');
  });
});

test('session API: a client\'s call to a tool it was not offered is logged as refused', async () => {
  await withClientApi(async ({ admin, port, logs }) => {
    const { minted, token } = admin.mint({ name: 'jobs-bot', scopes: ['fake:jobs'] });
    await rpc(port, 'tools/call', { name: 'send_message', arguments: {} }, bearer(token));
    await rpc(port, 'tools/call', { name: 'fake_press\n[forged]', arguments: {} }, bearer(token));
    assert.ok(logs.includes(`[outside-clients] "jobs-bot" (${minted.id}) called "send_message": refused, not in its scopes`), logs.join('\n'));
    assert.ok(logs.some((m) => m.includes('"fake_press\\n[forged]"')), 'a client-chosen name is quoted');
    const row = admin.state().clients[0];
    assert.ok(row.lastUsedAt);
    assert.equal(row.lastTool, null, 'a refused call is not its last tool');
  });
});

test('session API: a client\'s call runs with caller null and its view, is logged and noted as its last use', async () => {
  await withClientApi(async ({ admin, port, logs, seen }) => {
    const { minted: client, token } = admin.mint({ name: 'jobs-bot', scopes: ['fake:jobs'] });
    const r = await rpc(port, 'tools/call', { name: 'fake_list', arguments: {} }, bearer(token));
    assert.equal(r.body.result.content[0].text, 'listed');
    assert.equal(seen[0][1].caller, null);
    assert.deepEqual(seen[0][1].client, { id: client.id, name: 'jobs-bot', scopes: ['jobs'] });
    const boom = await rpc(port, 'tools/call', { name: 'fake_boom', arguments: {} }, bearer(token));
    assert.equal(boom.body.result.isError, true);
    assert.match(logs.find((m) => m.includes('called fake_list')), new RegExp(`"jobs-bot" \\(${client.id}\\) called fake_list: ok in \\d+ms`));
    assert.ok(logs.some((m) => /called fake_boom: (error|threw)/.test(m)), logs.join('\n'));
    const row = admin.state().clients[0];
    assert.equal(row.lastTool, 'fake_boom');
    assert.ok(row.lastUsedAt);
  });
});

test('session API: a revoked, expired or unknown client token gets 403', async () => {
  // An expired client as a restart would find it: its record is past expiry.
  const expiredToken = 'awc_' + 'e'.repeat(43);
  const seed = (dataDir) => fs.writeFileSync(path.join(dataDir, 'outside-clients.json'), JSON.stringify({
    clients: [{ id: 'c_old', name: 'old', hash: hashToken(expiredToken), scopes: ['fake:jobs'], createdAt: Date.now() - 31 * DAY, expiresAt: Date.now() - DAY }],
  }), { mode: 0o600 });
  await withClientApi(async ({ admin, port }) => {
    const revoked = admin.mint({ name: 'revoked', scopes: ['fake:jobs'] });
    assert.equal((await rpc(port, 'tools/list', {}, bearer(revoked.token))).status, 200);
    admin.revoke(revoked.minted.id);
    assert.deepEqual(await rpc(port, 'tools/list', {}, bearer(revoked.token)), { status: 403, body: { error: 'unknown-token', reason: 'unknown client token' } });
    assert.deepEqual(await rpc(port, 'tools/list', {}, bearer('awc_never-minted')), { status: 403, body: { error: 'unknown-token', reason: 'unknown client token' } });
    assert.deepEqual(await rpc(port, 'tools/list', {}, bearer(expiredToken)), { status: 403, body: { error: 'unknown-token', reason: 'the outside client "old" has expired' } });
    assert.equal(admin.state().clients.find((c) => c.id === 'c_old').expired, true, 'Settings shows it expired');
  }, { seed });
});

test('session API: a client token is refused on a route that acts as a session, and from a browser', async () => {
  await withClientApi(async ({ admin, port }) => {
    const { token } = admin.mint({ name: 'bot', scopes: ['fake:jobs'] });
    const attach = await fetch(`http://127.0.0.1:${port}/pr-attach`, { method: 'POST', headers: bearer(token) });
    assert.equal(attach.status, 403);
    assert.equal((await attach.json()).error, 'not-a-session');
    assert.equal((await rpc(port, 'tools/list', {}, { ...bearer(token), Origin: 'http://127.0.0.1:7878' })).status, 403);
  });
});

test('session API: endpoint() says where a client calls and that loopback accepts it', async () => {
  await withClientApi(async ({ api, port }) => {
    assert.deepEqual(api.endpoint(), { url: `http://127.0.0.1:${port}/mcp`, host: '127.0.0.1', loopback: true });
  });
});

test('admin: mint checks scopes against what enabled extensions declare and the exclusive rule', async () => {
  await withClientApi(async ({ admin, logs }) => {
    assert.throws(() => admin.mint({ name: 'a', scopes: ['fake:nope'] }), /Unknown scope "fake:nope"/);
    assert.throws(() => admin.mint({ name: 'a', scopes: ['jobs'] }), /Unknown scope "jobs"/);
    const first = admin.mint({ name: 'desk', scopes: ['fake:human'] });
    assert.ok(first.token);
    assert.equal(first.minted.name, 'desk');
    assert.equal(first.clients.length, 1);
    assert.equal(first.scopes.find((s) => s.key === 'fake:human').exclusive, true);
    assert.throws(() => admin.mint({ name: 'desk-2', scopes: ['fake:human'] }), /Only one client may hold fake:human/);
    assert.throws(() => admin.revoke('c_missing'), /No such client/);
    assert.deepEqual(admin.revoke(first.minted.id).clients, []);
    assert.ok(logs.some((m) => m.startsWith('[outside-clients] minted "desk"')));
    assert.ok(logs.some((m) => m.startsWith('[outside-clients] revoked "desk"')));
    assert.equal(JSON.stringify(admin.state()).includes(first.token), false, 'the state never carries a token');
  });
});

test('deck actions: Settings mints, lists and revokes through admin.outside-client*', async () => {
  const run = (name, args, ctx) => NATIVE_ACTIONS.find((a) => a.action === name).run(args, ctx);
  await assert.rejects(run('admin.outside-clients', {}, {}), (e) => e.code === 'unsupported');
  await withClientApi(async ({ admin }) => {
    const ctx = { outsideClients: admin };
    const minted = await run('admin.outside-client-mint', { name: 'bot', scopes: ['fake:jobs'], days: 7 }, ctx);
    assert.match(minted.token, /^awc_/);
    assert.equal((await run('admin.outside-clients', {}, ctx)).clients[0].name, 'bot');
    await assert.rejects(run('admin.outside-client-mint', { name: '', scopes: ['fake:jobs'] }, ctx), (e) => e.code === 'invalid');
    assert.deepEqual((await run('admin.outside-client-revoke', { id: minted.minted.id }, ctx)).clients, []);
    await assert.rejects(run('admin.outside-client-revoke', { id: minted.minted.id }, ctx), (e) => e.code === 'not-found');
  });
});

test('session API bound beyond loopback refuses every client token, keeping session tokens working', async (t) => {
  const { manifest } = scoped();
  _resetExtensionsForTests();
  const ext = getExtensions({ cfg: {}, builtin: [manifest] });
  t.after(() => _resetExtensionsForTests());
  const deps = { graph: () => ({ sessions: [] }), taskStore: { taskFor: () => null }, hostApiFor: () => ({}), ext: { clientScopes: () => ext.clientScopes } };
  const api = createSessionApi({ dataDir: tmpDir(), cardState: () => 'running', handlers: { '/mcp': createMcpRequestHandler(deps) } });
  const port = await api.start({ port: 0, host: '0.0.0.0' });
  t.after(() => api.server.close());
  const { token } = api.clients.mint({ name: 'bot', scopes: ['fake:jobs'] });
  const refused = await rpc(port, 'tools/list', {}, bearer(token));
  assert.equal(refused.status, 403);
  assert.equal(refused.body.error, 'not-loopback');
  assert.equal(api.endpoint().loopback, false);
  assert.equal((await rpc(port, 'tools/list', {}, bearer(api.tokens.issue('LIVE')))).status, 200);
});

test('a client token on the deck\'s legacy /mcp route is refused', async () => {
  await withClientApi(async ({ api, admin }) => {
    const { token } = admin.mint({ name: 'bot', scopes: ['fake:jobs'] });
    const legacy = http.createServer((q, s) => api.legacyHandlers[q.url](q, s));
    await new Promise((r) => legacy.listen(0, '127.0.0.1', r));
    try {
      const r = await fetch(`http://127.0.0.1:${legacy.address().port}/mcp`, { method: 'POST', headers: { ...bearer(token), 'Content-Type': 'application/json' }, body: '{}' });
      assert.equal(r.status, 403);
    } finally {
      legacy.close();
    }
  });
});
