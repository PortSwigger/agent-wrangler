import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadExtensions, BUILTIN } from '../extensions/index.js';

// No extension contributes a tool today; pinned rather than inherited so these
// assert the core grant itself.
const NO_EXT = { allowedToolNames: [] };
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

test('allowedToolsArg grants the rename_session tool (no per-call prompt)', () => {
  assert.ok(allowedToolsArg().split(',').includes(allowedToolName('rename_session')));
});

test('allowedToolsArg grants the get_session_info self-lookup tool (no per-call prompt)', () => {
  assert.ok(allowedToolsArg().split(',').includes(allowedToolName('get_session_info')));
});

test('allowedToolsArg grants the get_session_cost self-lookup tool (no per-call prompt)', () => {
  assert.ok(allowedToolsArg().split(',').includes(allowedToolName('get_session_cost')));
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
// a manifest that adds a tool has granted it in the same edit. A fake stands in
// for a manifest here; the real checklist manifest is covered beside it.
test('allowedToolsArg grants every enabled extension tool, derived from the loader', () => {
  const ext = { allowedToolNames: ['do_a_thing', 'do_another'] };
  const names = allowedToolsArg({ ext }).split(',');
  for (const n of ext.allowedToolNames) {
    assert.ok(names.includes(allowedToolName(n)), `${n} must be granted by allowedToolsArg`);
  }
  // And a disabled extension (the loader hands back no names) grants none of
  // them, leaving the core list exactly as it was.
  assert.deepEqual(allowedToolsArg({ ext: NO_EXT }).split(','), names.filter((n) => !ext.allowedToolNames.map(allowedToolName).includes(n)));
  // Every builtin switched off contributes no grant at all (the checklist's four
  // tools are granted by the loader, only while it is enabled).
  const allOff = loadExtensions({ cfg: { extensions: Object.fromEntries(BUILTIN.map((b) => [b.id, false])) }, builtin: BUILTIN });
  assert.deepEqual(allowedToolsArg({ ext: allOff }), allowedToolsArg({ ext: NO_EXT }));
  const enabled = allowedToolsArg({ ext: loadExtensions({ cfg: {}, builtin: BUILTIN }) }).split(',');
  assert.ok(enabled.includes(allowedToolName('adversarial_review_process')), 'the adversarial-review builtin\'s tool is granted');
});
