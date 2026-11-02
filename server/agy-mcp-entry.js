import crypto from 'node:crypto';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
export async function createAgyMcpBridge({ env = process.env, connect, report = async () => false } = {}) {
  let client, connecting, ready = false, closed = false;
  let connectionId, pending = Promise.resolve(), invalidation = Promise.resolve();
  const run = (fn) => { const result = pending.then(fn); pending = result.catch(() => {}); return result; };
  async function disconnect() {
    ready = false;
    const old = client, generation = connectionId; client = null;
    await invalidation;
    if (old) await report({ state: 'disconnected', connectionId: generation }).catch(() => {});
    try { await old?.close?.(); } catch {}
  }
  async function getClient() {
    if (closed) throw new Error('Wrangler bridge closed.');
    if (!env.AW_SESSION_ID) return null;
    await invalidation;
    if (client) return client;
    if (!connecting) connecting = (async () => {
      if (connect) return connect();
      const port = Number(env.AW_PORT);
      if (!(port > 0 && port <= 65535)) throw new Error('Invalid Wrangler port.');
      const next = new Client({ name: 'agy-wrangler-bridge', version: '2' });
      try {
        await next.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { 'X-AW-Session': env.AW_SESSION_ID } } }), { timeout: 1000 });
        return next;
      } catch (error) { await next.close().catch(() => {}); throw error; }
    })().then((next) => {
      const generation = crypto.randomUUID();
      const invalidate = () => {
        if (client !== next) return;
        client = null; ready = false;
        invalidation = report({ state: 'disconnected', connectionId: generation }).catch(() => {});
        void Promise.resolve().then(() => next.close?.()).catch(() => {});
      };
      next.onclose = invalidate;
      next.onerror = invalidate;
      connectionId = generation;
      client = next; return next;
    }).finally(() => { connecting = null; });
    return connecting;
  }
  const unavailable = () => ({ isError: true, content: [{ type: 'text', text: 'Native Wrangler startup is pending. Use native get_session_info; do not build a shell bridge.' }] });
  return {
    listTools: () => run(async () => {
      try {
        const next = await getClient();
        return next ? await next.listTools(undefined, { timeout: 2000 }) : { tools: [] };
      } catch (error) { await disconnect(); throw error; }
    }),
    callTool: (params) => run(async () => {
      if (!env.AW_SESSION_ID) return unavailable();
      if (!ready && params.name !== 'get_session_info') return unavailable();
      try {
        const next = await getClient();
        const generation = connectionId;
        const result = await next.callTool(params, undefined, { timeout: 10000 });
        if (params.name === 'get_session_info') {
          const definitions = await next.listTools(undefined, { timeout: 2000 });
          if (client === next && !result.isError && result.structuredContent?.sessionId === env.AW_SESSION_ID && ['get_session_info', 'read_mail', 'rename_session'].every((name) => definitions.tools?.some((t) => t.name === name))) {
            const accepted = await report({ state: 'ready', connectionId: generation });
            ready = accepted && client === next;
            if (!ready) await report({ state: 'disconnected', connectionId: generation }).catch(() => {});
          }
          else await disconnect();
        }
        return result;
      } catch (error) {
        await disconnect();
        return { isError: true, content: [{ type: 'text', text: `Wrangler transport failed; this call was not retried. Its outcome may be unknown. ${error.message}` }] };
      }
    }),
    close: () => run(async () => { closed = true; await disconnect(); }),
  };
}
let entrypoint = false;
try { entrypoint = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href; } catch {}
if (entrypoint) {
  const report = async (payload) => {
    if (!process.env.AW_SESSION_ID || !process.env.AW_AGY_LAUNCH_ID) return false;
    try {
      const response = await fetch(`http://127.0.0.1:${Number(process.env.AW_PORT)}/agy-hook`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(900),
        body: JSON.stringify({ ...payload, event: 'NativeMcp', cardId: process.env.AW_SESSION_ID, launchId: process.env.AW_AGY_LAUNCH_ID, pid: process.pid }),
      });
      return response.ok && (await response.json()).accepted === true;
    } catch { return false; }
  };
  const bridge = await createAgyMcpBridge({ report });
  const server = new Server({ name: 'agent-wrangler', version: '2' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, () => bridge.listTools());
  server.setRequestHandler(CallToolRequestSchema, (req) => bridge.callTool(req.params));
  await server.connect(new StdioServerTransport());
  process.on('SIGTERM', () => { void bridge.close().finally(() => server.close()); });
}
