import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MCP_SERVER_NAME, MCP_TOKEN_ENV, mcpUrl,
  claudeMcpConfigArg, codexMcpConfigArgs, allowedToolName, allowedToolsArg, CHECKLIST_TOOLS,
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

// Same two-place registration rule as read_mail/list_mail above, for the four
// per-session checklist tools. `checklist: true` is passed explicitly so this
// asserts the grant itself rather than whatever the developer's own config.json
// happens to say.
test('allowedToolsArg grants the four checklist tools — the two-place registration pair', async () => {
  const { TOOLS } = await import('./tools/index.js');
  const names = allowedToolsArg({ checklist: true }).split(',');
  assert.equal(CHECKLIST_TOOLS.length, 4);
  for (const toolName of CHECKLIST_TOOLS) {
    assert.ok(TOOLS.some((t) => t.name === toolName), `${toolName} must be registered in tools/index.js TOOLS`);
    assert.ok(names.includes(allowedToolName(toolName)), `${toolName} must be allow-listed in client-config.js ALLOWED_TOOLS`);
  }
});

// `checklistEnabled: false` must leave a launch with no grant for these tools at
// all — a tool an agent can never get a permission prompt answered for is worse
// than one that isn't there.
test('allowedToolsArg drops ONLY the checklist tools when the feature is off', () => {
  const on = allowedToolsArg({ checklist: true }).split(',');
  const off = allowedToolsArg({ checklist: false }).split(',');
  for (const toolName of CHECKLIST_TOOLS) assert.ok(!off.includes(allowedToolName(toolName)));
  assert.deepEqual(off, on.filter((n) => !CHECKLIST_TOOLS.map(allowedToolName).includes(n)));
  // Every other always-on tool survives — a bad filter here would silently
  // un-grant the mailbox or spawn tools.
  for (const toolName of ['list_sessions', 'spawn_session', 'send_message', 'read_mail']) {
    assert.ok(off.includes(allowedToolName(toolName)));
  }
});
