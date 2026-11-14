import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createTokenStore, hashToken } from './tokens.js';
import { createLaptopCheck, REFUSALS, carriesSessionCredential } from './check.js';
import { resetLegacyWarnings } from '../deck/legacy.js';
import { createSessionApi } from './index.js';
import { createMcpRequestHandler } from '../mcp/server.js';
import { SessionManager } from '../session-manager.js';

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aw-session-api-')), 'session-tokens.json');
const req = (headers) => ({ headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])) });

function fixture(states = { LIVE: 'running', OTHER: 'running', GONE: 'archived', OLD: 'running', OLDGONE: 'archived', OLDSTOPPED: 'stopped' }) {
  const tokens = createTokenStore({ file: tmpFile() });
  const warnings = [];
  const resolve = createLaptopCheck({ tokens, cardState: (id) => states[id] || 'unknown', logWarn: (m) => warnings.push(m) });
  return { tokens, resolve, warnings };
}

test('tokens: one random token per card, re-issue replaces it, revoke drops it', () => {
  const { tokens } = fixture();
  const a = tokens.issue('LIVE');
  const b = tokens.issue('OTHER');
  assert.match(a, /^awt_[A-Za-z0-9_-]{43}$/);
  assert.notEqual(a, b);
  assert.equal(tokens.cardFor(a), 'LIVE');
  const a2 = tokens.issue('LIVE');
  assert.equal(tokens.cardFor(a), null, 'a relaunch retires the old token');
  assert.equal(tokens.cardFor(a2), 'LIVE');
  tokens.revoke('LIVE');
  assert.equal(tokens.cardFor(a2), null);
  assert.equal(tokens.hasToken('LIVE'), false);
  assert.equal(tokens.cardFor('LIVE'), null, 'a card id is never a token');
});

test('tokens: persisted as hashes in a 0600 file, so a restart keeps live sessions working', () => {
  const file = tmpFile();
  const token = createTokenStore({ file }).issue('LIVE');
  const raw = fs.readFileSync(file, 'utf8');
  assert.ok(!raw.includes(token), 'the file never holds the token itself');
  assert.ok(raw.includes(hashToken(token)));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(createTokenStore({ file }).cardFor(token), 'LIVE');
});

test('check: a request with no token is refused', () => {
  const { resolve } = fixture();
  assert.equal(resolve(req({})).refuse, REFUSALS.missing);
  assert.equal(resolve(req({ Authorization: 'Basic abc' })).refuse, REFUSALS.missing);
  assert.equal(resolve(req({ 'X-AW-Session': 'LIVE' })).refuse, REFUSALS.missing, 'a bare card id is no credential');
});

test('check: an unknown token is refused', () => {
  const { resolve, tokens } = fixture();
  tokens.issue('LIVE');
  assert.equal(resolve(req({ Authorization: 'Bearer awt_notarealtoken' })).refuse, REFUSALS.unknown);
  assert.equal(resolve(req({ Authorization: 'Bearer LIVE' })).refuse, REFUSALS.unknown, 'the card id as a bearer');
});

test('check: an archived card\'s token is refused', () => {
  const { resolve, tokens } = fixture();
  const token = tokens.issue('GONE');
  assert.equal(resolve(req({ Authorization: `Bearer ${token}` })).refuse, REFUSALS.archived);
});

test('check: a valid token resolves to its own card, even before the launch has recorded it', () => {
  const { resolve, tokens } = fixture();
  assert.deepEqual(resolve(req({ Authorization: `Bearer ${tokens.issue('LIVE')}` })), { cardId: 'LIVE' });
  assert.deepEqual(resolve(req({ Authorization: `Bearer ${tokens.issue('BRAND-NEW')}` })), { cardId: 'BRAND-NEW' });
});

test('check: a caller claiming another session is refused', () => {
  const { resolve, tokens } = fixture();
  const token = tokens.issue('LIVE');
  tokens.issue('OTHER');
  const r = resolve(req({ Authorization: `Bearer ${token}`, 'X-AW-Session': 'OTHER' }));
  assert.equal(r.refuse, REFUSALS.mismatch);
  assert.equal(r.cardId, undefined);
  assert.deepEqual(resolve(req({ Authorization: `Bearer ${token}`, 'X-AW-Session': 'LIVE' })), { cardId: 'LIVE' }, 'a matching claim is fine');
  assert.equal(resolve(req({ Authorization: `Bearer ${token}`, 'X-AW-Session': 'OTHER' }), { legacy: true }).refuse, REFUSALS.mismatch);
});

test('check legacy path: a live card launched before tokens is accepted by card id, logged once', () => {
  const { resolve, warnings } = fixture();
  assert.deepEqual(resolve(req({ 'X-AW-Session': 'OLD' }), { legacy: true }), { cardId: 'OLD', legacy: true });
  assert.deepEqual(resolve(req({ Authorization: 'Bearer OLD' }), { legacy: true }), { cardId: 'OLD', legacy: true }, 'an old Codex launch sent its card id as the bearer');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /OLD called without a session token/);
});

