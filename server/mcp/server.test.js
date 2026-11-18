import { buildHostApi } from '../host-api/index.js';
import { extensionToolSchemaFailures } from '../extensions/tool-schema.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { z } from 'zod/v4';
import { extensionToolFingerprint } from '../extensions/tool-fingerprint.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildMcpServer, createMcpRequestHandler } from './server.js';
import { createSessionApiServer } from '../session-api/server.js';
import { activeTools } from './tools/index.js';
import { mcpSeenAt } from '../mcp-activity.js';
// No extension contributes a tool today; pinned rather than inherited so these
// assert the core registry itself.
const NO_EXT = { tools: [], allowedToolNames: [] };

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
  const { client, server } = await connect(fakeDeps(), 'CARD1', { tools: activeTools({ ext: NO_EXT }) });
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ['archive_session', 'assign_session', 'attach_session', 'cancel_schedule', 'create_terminal', 'detach_session', 'get_links', 'get_model_front', 'get_session_activity', 'get_session_cost', 'get_session_info', 'list_mail', 'list_sessions', 'list_tasks', 'name_branch', 'read_mail', 'read_session_transcript', 'remove_links', 'rename_session', 'request_repo', 'restore_session', 'restore_task', 'schedule_session', 'send_message', 'set_links', 'spawn_session', 'spawn_workflow', 'stop_status_notices', 'update_schedule', 'workflow_phase']);
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
  const tools = activeTools({ ext: NO_EXT });
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

test('get_model_front is callable through MCP with schema validation and helpful choice errors', async () => {
  const { client, server } = await connect({ agents: async () => [
    { id: 'claude', models: [{ value: 'opus', autoEffort: 'high' }], efforts: [{ value: 'high' }] },
  ] }, null);
  try {
    const result = await client.callTool({ name: 'get_model_front', arguments: { pick: { agent: 'claude', model: 'opus' } } });
    assert.equal(result.structuredContent.pick.resolvedEffort, 'high');
    assert.equal(result.structuredContent.pick.onFront, true);
    assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
    for (const args of [{ maxUsd: 0 }, { maxUsd: -1 }, { minQuality: -1 }, { minQuality: 101 }, { pick: { agent: 'claude' } }]) {
      assert.equal((await client.callTool({ name: 'get_model_front', arguments: args })).isError, true);
    }
    const unknown = await client.callTool({ name: 'get_model_front', arguments: { agent: 'typo' } });
    assert.equal(unknown.isError, true);
    assert.match(unknown.content[0].text, /Valid agents: claude/);
  } finally {
    await client.close();
    await server.close();
  }
});

test('buildMcpServer runs spawn_session through the SDK schema boundary', async () => {
  const deps = {
    ...fakeDeps(),
    dispatch: async () => ({ sessionId: 'NEWCARD', cwd: '/a' }),
    rebuild: async () => {},
  };
  deps.taskStore = { ...deps.taskStore, assign: () => true };
  const { client, server } = await connect(deps, 'CARD1');
  const res = await client.callTool({ name: 'spawn_session', arguments: { intent: 'do a thing' } });
  assert.equal(res.structuredContent.sessionId, 'NEWCARD');
  // The required `intent` is enforced by the schema at the SDK boundary.
  const missing = await client.callTool({ name: 'spawn_session', arguments: {} });
  assert.equal(missing.isError, true);
  const invalidMode = await client.callTool({ name: 'spawn_session', arguments: { intent: 'x', permission_mode: 'invalid' } });
  assert.equal(invalidMode.isError, true);
  await server.close();
});

// The handler behind the session API's own listener, with a check that maps
// `Bearer tok-<card>` to that card.
const tokenCheck = (req) => {
  const m = /^Bearer tok-(\S+)$/.exec(req.headers.authorization || '');
  return m ? { cardId: m[1] } : { refuse: 'missing-token', reason: 'missing token' };
};

