import { test } from 'node:test';
import assert from 'node:assert/strict';
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
