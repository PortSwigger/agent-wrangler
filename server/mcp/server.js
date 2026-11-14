import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { MCP_SERVER_NAME } from './client-config.js';
import { activeTools } from './tools/index.js';
import { noteMcpCaller } from '../mcp-activity.js';
import { logError } from '../log.js';

// Build a fresh MCP server bound to one caller. Stateless: a new server per
// request, so each request's tools act as that request's caller. Tool handlers
// are closed over { deps, caller }; the SDK passes parsed args as the first
// callback param. `tools` comes from activeTools() so a disabled extension's
// tools are genuinely absent from the listing; it's
// injectable so a test can pin the set without writing config.json.
export function buildMcpServer(deps, caller, { tools = activeTools() } = {}) {
  const server = new McpServer({ name: MCP_SERVER_NAME, version: '0.1.0' });
  // Per-CALLER narrowing, the one extension surface that shapes tools an
  // extension does not own: a session KIND (an automation run, say) that must
  // not be offered spawning tools. Bound in server/index.js from the enabled
  // manifests' `hideTool` vetoes (createToolFilter) and absent when none
  // declares one — so the common case is the unfiltered list, by identity.
  // Fails open: see createToolFilter. Never authorization: the session API's
  // caller check (server/session-api/check.js) already decided who the caller is.
  const hide = deps?.ext?.hideTool;
  const visible = hide ? tools.filter((t) => !hide(caller, t.name)) : tools;
  for (const tool of visible) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.inputSchema },
      // An EXTENSION's tool (tagged with its owner by the loader) is invoked
      // with that extension's own `host` façade and never `deps` — the whole
      // point of the façade is that an extension cannot reach a singleton it did
      // not declare. A core tool is untagged and keeps `deps` unchanged.
      (args) => (tool.extId
        ? tool.handler({ host: deps?.hostApiFor?.(tool.extId), caller }, args)
        : tool.handler({ deps, caller }, args)),
    );
  }
  return server;
}

// A (req, res, caller) handler for POST /mcp, where `caller` is the card id the
// session API's check resolved (server/session-api). Stateless streamable-HTTP:
// read the body, build a per-request server, hand the request to the transport.
// enableJsonResponse returns a single JSON body (no SSE) which is all our
// request/response tools need.
export function createMcpRequestHandler(deps) {
  return async function handleMcp(req, res, caller) {
    try {
      // Stamp the caller on EVERY request, boot handshake included: an agent's
      // client connects as part of its own startup and makes no tool call
      // unprompted, so a recently resumed session can wait for this handshake
      // before starting the turn that reads its mail (mcp-activity.js).
      noteMcpCaller(caller);
      let body = '';
      for await (const chunk of req) body += chunk;
      const parsed = body ? JSON.parse(body) : undefined;
      const server = buildMcpServer(deps, caller);
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
}
