import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadExtensions, BUILTIN } from '../extensions/index.js';
import {
  MCP_SERVER_NAME, MCP_TOKEN_ENV, mcpUrl,
  claudeMcpConfigArg, codexMcpConfigArgs, allowedToolName, allowedToolsArg,
} from './client-config.js';

test('mcpUrl points at the loopback /mcp on the given port', () => {
  assert.equal(mcpUrl(7777), 'http://127.0.0.1:7777/mcp');
});

test('claudeMcpConfigArg embeds the card id as the X-AW-Session header', () => {
  const json = JSON.parse(claudeMcpConfigArg('CARD9', 7777));
  const entry = json.mcpServers[MCP_SERVER_NAME];
  assert.equal(entry.type, 'http');
  assert.equal(entry.url, 'http://127.0.0.1:7777/mcp');
  assert.equal(entry.headers['X-AW-Session'], 'CARD9');
});

test('codexMcpConfigArgs declares the http server and bearer-token env var', () => {
  const args = codexMcpConfigArgs(7777);
  assert.deepEqual(args, [
    '-c', `mcp_servers.${MCP_SERVER_NAME}.url="http://127.0.0.1:7777/mcp"`,
    '-c', `mcp_servers.${MCP_SERVER_NAME}.bearer_token_env_var="${MCP_TOKEN_ENV}"`,
    '-c', `mcp_servers.${MCP_SERVER_NAME}.default_tools_approval_mode="approve"`,
  ]);
});

test('allowedToolName matches the MCP tool prefix convention', () => {
  assert.equal(allowedToolName('list_sessions'), `mcp__${MCP_SERVER_NAME}__list_sessions`);
});

test('allowedToolsArg grants both list_sessions and the write-capable spawn_session', () => {
  const arg = allowedToolsArg();
  const names = arg.split(',');
  assert.ok(names.includes(allowedToolName('list_sessions')));
  assert.ok(names.includes(allowedToolName('spawn_session')));
});

test('allowedToolsArg grants the read-only list_tasks tool (no per-call prompt)', () => {
  assert.ok(allowedToolsArg().split(',').includes(allowedToolName('list_tasks')));
});

test('allowedToolsArg grants the workflow_phase reporting tool (no per-call prompt)', () => {
  assert.ok(allowedToolsArg().split(',').includes(allowedToolName('workflow_phase')));
});

test('allowedToolsArg grants the name_branch tool (no per-call prompt)', () => {
  assert.ok(allowedToolsArg().split(',').includes(allowedToolName('name_branch')));
});

test('allowedToolsArg grants the cross-session coordination tools (no per-call prompt)', () => {
  const names = allowedToolsArg().split(',');
  assert.ok(names.includes(allowedToolName('send_message')));
  assert.ok(names.includes(allowedToolName('archive_session')));
});

test('allowedToolsArg grants the assign_session tool (no per-call prompt)', () => {
  assert.ok(allowedToolsArg().split(',').includes(allowedToolName('assign_session')));
});

test('allowedToolsArg grants the get_session_info self-lookup tool (no per-call prompt)', () => {
  assert.ok(allowedToolsArg().split(',').includes(allowedToolName('get_session_info')));
});

// The two-place registration is the silent-failure mode CLAUDE.md warns about:
// registering a tool in tools/index.js's TOOLS without also allow-listing it
// here ships something that passes every unit test and dies silently in a real
// launch (the agent never even gets a permission prompt to answer). Assert the
// pair explicitly for read_mail/list_mail rather than relying on someone
// remembering both files.
test('allowedToolsArg grants read_mail and list_mail (the mailbox tools) — the two-place registration pair', async () => {
  const { TOOLS } = await import('./tools/index.js');
  const names = allowedToolsArg().split(',');
  for (const toolName of ['read_mail', 'list_mail']) {
    assert.ok(TOOLS.some((t) => t.name === toolName), `${toolName} must be registered in tools/index.js TOOLS`);
    assert.ok(names.includes(allowedToolName(toolName)), `${toolName} must be allow-listed in client-config.js ALLOWED_TOOLS`);
  }
});

// Extension tools are the one place the two-place rule is DERIVED rather than
// hand-kept: allowedToolsArg grants exactly the names the loader registers, so
// a manifest that adds a tool has granted it in the same edit.
test('allowedToolsArg grants every enabled extension tool, derived from the loader', () => {
  const ext = loadExtensions({ cfg: {}, builtin: BUILTIN });
  assert.ok(ext.tools.length >= 4, 'the checklist extension contributes its four tools');
  const names = allowedToolsArg({ ext }).split(',');
  for (const t of ext.tools) {
    assert.ok(names.includes(allowedToolName(t.name)), `${t.name} must be granted by allowedToolsArg`);
  }
});

// A disabled extension must leave a launch with no grant for its tools at all —
// a tool an agent can never get a permission prompt answered for is worse than
// one that isn't there. With no extension tools the arg IS the core list.
test('allowedToolsArg with no extension tools equals the core list, and drops ONLY the extension tools', () => {
  const on = allowedToolsArg({ ext: loadExtensions({ cfg: {}, builtin: BUILTIN }) }).split(',');
  const off = allowedToolsArg({ ext: { allowedToolNames: [] } }).split(',');
  const extNames = loadExtensions({ cfg: {}, builtin: BUILTIN }).allowedToolNames.map(allowedToolName);
  assert.deepEqual(off, on.filter((n) => !extNames.includes(n)));
  assert.deepEqual(allowedToolsArg({ ext: loadExtensions({ cfg: { extensions: { checklist: false } } }) }).split(','), off);
  // Every core always-on tool survives — a bad filter here would silently
  // un-grant the mailbox or spawn tools.
  for (const toolName of ['list_sessions', 'spawn_session', 'send_message', 'read_mail']) {
    assert.ok(off.includes(allowedToolName(toolName)));
  }
});