test('check legacy path: never for a card that has a token, an archived, stopped or unknown card, or a claim mismatch', () => {
  const { resolve, tokens } = fixture();
  tokens.issue('LIVE');
  assert.equal(resolve(req({ 'X-AW-Session': 'LIVE' }), { legacy: true }).refuse, REFUSALS.unknown, 'relaunched with a token');
  assert.equal(resolve(req({ 'X-AW-Session': 'OLDGONE' }), { legacy: true }).refuse, REFUSALS.archived);
  assert.equal(resolve(req({ 'X-AW-Session': 'NOPE' }), { legacy: true }).refuse, REFUSALS.unknown);
  assert.equal(resolve(req({ 'X-AW-Session': 'OLDSTOPPED' }), { legacy: true }).refuse, REFUSALS.unknown, 'a stopped card has no process to need it');
  assert.equal(resolve(req({ Authorization: 'Bearer OLD', 'X-AW-Session': 'OTHER' }), { legacy: true }).refuse, REFUSALS.mismatch);
  assert.equal(resolve(req({ Authorization: 'Bearer awt_forged' }), { legacy: true }).refuse, REFUSALS.unknown);
});

// End to end through the session API's own listener and the real MCP handler.
async function withApi(states, fn) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-session-api-'));
  const deps = { graph: () => ({ sessions: Object.keys(states).map((sessionId) => ({ sessionId, label: sessionId, agent: 'claude', status: 'idle', cwd: '/a' })) }), taskStore: { taskFor: () => null } };
  const warnings = [];
  resetLegacyWarnings();
  const api = createSessionApi({ dataDir, cardState: (id) => states[id] || 'unknown', logWarn: (m) => warnings.push(m), handlers: { '/mcp': createMcpRequestHandler(deps), '/pr-attach': (q, s, c) => s.end(c), '/pr-model': (q, s, c) => s.end(c) } });
  const port = await api.start({ port: 0 });
  const legacy = http.createServer((q, s) => api.legacyHandlers[q.url](q, s));
  await new Promise((r) => legacy.listen(0, '127.0.0.1', r));
  try { return await fn({ api, port, legacyPort: legacy.address().port, warnings }); } finally { api.server.close(); legacy.close(); }
}

async function listSessions(port, headers) {
  const r = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_sessions', arguments: {} } }),
  });
  const text = await r.text();
  return { status: r.status, body: text.startsWith('{') ? JSON.parse(text) : text };
}

test('session API: list_sessions refuses no token, an unknown token and an archived card\'s token', async () => {
  await withApi({ LIVE: 'running', GONE: 'archived' }, async ({ api, port }) => {
    const gone = api.tokens.issue('GONE');
    assert.deepEqual(await listSessions(port, {}), { status: 403, body: { error: 'missing-token', reason: 'missing token' } });
    assert.equal((await listSessions(port, { Authorization: 'Bearer awt_unknown' })).body.error, 'unknown-token');
    assert.equal((await listSessions(port, { Authorization: `Bearer ${gone}` })).body.error, 'archived');
    assert.equal((await listSessions(port, { 'X-AW-Session': 'LIVE' })).body.error, 'missing-token', 'no legacy path on the session API port');
  });
});

test('session API: a session claiming another session as caller is refused', async () => {
  await withApi({ LIVE: 'running', OTHER: 'running' }, async ({ api, port }) => {
    const token = api.tokens.issue('LIVE');
    const res = await listSessions(port, { Authorization: `Bearer ${token}`, 'X-AW-Session': 'OTHER' });
    assert.equal(res.status, 403);
    assert.equal(res.body.error, 'claim-mismatch');
  });
});

test('session API: a valid token calls list_sessions as its own card', async () => {
  await withApi({ LIVE: 'running', OTHER: 'running' }, async ({ api, port }) => {
    const res = await listSessions(port, { Authorization: `Bearer ${api.tokens.issue('LIVE')}` });
    assert.equal(res.status, 200);
    assert.equal(res.body.result.structuredContent.caller.sessionId, 'LIVE');
  });
});

