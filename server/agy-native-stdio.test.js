import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fork, execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { syncAgyPlugin } from './agy-plugin.js';
import { createAgyStartup, acceptAgyNative, agyNativeReady } from './agy-startup.js';
import { createMcpRequestHandler } from './mcp/server.js';
import { createHttpServer } from './http-handler.js';
import { INSTALL_ROOT } from './install-root.js';
import { mcpSeenAt } from './mcp-activity.js';

test('installed plugin stdio through the production router waits for native discovery, rejects shell proofs and reconnects', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-native-stdio-'));
  const plugin = path.join(home, '.gemini/config/plugins/agent-wrangler');
  const entry = { agent: 'agy', cwd: home, tmux: 'ag_fake', agyStartup: createAgyStartup() };
  const map = new Map([['card', entry]]);
  const events = [];
  let child, unavailable = false;
  const handler = createMcpRequestHandler({ sessionManager: { entryFor: (id) => map.get(id) }, taskStore: { taskFor: () => null } });
  const server = createHttpServer({
    port: 0,
    mcpRequestHandler: async (req, res) => {
      if (unavailable) { res.writeHead(503).end(); return; }
      return handler(req, res);
    },
    agyHookHandler: async (req, res) => {
      let body = ''; for await (const chunk of req) body += chunk;
      const payload = JSON.parse(body);
      const accepted = await acceptAgyNative(payload, { map, rootPid: async () => child.pid });
      events.push({ state: payload.state, accepted });
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ accepted }));
    },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const execImpl = async (_bin, args) => {
    if (args[1] === 'install') fs.cpSync(args[2], plugin, { recursive: true });
    return { stdout: 'fake installer only' };
  };
  try {
    assert.equal((await syncAgyPlugin({ home, enabled: true, available: async () => true, execImpl })).ready, true);
    const manifest = JSON.parse(fs.readFileSync(path.join(plugin, 'mcp_config.json'), 'utf8')).mcpServers['agent-wrangler'];
    const fake = path.join(home, 'fake-agy.mjs');
    fs.writeFileSync(fake, `
import { Client } from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/client/index.js'))};
import { StdioClientTransport } from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/client/stdio.js'))};
const client = new Client({ name: 'fake-agy-native', version: '1' });
const transport = new StdioClientTransport(${JSON.stringify({ ...manifest, env: { HOME: home, AW_SESSION_ID: 'card', AW_AGY_LAUNCH_ID: entry.agyStartup.launchId, AW_INSTALL_ROOT: INSTALL_ROOT, AW_NODE: process.execPath, AW_PORT: String(port) } })});
await client.connect(transport);
process.on('SIGTERM', () => client.close().finally(() => process.exit()));
process.send({ initialized: true, pid: transport.pid });
process.on('message', async ({ id, op }) => {
  try {
    if (op === 'list') process.send({ id, result: await client.listTools() });
    if (op === 'read') process.send({ id, result: await client.callTool({ name: 'get_session_info', arguments: {} }) });
    if (op === 'close') { await client.close(); process.exit(); }
  } catch (error) { process.send({ id, error: error.message }); }
});
`);
    child = fork(fake, [], { env: { HOME: home, PATH: process.env.PATH }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let stderr = ''; child.stderr.on('data', (chunk) => { stderr += chunk; });
    const initialized = (await once(child, 'message'))[0];
    assert.equal(initialized.initialized, true, stderr);
    assert.ok(Number.isSafeInteger(initialized.pid));
    let sequence = 0;
    const request = (op) => new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => { child.off('message', receive); reject(new Error(`fake ${op} timed out: ${stderr}`)); }, 10000);
      function receive(message) { if (message.id === id) { clearTimeout(timer); child.off('message', receive); resolve(message); } }
      child.on('message', receive); child.send({ id, op });
    });
    assert.equal(agyNativeReady(entry), false, 'stdio initialization is not native tool use');
    unavailable = true;
    assert.ok((await request('list')).error, 'delayed upstream discovery must fail without closing native stdio');
    assert.equal(agyNativeReady(entry), false);
    unavailable = false;
    const { stdout: shellBridge } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', `
      const { createAgyMcpBridge } = await import(${JSON.stringify(new URL('./agy-mcp-entry.js', import.meta.url).href)});
      const bridge = await createAgyMcpBridge();
      console.log((await bridge.listTools()).tools.length);
      await bridge.callTool({ name: 'get_session_info', arguments: {} });
      await bridge.close();
    `], { encoding: 'utf8', env: { ...process.env, HOME: home, AW_SESSION_ID: 'card', AW_PORT: String(port), AW_AGY_LAUNCH_ID: entry.agyStartup.launchId }, timeout: 5000 });
    assert.ok(Number(shellBridge.trim()) > 0);
    assert.equal(agyNativeReady(entry), false, 'shell-created clients cannot prove native readiness');
    assert.ok(mcpSeenAt('card') > 0, 'unrelated HTTP traffic really happened');
    const listing = await request('list');
    assert.equal(listing.error, undefined, listing.error);
    assert.ok(listing.result.tools.some((tool) => tool.name === 'read_mail'));
    assert.equal(agyNativeReady(entry), false, 'cached/listed definitions do not release work');
    assert.equal((await request('read')).result.structuredContent.sessionId, 'card');
    assert.equal(agyNativeReady(entry), true, 'actual installed stdio read proves this launch');
    unavailable = true;
    assert.ok((await request('list')).error);
    assert.equal(agyNativeReady(entry), false);
    unavailable = false;
    assert.ok((await request('list')).result.tools.length > 0);
    assert.equal(agyNativeReady(entry), false, 'reconnect and tools/list need a fresh native read');
    assert.equal((await request('read')).result.structuredContent.sessionId, 'card');
    assert.equal(agyNativeReady(entry), true);
    assert.deepEqual(events.map((e) => e.state), ['ready', 'disconnected', 'ready']);
    assert.ok(events.every((e) => e.accepted));
    child.send({ op: 'close' });
    await once(child, 'exit');
    assert.equal(agyNativeReady(entry), false);
  } finally {
    if (child?.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); }
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('unidentified stdio exposes zero tools and has no HTTP effects; installed wrapper hooks are inert', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-no-identity-'));
  const client = new Client({ name: 'unidentified-fixture', version: '1' });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(INSTALL_ROOT, 'server/agy-mcp-entry.js')], env: { HOME: home } }));
    assert.deepEqual(await client.listTools(), { tools: [] });
    assert.equal((await client.callTool({ name: 'read_mail', arguments: {} })).isError, true);
    const files = (await import('./agy-plugin.js')).pluginFiles(home);
    const wrapper = path.join(home, 'bridge.sh'); fs.writeFileSync(wrapper, files['bridge.sh']);
    assert.equal(execFileSync('/bin/sh', [wrapper, 'hook', 'SessionStart'], { env: { HOME: home }, encoding: 'utf8' }), '');
    assert.equal(fs.existsSync(path.join(home, '.gemini')), false);
  } finally { await client.close(); fs.rmSync(home, { recursive: true, force: true }); }
});

test('stdio entrypoint starts through the upgrade-stable installation symlink', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-stable-entry-'));
  const link = path.join(home, 'stable-entry.mjs');
  const client = new Client({ name: 'stable-path-fixture', version: '1' });
  try {
    fs.symlinkSync(path.join(INSTALL_ROOT, 'server/agy-mcp-entry.js'), link);
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [link], env: { HOME: home } }), { timeout: 1000 });
    assert.deepEqual(await client.listTools(), { tools: [] });
  } finally { await client.close(); fs.rmSync(home, { recursive: true, force: true }); }
});
