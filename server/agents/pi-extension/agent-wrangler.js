// Agent Wrangler's pi extension, loaded into every pi session the wrangler
// launches (`pi -e <this file>`; see server/agents/pi.js). It gives the session
// the wrangler's MCP tools (rename_session, read_mail, spawn_session, …).
//
// Why an extension and not pi's MCP config: a launch must not write the user's
// ~/.pi/agent/mcp.json, and pi's built-in MCP support may not be running at all
// — a user can turn it off (`"extensions": ["-builtin:mcp"]`) in favour of an
// MCP-adapter extension that ignores servers other extensions register. So this
// talks to the wrangler's MCP endpoint itself and registers each tool as an
// ordinary pi tool, which works the same with built-in MCP on, off, or replaced.
//
// The endpoint is the wrangler's stateless streamable-HTTP server (one JSON
// response per POST, no MCP session to hold), so a bare fetch per call is a
// complete client. Runs inside pi's process: no imports, nothing started at
// load beyond the one tools/list request pi awaits before startup continues.

const SERVER = 'agent-wrangler';
const LIST_TIMEOUT_MS = 5000;

// Pi's own MCP naming (`mcp__<server>__<tool>`, every character outside
// [A-Za-z0-9_] replaced by `_`), so the tools read the same as they would had
// pi connected the server itself.
export function toolNameFor(name) {
  return `mcp__${SERVER}__${name}`.replace(/[^A-Za-z0-9_]/g, '_');
}

// An MCP tool's inputSchema as a pi parameter schema. Pi validates with JSON
// Schema (TypeBox schemas are JSON Schema), so the object passes through bar the
// two keys a provider's tool declaration rejects.
export function toParameters(schema) {
  const s = schema && typeof schema === 'object' && !Array.isArray(schema) ? schema : { type: 'object', properties: {} };
  const { $schema, additionalProperties, ...rest } = s;
  return rest;
}

// An MCP CallToolResult's content as pi tool-result content: text stays text,
// anything else (an image, a resource) is passed along as its JSON.
export function toContent(result) {
  const blocks = Array.isArray(result?.content) ? result.content : [];
  const content = blocks.map((b) => (b?.type === 'text' ? { type: 'text', text: String(b.text ?? '') } : { type: 'text', text: JSON.stringify(b) }));
  return content.length ? content : [{ type: 'text', text: '(no output)' }];
}

// A JSON-RPC response body, whether the server answered as JSON or as one SSE
// `data:` event (the transport may do either; ours sends JSON).
export function parseRpcBody(text, contentType = '') {
  if (/text\/event-stream/.test(contentType)) {
    const data = String(text).split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).filter(Boolean).pop();
    return data ? JSON.parse(data) : null;
  }
  return text ? JSON.parse(text) : null;
}

export function createClient({ url, sessionId, fetchImpl = globalThis.fetch }) {
  let nextId = 1;
  return async function rpc(method, params, { signal } = {}) {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        // The caller's card id, as the Claude launch sends it (server/mcp/server.js extractCaller).
        'x-aw-session': sessionId,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params: params || {} }),
      signal,
    });
    const body = parseRpcBody(await res.text(), res.headers.get('content-type') || '');
    if (!res.ok || body?.error) throw new Error(body?.error?.message || `${SERVER} MCP ${method} failed: HTTP ${res.status}`);
    return body?.result;
  };
}

export default async function agentWrangler(pi, { env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const url = env.AW_MCP_URL;
  const sessionId = env.AW_SESSION_ID;
  if (!url || !sessionId) return;
  const rpc = createClient({ url, sessionId, fetchImpl });
  let tools;
  try {
    tools = (await rpc('tools/list', {}, { signal: AbortSignal.timeout(LIST_TIMEOUT_MS) }))?.tools || [];
  } catch (err) {
    // The wrangler being down at launch costs this session its board tools, not
    // its startup: pi carries on without them.
    console.error(`[${SERVER}] could not list MCP tools: ${err?.message || err}`);
    return;
  }
  for (const tool of tools) {
    pi.registerTool({
      name: toolNameFor(tool.name),
      label: `${SERVER}: ${tool.name}`,
      description: tool.description || tool.name,
      parameters: toParameters(tool.inputSchema),
      async execute(_toolCallId, params, signal) {
        const result = await rpc('tools/call', { name: tool.name, arguments: params || {} }, { signal });
        const content = toContent(result);
        if (result?.isError) throw new Error(content.map((c) => c.text).join('\n'));
        return { content, details: undefined };
      },
    });
  }
}
