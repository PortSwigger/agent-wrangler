import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { MCP_SERVER_NAME } from './client-config.js';
import { TOOLS } from './tools/index.js';

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
// callback param.
export function buildMcpServer(deps, caller) {
  const server = new McpServer({ name: MCP_SERVER_NAME, version: '0.1.0' });
  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.inputSchema },
      (args) => tool.handler({ deps, caller }, args),
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
      console.error('[mcp]', err);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: 'internal error' }, id: null }));
      }
    }
  };
}