test('session API: a browser request (any Origin) is refused, and only the three POST routes exist', async () => {
  await withApi({ LIVE: 'running' }, async ({ api, port }) => {
    const token = api.tokens.issue('LIVE');
    assert.equal((await listSessions(port, { Authorization: `Bearer ${token}`, Origin: 'http://127.0.0.1:7878' })).status, 403);
    assert.equal((await fetch(`http://127.0.0.1:${port}/mcp`)).status, 404);
    assert.equal((await fetch(`http://127.0.0.1:${port}/ws`, { method: 'POST' })).status, 404);
    const attach = await fetch(`http://127.0.0.1:${port}/pr-attach`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
    assert.equal(await attach.text(), 'LIVE');
  });
});

test('legacy routes: a pre-token card id still works there, a token works too, a claim mismatch does not', async () => {
  await withApi({ OLD: 'running', LIVE: 'running', OTHER: 'running' }, async ({ api, legacyPort }) => {
    const token = api.tokens.issue('LIVE');
    const post = (route, headers) => fetch(`http://127.0.0.1:${legacyPort}${route}`, { method: 'POST', headers }).then(async (r) => [r.status, await r.text()]);
    assert.deepEqual(await post('/pr-model', { 'X-AW-Session': 'OLD' }), [200, 'OLD']);
    assert.deepEqual(await post('/pr-model', { Authorization: `Bearer ${token}` }), [200, 'LIVE']);
    assert.equal((await post('/pr-model', { 'X-AW-Session': 'LIVE' }))[0], 403);
    assert.equal((await post('/pr-model', { Authorization: `Bearer ${token}`, 'X-AW-Session': 'OTHER' }))[0], 403);
  });
});

test('legacy routes: an adapter onto the session API that logs one deprecation warning naming its port', async () => {
  await withApi({ OLD: 'running', LIVE: 'running' }, async ({ api, port, legacyPort, warnings }) => {
    const token = api.tokens.issue('LIVE');
    const post = (route, headers) => fetch(`http://127.0.0.1:${legacyPort}${route}`, { method: 'POST', headers }).then((r) => r.status);
    assert.equal(await post('/pr-model', { Authorization: `Bearer ${token}` }), 200);
    assert.equal(await post('/pr-attach', { Authorization: `Bearer ${token}` }), 200);
    assert.equal(await post('/pr-model', {}), 403, 'the same token check');
    assert.equal(await post('/pr-model', { 'X-AW-Session': 'OLD' }), 200);
    const deprecations = warnings.filter((m) => m.includes('deprecated'));
    assert.equal(deprecations.length, 1, warnings.join('\n'));
    assert.match(deprecations[0], new RegExp(`POST /mcp, /pr-attach and /pr-model on the deck's or board's port is deprecated.*session API at http://127\\.0\\.0\\.1:${port}`));
  });
});

test('a request carrying a bearer or an X-AW-Session claim carries a session credential', () => {
  assert.equal(carriesSessionCredential(req({})), false);
  assert.equal(carriesSessionCredential(req({ Authorization: 'Basic abc' })), false);
  assert.equal(carriesSessionCredential(req({ Authorization: 'Bearer awt_x' })), true);
  assert.equal(carriesSessionCredential(req({ 'X-AW-Session': 'awt_x' })), true);
  assert.equal(carriesSessionCredential(req({ 'X-AW-Session': 'C1' })), true);
});

test('a launch carries its token as a secret where the runtime takes secrets, else as env', () => {
  const sm = new SessionManager();
  sm._issueSessionToken = (id) => `awt_${id}`;
  const ctx = { env: { A: '1' }, addDirs: [] };
  assert.deepEqual(sm._withSessionToken({ secretEnv: true }, 'C1', ctx).secretEnv, { AW_SESSION_TOKEN: 'awt_C1' });
  assert.deepEqual(sm._withSessionToken({ secretEnv: true }, 'C1', ctx).env, { A: '1' });
  assert.deepEqual(sm._withSessionToken({}, 'C1', ctx).env, { A: '1', AW_SESSION_TOKEN: 'awt_C1' });
  sm._issueSessionToken = () => null;
  assert.equal(sm._withSessionToken({ secretEnv: true }, 'C1', ctx), ctx);
});

test('an extension\'s AW_SESSION_TOKEN never overrides the token; a buildLaunch runtime gets none', () => {
  const sm = new SessionManager();
  let issued = 0;
  sm._issueSessionToken = (id) => { issued++; return `awt_${id}`; };
  const ctx = { env: { AW_SESSION_TOKEN: 'ext', A: '1' }, addDirs: [] };
  const secret = sm._withSessionToken({ secretEnv: true }, 'C1', ctx);
  assert.deepEqual(secret.env, { A: '1' });
  assert.deepEqual(secret.secretEnv, { AW_SESSION_TOKEN: 'awt_C1' });
  assert.deepEqual(sm._withSessionToken({}, 'C1', ctx).env, { A: '1', AW_SESSION_TOKEN: 'awt_C1' });
  issued = 0;
  assert.equal(sm._withSessionToken({ buildLaunch: () => '' }, 'C1', ctx), ctx);
  assert.equal(issued, 0);
});

test('purging a card revokes its token', () => {
  const sm = new SessionManager();
  sm._save = () => {};
  const revoked = [];
  sm._revokeSessionToken = (id) => revoked.push(id);
  sm.map.set('C1', { tmux: 'cc_1' });
  sm.forget('C1');
  sm.forget('NOPE');
  assert.deepEqual(revoked, ['C1']);
});

test('the session API asks for the port it bound last time, so a restart keeps live sessions\' URLs', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-session-api-'));
  const mk = () => createSessionApi({ dataDir, cardState: () => 'running', handlers: { '/mcp': () => {}, '/pr-attach': () => {}, '/pr-model': () => {} } });
  const blocker = http.createServer();
  await new Promise((r) => blocker.listen(0, '127.0.0.1', r));
  const taken = blocker.address().port;
  const first = mk();
  const fallback = await first.start({ port: taken });
  assert.notEqual(fallback, taken, 'a taken default falls back');
  first.server.close();
  await new Promise((r) => first.server.once('close', r));
  const second = mk();
  assert.equal(await second.start({ port: taken }), fallback, 'the next start reuses the saved port');
  second.server.close();
  blocker.close();
});
