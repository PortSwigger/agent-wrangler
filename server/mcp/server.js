import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { toolInputSchema } from '../extensions/tool-schema.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { MCP_SERVER_NAME } from './client-config.js';
import { activeTools } from './tools/index.js';
import { noteMcpCaller } from '../mcp-activity.js';
import { clientViewFor } from '../session-api/client-view.js';
import { logError } from '../log.js';

// The tools an outside client (session-api/clients.js) is offered: only an
// extension's own tool that the same extension lists under a scope the client
// holds (`scopes` is the loader's clientScopes). A core tool is never one, so a
// client never sees session tools, mail or messages, whatever it holds.
export function clientTools(tools, client, scopes = []) {
  const held = new Set(client?.scopes || []);
  const granted = new Set();
  for (const sc of scopes) if (held.has(sc.key)) for (const name of sc.tools) granted.add(`${sc.extId}\u0000${name}`);
  return tools.filter((t) => t.extId && granted.has(`${t.extId}\u0000${t.name}`));
}

const outcomeOf = (r) => (r?.isError ? 'error' : 'ok');

// The tool names each per-request server registered, so a client's call to a
// tool it was not offered (which the SDK answers itself) is still logged.
const registeredNames = new WeakMap();

function reportRefusedCalls(deps, server, client, parsed) {
  const names = registeredNames.get(server);
  for (const msg of Array.isArray(parsed) ? parsed : [parsed]) {
    if (msg?.method !== 'tools/call') continue;
    const name = msg.params?.name;
    if (!names?.has(name)) deps?.outsideClients?.called?.(client, typeof name === 'string' ? name : String(name), 'refused', 0);
  }
}

// Build a fresh MCP server bound to one caller. Stateless: a new server per
// request, so each request's tools act as that request's caller. Tool handlers
// are closed over { deps, caller }; the SDK passes parsed args as the first
// callback param. `tools` comes from activeTools() so a disabled extension's
// tools are genuinely absent from the listing; it's
// injectable so a test can pin the set without writing config.json.
//
// `client` is set instead of `caller` for an outside MCP client: it is offered
// only its scopes' extension tools (clientTools), each extension's hideTool and
// handler see `{ caller: null, client }` with that extension's view of it, and
// every call is reported to `deps.outsideClients.called` for the log (one to a
// tool it was not offered as 'refused', by the request handler).
export function buildMcpServer(deps, caller, { tools = activeTools(), client = null } = {}) {
  const server = new McpServer({ name: MCP_SERVER_NAME, version: '0.1.0' });
  if (client) caller = null;
  const offered = client ? clientTools(tools, client, deps?.ext?.clientScopes?.() || []) : tools;
  // Per-CALLER narrowing, the one extension surface that shapes tools an
  // extension does not own: a session KIND (an automation run, say) that must
  // not be offered spawning tools. Bound in server/index.js from the enabled
  // manifests' `hideTool` vetoes (createToolFilter) and absent when none
  // declares one — so the common case is the unfiltered list, by identity.
  // Fails open: see createToolFilter. Never authorization: the session API's
  // caller check (server/session-api/check.js) already decided who the caller is.
  const hide = deps?.ext?.hideTool;
  const visible = hide ? offered.filter((t) => !hide(caller, t.name, client)) : offered;
  const advertised = [];
  for (const tool of visible) {
    const converted = toolInputSchema(tool, deps?.hostApiFor);
    if (!converted) continue;
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: converted.schema },
      // An EXTENSION's tool (tagged with its owner by the loader) is invoked
      // with that extension's own `host` façade and never `deps` — the whole
      // point of the façade is that an extension cannot reach a singleton it did
      // not declare. A core tool is untagged and keeps `deps` unchanged.
      (args) => {
        const invoke = () => (tool.extId
          ? tool.handler({ host: deps?.hostApiFor?.(tool.extId), caller, client: clientViewFor(client, tool.extId) }, args)
          : tool.handler({ deps, caller }, args));
        const run = () => (deps?.restartBarrier ? deps.restartBarrier.run(invoke, `mcp:${tool.name}`) : invoke());
        if (!client) return run();
        const started = Date.now();
        const report = (outcome) => deps?.outsideClients?.called?.(client, tool.name, outcome, Date.now() - started);
        return Promise.resolve().then(run).then((r) => { report(outcomeOf(r)); return r; }, (err) => { report('threw'); throw err; });
      },
    );
    advertised.push({ name: tool.name, description: tool.description, inputSchema: converted.jsonSchema, execution: { taskSupport: 'forbidden' } });
  }
  registeredNames.set(server, new Set(advertised.map((t) => t.name)));
  // Serve the checked conversion rather than letting the SDK convert it again.
  server.server.registerCapabilities({ tools: { listChanged: true } });
  server.server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: advertised }));
  return server;
}

// A (req, res, caller, client) handler for POST /mcp, where `caller` is the card
// id the session API's check resolved (server/session-api), or null with
// `client` set for an outside client. Stateless streamable-HTTP: read the body,
// build a per-request server, hand the request to the transport.
// enableJsonResponse returns a single JSON body (no SSE) which is all our
// request/response tools need.
export function createMcpRequestHandler(deps) {
  const handleMcp = async (req, res, caller, client = null) => {
    try {
      // An outside client is no card: nothing is stamped, its last use is noted.
      if (client) deps?.outsideClients?.seen?.(client);
      // Stamp the caller on EVERY request, boot handshake included: an agent's
      // client connects as part of its own startup and makes no tool call
      // unprompted, so a recently resumed session can wait for this handshake
      // before starting the turn that reads its mail (mcp-activity.js).
      if (!client) noteMcpCaller(caller);
      let body = '';
      for await (const chunk of req) body += chunk;
      const parsed = body ? JSON.parse(body) : undefined;
      const server = buildMcpServer(deps, client ? null : caller, { client });
      if (client) reportRefusedCalls(deps, server, client, parsed);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      res.on('close', () => { transport.close(); server.close(); });
      await server.connect(transport);
      await transport.handleRequest(req, res, parsed);
    } catch (err) {
      logError('[mcp]', err);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: 'internal error' }, id: null }));
      }
    }
  };
  // The request itself is untracked: an MCP client can hold its connection open
  // idle for as long as it stays connected, and that must not keep a restart
  // pending. The work inside it is tracked by each tool's own `mcp:<tool>` run.
  return deps?.restartBarrier
    ? deps.restartBarrier.http(handleMcp, 'http:/mcp', { track: false })
    : handleMcp;
}
