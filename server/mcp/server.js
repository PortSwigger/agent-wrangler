import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { MCP_SERVER_NAME } from './client-config.js';
import { activeTools } from './tools/index.js';
import { noteMcpCaller } from '../mcp-activity.js';
import { logError } from '../log.js';

// Resolve the calling session's CARD ID from an MCP request. Claude sends it as
// a custom header (X-AW-Session); Codex can't send arbitrary headers, so it
// carries the same id as an Authorization bearer token. Either way the value is
// the card id — the stable mapping key, NEVER the liveSessionId. Advisory only
// (localhost, same posture as /ws); not authentication.
export function extractCaller(req) {
  const headers = req?.headers || {};
  const fromHeader = headers['x-aw-session'];
  if (typeof fromHeader === 'string' && fromHeader.length) return fromHeader;
  const auth = headers['authorization'];
  if (typeof auth === 'string') {
    const m = auth.match(/^Bearer\s+(.+)$/);
    if (m && m[1].length) return m[1];
  }
  return null;
}

// Build a fresh MCP server bound to one caller. Stateless: a new server per
// request, so each request's tools act as that request's caller. Tool handlers
// are closed over { deps, caller }; the SDK passes parsed args as the first
// callback param. `tools` comes from activeTools() so a feature-flagged tool
// (the checklist four) is genuinely absent from the listing when disabled; it's
// injectable so a test can pin the set without writing config.json.
export function buildMcpServer(deps, caller, { tools = activeTools() } = {}) {
  const server = new McpServer({ name: MCP_SERVER_NAME, version: '0.1.0' });
  // Per-CALLER narrowing, the one extension surface that shapes tools an
  // extension does not own: a session KIND (an automation run, say) that must
  // not be offered spawning tools. Bound in server/index.js from the enabled
  // manifests' `hideTool` vetoes (createToolFilter) and absent when none
  // declares one — so the common case is the unfiltered list, by identity.
  // Fails open: see createToolFilter. Never authorization — extractCaller is
  // advisory, and the origin gate is what actually accepts the request.
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

// An (req,res) handler for POST /mcp, mounted on the existing http server.
// Stateless streamable-HTTP: read identity + body, build a per-request server,
// hand the request to the transport. enableJsonResponse returns a single JSON
// body (no SSE) which is all our request/response tools need.
export function createMcpRequestHandler(deps) {
  return async function handleMcp(req, res) {
    try {
      const caller = extractCaller(req);
      // Stamp the caller on EVERY request, boot handshake included: an agent's
      // client connects as part of its own startup and makes no tool call
      // unprompted, so the handshake is the signal the dormant mail wake waits
      // for before starting the turn that reads the mail (mcp-activity.js).
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