async function withServer(deps, fn) {
  const srv = createSessionApiServer({ resolve: tokenCheck, handlers: { '/mcp': createMcpRequestHandler(deps) } });
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

test('POST /mcp tools/call acts as the card the check resolved', async () => {
  await withServer(fakeDeps(), async (port) => {
    const res = await rpc(port, 'tools/call', { name: 'list_sessions', arguments: {} }, 1, { Authorization: 'Bearer tok-CARD1' });
    assert.equal(res.result.structuredContent.caller.sessionId, 'CARD1');
    assert.equal(res.result.structuredContent.sessions[0].isCaller, true);
  });
});

// A recently resumed session's mail prompt waits for its MCP client to connect
// since the relaunch (mcp-activity.js). The BOOT handshake stamps the card
// before any tool call, so the gate can release as soon as the client is ready.
test('POST /mcp records the caller at its initialize handshake, before any tool call', async () => {
  await withServer(fakeDeps(), async (port) => {
    const before = mcpSeenAt('CARD-BOOT');
    await rpc(port, 'initialize', {
      protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' },
    }, 3, { Authorization: 'Bearer tok-CARD-BOOT' });
    assert.ok(mcpSeenAt('CARD-BOOT') > before, 'initialize must stamp the caller');
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

test('SDK boundary forwards Remote Control for explicit/default Claude including a Codex caller and rejects invalid options', async () => {
  const seen = { dispatch: [], assign: [], rebuild: 0 };
  const deps = {
    ...fakeDeps(),
    sessionManager: { entryFor: () => ({ agent: 'codex', model: 'gpt-6-sol', effort: 'ultra' }) },
    dispatch: async (opts) => { seen.dispatch.push(opts); return { sessionId: 'NEWCARD', cwd: '/a' }; },
    taskStore: { taskFor: () => ({ id: 'T1' }), assign: (...args) => seen.assign.push(args) },
    rebuild: async () => { seen.rebuild++; },
  };
  const { client, server } = await connect(deps, 'CARD1');
  try {
    const tool = (await client.listTools()).tools.find((t) => t.name === 'spawn_session');
    assert.equal(tool.inputSchema.properties.remote_control.type, 'string');
    assert.match(tool.inputSchema.properties.remote_control.description, /Claude/);
    for (const args of [{ agent: 'claude', remote_control: ' Phone ' }, { remote_control: 'Phone' }, {}]) {
      const out = await client.callTool({ name: 'spawn_session', arguments: { intent: 'x', ...args } });
      assert.equal(out.isError, undefined);
    }
    assert.deepEqual(seen.dispatch.slice(0, 2).map((o) => ({ agent: o.agent, remoteControl: o.remoteControl, model: o.model, effort: o.effort })), [
      { agent: 'claude', remoteControl: { name: 'Phone' }, model: undefined, effort: undefined },
      { agent: 'claude', remoteControl: { name: 'Phone' }, model: undefined, effort: undefined },
    ]);
    assert.equal('remoteControl' in seen.dispatch[2], false);
    for (const args of [
      { remote_control: 42 }, { remote_control: null }, { remote_control: {} },
      { remote_control: '' }, { remote_control: 'a\nb' }, { remote_control: ' --flag' },
      { remote_control: 'Phone', agent: 'codex' }, { remote_control: 'Phone', agent: 'unknown' },
    ]) {
      const out = await client.callTool({ name: 'spawn_session', arguments: { intent: 'x', ...args } });
      assert.equal(out.isError, true);
      if (args.agent) assert.ok(out.content[0].text.includes(args.agent));
    }
    assert.equal(seen.dispatch.length, 3);
    assert.equal(seen.assign.length, 3);
    assert.equal(seen.rebuild, 3);
  } finally {
    await server.close();
  }
});

test('update_schedule is callable over MCP and validates patches without writes', async () => {
  let updated = 0;
  const stored = { id: 'sch_existing', name: 'Check', enabled: true, when: { kind: 'once', runAt: '2035-01-01T00:00:00.000Z' }, action: { kind: 'session', sessionId: 'CARD1', message: 'Original' }, nextRunAt: '2035-01-01T00:00:00.000Z' };
  const { client, server } = await connect({ ...fakeDeps(), scheduleStore: { schedules: [stored], update: (id, patch) => { updated++; return { ...stored, ...patch }; } }, rebuild: async () => {} }, 'CARD1');
  try {
    for (const arguments_ of [{}, { id: stored.id, name: 2 }, { id: stored.id, kind: 'other' }, { id: stored.id, auto_compact_tokens: 1 }, { id: stored.id, at: 'invalid' }]) {
      assert.equal((await client.callTool({ name: 'update_schedule', arguments: arguments_ })).isError, true);
    }
    assert.equal(updated, 0);
    const result = await client.callTool({ name: 'update_schedule', arguments: { id: stored.id, name: 'Edited' } });
    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent.id, stored.id);
    assert.equal(result.structuredContent.name, 'Edited');
    assert.equal(result.structuredContent.nextRunAt, stored.nextRunAt);
    assert.equal(updated, 1);
  } finally { await client.close(); await server.close(); }
});

test('SDK boundary exposes Codex approval_policy and rejects invalid values before dispatch', async () => {
  const dispatches = [];
  const deps = { ...fakeDeps(), dispatch: async (opts) => { dispatches.push(opts); return { sessionId: 'NEWCARD' }; }, rebuild: async () => {} };
  const { client, server } = await connect(deps, null);
  try {
    const tool = (await client.listTools()).tools.find((t) => t.name === 'spawn_session');
    assert.deepEqual(tool.inputSchema.properties.approval_policy.enum, ['on-request', 'never']);
    for (const approval_policy of ['on-request', 'never']) {
      const out = await client.callTool({ name: 'spawn_session', arguments: { intent: 'x', agent: 'codex', approval_policy } });
      assert.equal(out.isError, undefined);
      assert.equal(dispatches.at(-1).approvalPolicy, approval_policy);
      assert.equal('codexPolicy' in dispatches.at(-1), false);
    }
    for (const approval_policy of ['untrusted', 'on-failure', '', null, 42]) {
      const out = await client.callTool({ name: 'spawn_session', arguments: { intent: 'x', agent: 'codex', approval_policy } });
      assert.equal(out.isError, true);
    }
    assert.equal(dispatches.length, 2);
  } finally {
    await client.close();
    await server.close();
  }
});

test('a session at a location is offered exactly the tools any other session is', async () => {
  const entries = { LOC: { runtime: 'testloc', location: { box: 1 }, repos: ['acme/widgets'], cwd: '/w' }, HOST: { cwd: '/a' } };
  const deps = { ...fakeDeps(), sessionManager: { entryFor: (id) => entries[id] ?? null } };
  const tools = activeTools({ ext: NO_EXT });
  const names = async (caller) => {
    const { client, server } = await connect(deps, caller, { tools });
    const list = (await client.listTools()).tools.map((t) => t.name).sort();
    await server.close();
    return list;
  };
  const atLocation = await names('LOC');
  assert.deepEqual(atLocation, await names('HOST'));
  assert.equal(atLocation.length, tools.length);
});

test('restart waits for an MCP mutation and its response, then refuses fresh calls', async (t) => {
  const { createRestartBarrier } = await import('../restart-barrier.js');
  let release;
  let entered;
  const started = new Promise((r) => { entered = r; });
  const gate = new Promise((r) => { release = r; });
  t.after(() => release());
  const exits = [];
  const barrier = createRestartBarrier({ timeoutMs: 1000, settleMs: 0, exit: () => exits.push('exit') });
  const deps = { ...fakeDeps(), restartBarrier: barrier, dispatch: async () => { entered(); await gate; return { sessionId: 'NEW', cwd: '/a' }; }, rebuild: async () => {} };
  deps.taskStore.assign = () => true;
  await withServer(deps, async (port) => {
    const pending = rpc(port, 'tools/call', { name: 'spawn_session', arguments: { intent: 'work' } }, 100, { Authorization: 'Bearer tok-CARD1' });
    await started;
    assert.deepEqual(barrier.outstanding().map((o) => o.label), ['mcp:spawn_session']);
    const restarting = barrier.request('update');
    assert.deepEqual(exits, []);
    const refused = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', headers: { Authorization: 'Bearer tok-CARD1' }, body: '{}' });
    assert.equal(refused.status, 503);
    release();
    const response = await pending;
    assert.equal(response.result.structuredContent.sessionId, 'NEW');
    assert.equal(await restarting, true);
  });
});

// An MCP client can hold a /mcp connection open idle for as long as it stays
// connected (here: a POST whose body never finishes). That must not hold an
// unattended restart pending; a tool call inside one still does.
async function openStream(port) {
  const req = http.request({ host: '127.0.0.1', port, path: '/mcp', method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok-CARD1' } });
  req.on('error', () => {});
  req.flushHeaders();
  req.write('{"jsonrpc":"2.0",');
  await new Promise((r) => setTimeout(r, 20));
  return { close: () => req.destroy() };
}

test('an open /mcp stream does not block an unforced restart', async () => {
  const { createRestartBarrier } = await import('../restart-barrier.js');
  const exits = [];
  const statuses = [];
  const barrier = createRestartBarrier({ timeoutMs: 200, settleMs: 0, exit: () => exits.push('exit'), onStatus: (s) => statuses.push(s.phase) });
  await withServer({ ...fakeDeps(), restartBarrier: barrier }, async (port) => {
    const stream = await openStream(port);
    try {
      assert.deepEqual(barrier.outstanding(), []);
      assert.equal(await barrier.request('update'), true);
      assert.deepEqual(exits, ['exit']);
      assert.deepEqual(statuses, ['draining', 'restarting']);
      // Admission stays closed to fresh MCP requests while the restart lands.
      const refused = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', headers: { Authorization: 'Bearer tok-CARD1' }, body: '{}' });
      assert.equal(refused.status, 503);
    } finally { stream.close(); }
  });
});

test('a pending MCP tool call still leaves an unforced restart pending beside an open stream', async (t) => {
  const { createRestartBarrier } = await import('../restart-barrier.js');
  let release;
  let entered;
  const started = new Promise((r) => { entered = r; });
  const gate = new Promise((r) => { release = r; });
  t.after(() => release());
  const exits = [];
  const statuses = [];
  const barrier = createRestartBarrier({ timeoutMs: 200, settleMs: 0, exit: () => exits.push('exit'), onStatus: (s) => statuses.push(s) });
  const deps = { ...fakeDeps(), restartBarrier: barrier, dispatch: async () => { entered(); await gate; return { sessionId: 'NEW', cwd: '/a' }; }, rebuild: async () => {} };
  deps.taskStore.assign = () => true;
  await withServer(deps, async (port) => {
    const stream = await openStream(port);
    try {
      const pending = rpc(port, 'tools/call', { name: 'spawn_session', arguments: { intent: 'work' } }, 101, { Authorization: 'Bearer tok-CARD1' });
      await started;
      assert.equal(await barrier.request('update'), false);
      assert.deepEqual(exits, []);
      const last = statuses.at(-1);
      assert.equal(last.phase, 'pending');
      assert.deepEqual(last.running.map((r) => r.label), ['mcp:spawn_session']);
      release();
      assert.equal((await pending).result.structuredContent.sessionId, 'NEW');
    } finally { stream.close(); }
  });
});

test('throwing extension schemas leave tools/list and healthy calls working and log once', async (t) => {
  const warnings = [];
  t.mock.method(console, 'warn', (...args) => warnings.push(args.join(' ')));
  const broken = z.object({ title: z.string() });
  broken._zod.toJSONSchema = () => { throw new TypeError("Cannot read properties of undefined (reading 'ref')"); };
  const tools = [
    { name: 'broken_probe', extId: 'broken-extension', description: 'Broken', inputSchema: broken, handler: () => { throw new Error('must not run'); } },
    { name: 'healthy_probe', extId: 'healthy-extension', description: 'Healthy', inputSchema: { title: z.string() }, handler: (_, args) => ({ content: [{ type: 'text', text: args.title }] }) },
    ...activeTools({ ext: NO_EXT }),
  ];
  for (let i = 0; i < 2; i++) {
    const { client, server } = await connect(fakeDeps(), 'CARD1', { tools });
    try {
      const listed = (await client.listTools()).tools;
      assert.equal(listed.length, tools.length - 1);
      assert.ok(!listed.some((tool) => tool.name === 'broken_probe'));
      assert.equal(listed.find((tool) => tool.name === 'healthy_probe').inputSchema.properties.title.type, 'string');
      assert.equal((await client.callTool({ name: 'healthy_probe', arguments: { title: 'ok' } })).content[0].text, 'ok');
      assert.equal((await client.callTool({ name: 'healthy_probe', arguments: {} })).isError, true);
      assert.equal((await client.callTool({ name: 'list_sessions', arguments: {} })).isError, undefined);
      const omitted = await client.callTool({ name: 'broken_probe', arguments: {} });
      assert.equal(omitted.isError, true);
      assert.match(omitted.content[0].text, /not found/);
    } finally { await client.close(); await server.close(); }
  }
  assert.equal(extensionToolFingerprint(tools.slice(0, 2)), extensionToolFingerprint(tools.slice(1, 2)));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /broken-extension.*broken_probe/);
});

test('tools/list isolates raw shapes, normalization errors and non-JSON conversion results', async () => {
  const field = z.string();
  field._zod.toJSONSchema = () => { throw new Error('broken field'); };
  const bigint = z.object({});
  bigint._zod.toJSONSchema = () => ({ type: 'object', value: 1n });
  const circular = z.object({});
  const cycle = {}; cycle.self = cycle;
  circular._zod.toJSONSchema = () => ({ type: 'object', value: cycle });
  const normalization = Object.defineProperty({}, '_zod', { get() { throw new Error('normalization'); } });
  const tools = [{ field }, normalization, bigint, circular].map((inputSchema, i) => ({
    name: `bad_${i}`, extId: 'invalid-schemas', inputSchema, handler: () => ({ content: [] }),
  }));
  const { client, server } = await connect(fakeDeps(), 'CARD1', { tools });
  try {
    assert.deepEqual((await client.listTools()).tools, []);
  } finally { await client.close(); await server.close(); }
});

test('tools/list uses the checked conversion without invoking an extension converter again', async () => {
  let conversions = 0;
  const schema = z.object({});
  schema._zod.toJSONSchema = () => {
    if (++conversions > 1) throw new Error('converted twice');
    return { type: 'object', properties: { title: { type: 'string' } } };
  };
  const { client, server } = await connect(fakeDeps(), 'CARD1', { tools: [{
    name: 'once_probe', extId: 'once', inputSchema: schema, handler: () => ({ content: [] }),
  }] });
  try {
    for (let i = 0; i < 2; i++) {
      const listed = (await client.listTools()).tools;
      assert.equal(listed[0].inputSchema.properties.title.type, 'string');
    }
    assert.equal(conversions, 1);
  } finally { await client.close(); await server.close(); }
});

test('host schema factories power MCP listing, validation, fingerprints and diagnostics', async () => {
  const host = buildHostApi({ id: 'schema-demo', requires: ['schema:zod'], range: '^2.1.0' });
  const hostApiFor = (id) => { assert.equal(id, host.id); return host; };
  const tools = [{
    name: 'host_schema_probe', extId: host.id, description: 'Example',
    inputSchema: ({ host }) => ({ title: host.schema.z.string().min(1) }),
    handler: (_, args) => ({ content: [{ type: 'text', text: args.title }] }),
  }];
  const staticTools = [{ ...tools[0], inputSchema: { title: z.string().min(1) } }];
  assert.equal(extensionToolFingerprint(tools, hostApiFor), extensionToolFingerprint(staticTools));
  assert.deepEqual(extensionToolSchemaFailures(tools, hostApiFor), []);
  const { client, server } = await connect({ ...fakeDeps(), hostApiFor }, 'CARD1', { tools });
  try {
    const listed = (await client.listTools()).tools;
    assert.equal(listed[0].inputSchema.properties.title.type, 'string');
    assert.equal((await client.callTool({ name: tools[0].name, arguments: { title: 'ok' } })).content[0].text, 'ok');
    assert.equal((await client.callTool({ name: tools[0].name, arguments: { title: '' } })).isError, true);
  } finally { await client.close(); await server.close(); }
});
