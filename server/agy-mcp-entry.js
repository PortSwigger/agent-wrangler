import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
export async function createAgyMcpBridge({ env = process.env, connect } = {}) {
  let client;
  if (env.AW_SESSION_ID) {
    try {
      if (connect) client = await connect();
      else {
        const port = Number(env.AW_PORT);
        if (!(port > 0 && port <= 65535)) throw new Error('invalid port');
        client = new Client({ name: 'agy-wrangler-bridge', version: '1' });
        await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { 'X-AW-Session': env.AW_SESSION_ID } } }), { timeout: 1000 });
      }
    } catch { client = null; }
  }
  return {
    async listTools() { try { return client ? await client.listTools() : { tools: [] }; } catch { return { tools: [] }; } },
    async callTool(params) { return client ? client.callTool(params) : { isError: true, content: [{ type: 'text', text: 'Wrangler integration unavailable.' }] }; },
    close: () => client?.close(),
  };
}
if (process.argv[1]?.endsWith('/agy-mcp-entry.js')) {
  const bridge = await createAgyMcpBridge();
  const server = new Server({ name: 'agent-wrangler', version: '1' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, () => bridge.listTools());
  server.setRequestHandler(CallToolRequestSchema, (req) => bridge.callTool(req.params));
  await server.connect(new StdioServerTransport());
  process.on('SIGTERM', () => { bridge.close(); server.close(); });
}
