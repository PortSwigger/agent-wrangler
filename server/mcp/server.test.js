import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { extractCaller, buildMcpServer, createMcpRequestHandler } from './server.js';
import { activeTools } from './tools/index.js';
import { mcpSeenAt } from '../mcp-activity.js';
// No extension contributes a tool today; pinned rather than inherited so these
// assert the core registry itself.
const NO_EXT = { tools: [], allowedToolNames: [] };

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

// The tool set is feature-flag and extension dependent (activeTools), so pin both
// rather than inheriting whatever this developer's config.json says.
test('buildMcpServer advertises the registered tools in tools/list', async () => {
  const { client, server } = await connect(fakeDeps(), 'CARD1', { tools: activeTools({ checklist: true, ext: NO_EXT }) });
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ['add_checklist_item', 'archive_session', 'assign_session', 'attach_session', 'create_terminal', 'detach_session', 'get_links', 'get_session_activity', 'get_session_cost', 'get_session_info', 'list_checklist', 'list_mail', 'list_sessions', 'list_tasks', 'name_branch', 'read_mail', 'remove_checklist_item', 'remove_links', 'schedule_session', 'send_message', 'set_links', 'spawn_session', 'spawn_workflow', 'update_checklist_item', 'workflow_phase']);
  await server.close();
});

test('checklistEnabled:false leaves the four checklist tools out of tools/list entirely', async () => {
  const { client, server } = await connect(fakeDeps(), 'CARD1', { tools: activeTools({ checklist: false, ext: NO_EXT }) });
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  for (const n of ['add_checklist_item', 'update_checklist_item', 'remove_checklist_item', 'list_checklist']) {
    assert.ok(!names.includes(n), `${n} must not be advertised when the feature is off`);
  }
  assert.ok(names.includes('list_sessions'), 'everything else still is');
  await server.close();
});

// The per-caller veto (deps.ext.hideTool, composed from the enabled manifests'
// `hideTool` by createToolFilter). This is the one extension surface that shapes
// tools an extension does not own, so both directions matter: it really does
// remove the tool from the listing, and it is asked per caller.
test('deps.ext.hideTool drops a tool from one caller\'s listing only', async () => {
  const asked = [];
  const deps = { ...fakeDeps(), ext: { hideTool: (caller, tool) => { asked.push([caller, tool]); return caller === 'JOB1' && tool === 'spawn_session'; } } };
  const hidden = await connect(deps, 'JOB1');
  assert.ok(!(await hidden.client.listTools()).tools.map((t) => t.name).includes('spawn_session'));
  await hidden.server.close();
  const shown = await connect(deps, 'CARD1');
  assert.ok((await shown.client.listTools()).tools.map((t) => t.name).includes('spawn_session'));
  await shown.server.close();
  assert.ok(asked.some(([c, t]) => c === 'JOB1' && t === 'spawn_session'));
});

test('no hideTool at all leaves the tool list untouched by identity', async () => {
  const tools = activeTools({ checklist: true, ext: NO_EXT });
  const { client, server } = await connect({ ...fakeDeps(), ext: { hideTool: null } }, 'CARD1', { tools });
  assert.equal((await client.listTools()).tools.length, tools.length);
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

// The dormant mail wake gates its paste on "this card's MCP client has connected
// since the relaunch" (mcp-activity.js), so what matters is that the BOOT
// handshake — not just a later tools/call — is what stamps the card. A launched
// agent makes no tool call of its own accord, so recording only tools/call would
// leave the gate waiting for its full timeout on every wake.
test('POST /mcp records the caller at its initialize handshake, before any tool call', async () => {
  await withServer(fakeDeps(), async (port) => {
    const before = mcpSeenAt('CARD-BOOT');
    await rpc(port, 'initialize', {
      protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' },
    }, 3, { 'X-AW-Session': 'CARD-BOOT' });
    assert.ok(mcpSeenAt('CARD-BOOT') > before, 'initialize must stamp the caller');
  });
});

test('POST /mcp records a Codex caller from its bearer token too', async () => {
  await withServer(fakeDeps(), async (port) => {
    await rpc(port, 'tools/call', { name: 'list_sessions', arguments: {} }, 4, { Authorization: 'Bearer CARD-CX' });
    assert.ok(mcpSeenAt('CARD-CX') > 0);
  });
});

// The facade branch: an extension's tool is tagged with its owner by the loader
// and must be invoked with THAT extension's host facade and no `deps` at all —
// the surface narrowing is worthless if the tool can still reach the core bag.
// A core tool is untagged and keeps `deps` exactly as before.
test('buildMcpServer invokes a tagged tool with its facade and an untagged one with deps', async () => {
  const seen = [];
  const host = { id: 'fake', rebuild() {} };
  const deps = { ...fakeDeps(), hostApiFor: (id) => (id === 'fake' ? host : null) };
  const tools = [
    { name: 'ext_tool', extId: 'fake', description: 'x', inputSchema: {}, handler: (frame) => { seen.push(frame); return { content: [] }; } },
    { name: 'core_tool', description: 'x', inputSchema: {}, handler: (frame) => { seen.push(frame); return { content: [] }; } },
  ];
  const { client, server } = await connect(deps, 'CARD1', { tools });
  await client.callTool({ name: 'ext_tool', arguments: {} });
  await client.callTool({ name: 'core_tool', arguments: {} });
  await client.close();
  await server.close();
  assert.equal(seen[0].host, host);
  assert.equal(seen[0].deps, undefined, 'an extension tool must not see the core deps bag');
  assert.equal(seen[0].caller, 'CARD1');
  assert.equal(seen[1].deps, deps);
  assert.equal(seen[1].host, undefined);
});
