#!/usr/bin/env node
// A stdio MCP server agy starts for the board's plugin (agy-config.js). It
// relays each JSON-RPC message to the board's Streamable HTTP MCP endpoint
// ($AW_AGY_MCP_URL) with the session's token ($AW_SESSION_TOKEN) as its bearer,
// and writes every reply back as one line. agy's own MCP config cannot carry a
// per-session header (it does not expand variables), so the token stays in the
// environment and never touches disk.
import fs from 'node:fs';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';

const url = process.env.AW_AGY_MCP_URL;
const token = process.env.AW_SESSION_TOKEN;
let sessionId = null;
let protocolVersion = null;

const write = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);

function fail(msg, message) {
  if (msg && msg.id !== undefined && msg.method) write({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message } });
}

// The messages in an HTTP reply: a JSON body (one message or a batch) or an
// SSE stream of `data:` lines.
export function messagesOf(contentType, body) {
  if (/text\/event-stream/i.test(contentType || '')) {
    const out = [];
    for (const event of body.split(/\r?\n\r?\n/)) {
      const data = event.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
      if (!data) continue;
      try { out.push(JSON.parse(data)); } catch { /* keep-alive or partial */ }
    }
    return out;
  }
  if (!body.trim()) return [];
  const parsed = JSON.parse(body);
  return Array.isArray(parsed) ? parsed : [parsed];
}

// agy hands an MCP server's tools to the model "lazily" by default: a list of
// names in its system prompt and one `call_mcp_tool` function to reach them
// through, after reading each tool's schema from a file. Marked
// `antigravity/alwaysLoad`, each board tool is instead a function of its own
// (`mcp_agent-wrangler_agent-wrangler_<tool>`), as Claude and Codex get them,
// so the board's instructions that name a tool can be followed as written.
export function alwaysLoaded(reply) {
  const tools = reply?.result?.tools;
  if (!Array.isArray(tools)) return reply;
  return { ...reply, result: { ...reply.result, tools: tools.map((t) => ({ ...t, _meta: { ...t?._meta, 'antigravity/alwaysLoad': true } })) } };
}

async function relay(line) {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (!url || !token) { fail(msg, 'Agent Wrangler MCP is only available in a session the board launched.'); return; }
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${token}` };
  if (sessionId) headers['mcp-session-id'] = sessionId;
  if (protocolVersion) headers['mcp-protocol-version'] = protocolVersion;
  try {
    const res = await fetch(url, { method: 'POST', headers, body: line });
    const sid = res.headers.get('mcp-session-id');
    if (sid) sessionId = sid;
    const body = await res.text();
    if (!res.ok && res.status !== 202) { fail(msg, `Agent Wrangler MCP returned HTTP ${res.status}`); return; }
    for (const reply of messagesOf(res.headers.get('content-type'), body)) {
      if (msg.method === 'initialize' && reply?.result?.protocolVersion) protocolVersion = reply.result.protocolVersion;
      write(msg.method === 'tools/list' ? alwaysLoaded(reply) : reply);
    }
  } catch (err) {
    fail(msg, `Agent Wrangler MCP is unreachable: ${err.message}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  let chain = Promise.resolve();
  // In order, so `initialize` settles the session id before anything else is sent.
  rl.on('line', (line) => { if (line.trim()) chain = chain.then(() => relay(line)); });
  rl.on('close', () => { chain.finally(() => process.exit(0)); });
}
