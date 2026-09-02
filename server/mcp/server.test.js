import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { extractCaller, buildMcpServer, createMcpRequestHandler } from './server.js';
import { activeTools } from './tools/index.js';

test('extractCaller reads X-AW-Session header', () => {
  assert.equal(extractCaller({ headers: { 'x-aw-session': 'CARD1' } }), 'CARD1');
});

test('extractCaller falls back to Authorization: Bearer', () => {
  assert.equal(extractCaller({ headers: { authorization: 'Bearer CARD2' } }), 'CARD2');
});

test('extractCaller prefers the header over the bearer token', () => {
  assert.equal(
    extractCaller({ headers: { 'x-aw-session': 'CARD1', authorization: 'Bearer CARD2' } }),
    'CARD1',
  );
});

test('extractCaller returns null when neither is present or parseable', () => {
  assert.equal(extractCaller({ headers: {} }), null);
  assert.equal(extractCaller({ headers: { authorization: 'Basic abc' } }), null);
  assert.equal(extractCaller({ headers: { 'x-aw-session': '' } }), null);
});

function fakeDeps() {
  return {
    graph: () => ({ sessions: [{ sessionId: 'CARD1', label: 'A', agent: 'claude', status: 'idle', cwd: '/a' }] }),
    taskStore: { taskFor: (sid) => (sid === 'CARD1' ? { id: 'T1', name: 'Login' } : null) },
  };
}

async function connect(deps, caller, opts) {
  const server = buildMcpServer(deps, caller, opts);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await server.connect(serverT);
  await client.connect(clientT);
  return { client, server };
}

// The tool set is feature-flag dependent (activeTools), so pin the flag rather
// than inheriting whatever this developer's config.json says.
test('buildMcpServer advertises the registered tools in tools/list', async () => {
  const { client, server } = await connect(fakeDeps(), 'CARD1', { tools: activeTools({ checklist: true }) });
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ['add_checklist_item', 'archive_session', 'assign_session', 'attach_session', 'create_terminal', 'detach_session', 'get_links', 'get_session_activity', 'get_session_info', 'list_checklist', 'list_mail', 'list_sessions', 'list_tasks', 'name_branch', 'read_mail', 'remove_checklist_item', 'remove_links', 'schedule_session', 'send_message', 'set_links', 'spawn_session', 'spawn_workflow', 'update_checklist_item', 'workflow_phase']);
  await server.close();
});

test('checklistEnabled:false leaves the four checklist tools out of tools/list entirely', async () => {
  const { client, server } = await connect(fakeDeps(), 'CARD1', { tools: activeTools({ checklist: false }) });
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  for (const n of ['add_checklist_item', 'update_checklist_item', 'remove_checklist_item', 'list_checklist']) {
    assert.ok(!names.includes(n), `${n} must not be advertised when the feature is off`);
  }
  assert.ok(names.includes('list_sessions'), 'everything else still is');
  await server.close();
});

test('buildMcpServer runs list_sessions with the bound caller', async () => {
  const { client, server } = await connect(fakeDeps(), 'CARD1');
  const res = await client.callTool({ name: 'list_sessions', arguments: {} });
  assert.equal(res.structuredContent.caller.sessionId, 'CARD1');
  assert.equal(res.structuredContent.sessions[0].isCaller, true);
  await server.close();
});

test('buildMcpServer runs spawn_session through the SDK schema boundary', async () => {
  const deps = {
    ...fakeDeps(),
    dispatch: async (opts) => { opts.bindMemory?.('NEWCARD'); return { sessionId: 'NEWCARD', cwd: '/a' }; },
    memoryStore: { bindSession: () => {} },
    rebuild: async () => {},
  };
  deps.taskStore = { ...deps.taskStore, assign: () => true };
  const { client, server } = await connect(deps, 'CARD1');
  const res = await client.callTool({ name: 'spawn_session', arguments: { intent: 'do a thing' } });
  assert.equal(res.structuredContent.sessionId, 'NEWCARD');
  // The required `intent` is enforced by the schema at the SDK boundary.
  const missing = await client.callTool({ name: 'spawn_session', arguments: {} });
  assert.equal(missing.isError, true);
  await server.close();
});

async function withServer(deps, fn) {
  const handler = createMcpRequestHandler(deps);
  const srv = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/mcp') return void handler(req, res);
    res.writeHead(404).end();
  });
  await new Promise((r) => srv.listen(0, r));
  try { return await fn(srv.address().port); }
  finally { srv.close(); }
}

async function rpc(port, method, params, id, headers = {}) {
  const r = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  return r.json();
}

test('POST /mcp tools/call attributes the caller from X-AW-Session', async () => {
  await withServer(fakeDeps(), async (port) => {
    const res = await rpc(port, 'tools/call', { name: 'list_sessions', arguments: {} }, 1, { 'X-AW-Session': 'CARD1' });
    assert.equal(res.result.structuredContent.caller.sessionId, 'CARD1');
    assert.equal(res.result.structuredContent.sessions[0].isCaller, true);
  });
});

test('POST /mcp tools/call attributes the caller from a bearer token', async () => {
  await withServer(fakeDeps(), async (port) => {
    const res = await rpc(port, 'tools/call', { name: 'list_sessions', arguments: {} }, 2, { Authorization: 'Bearer CARD1' });
    assert.equal(res.result.structuredContent.caller.sessionId, 'CARD1');
  });
});
