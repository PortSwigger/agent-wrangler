import { serverPort } from '../runtime.js';

// Single source of truth for how a launched session's MCP client is pointed back
// at this server. Imports only serverPort, so the agents layer (a leaf) can use
// it without pulling in heavy modules.
export const MCP_SERVER_NAME = 'agent-wrangler';
export const MCP_TOKEN_ENV = 'AW_MCP_TOKEN';

export function mcpUrl(port = serverPort()) {
  return `http://127.0.0.1:${port}/mcp`;
}

// Where the launch-injected PostToolUse PR-attach hook (scripts/pr-attach-hook.mjs)
// POSTs a freshly created PR url back to. Same leaf so the agents layer can build
// the launch env without importing the server.
export function prAttachUrl(port = serverPort()) {
  return `http://127.0.0.1:${port}/pr-attach`;
}

// Claude carries the caller's card id as a custom header (supported by
// --mcp-config's per-server `headers`).
export function claudeMcpConfigArg(cardId, port = serverPort()) {
  return JSON.stringify({
    mcpServers: {
      [MCP_SERVER_NAME]: {
        type: 'http',
        url: mcpUrl(port),
        headers: { 'X-AW-Session': cardId },
      },
    },
  });
}

// Codex can't send a custom header; it sends the card id as a bearer token read
// from MCP_TOKEN_ENV (set per-launch in the env to the card id). Values are TOML
// strings (double-quoted) for the `-c key=value` channel.
export function codexMcpConfigArgs(port = serverPort()) {
  return [
    '-c', `mcp_servers.${MCP_SERVER_NAME}.url="${mcpUrl(port)}"`,
    '-c', `mcp_servers.${MCP_SERVER_NAME}.bearer_token_env_var="${MCP_TOKEN_ENV}"`,
    '-c', `mcp_servers.${MCP_SERVER_NAME}.default_tools_approval_mode="approve"`,
  ];
}

export function allowedToolName(tool) {
  return `mcp__${MCP_SERVER_NAME}__${tool}`;
}

// The wrangler MCP tools a launched session is granted without a per-call
// prompt. Lives here (the leaf the agents import) rather than in the tools
// registry, since that registry pulls in session-manager and would cycle back
// through the agents layer. Keep in sync when a new always-on tool is added.
const ALLOWED_TOOLS = ['list_sessions', 'get_session_info', 'list_tasks', 'spawn_session', 'get_links', 'set_links', 'workflow_phase', 'name_branch', 'send_message', 'archive_session', 'assign_session', 'read_mail', 'list_mail'];

export function allowedToolsArg() {
  return ALLOWED_TOOLS.map(allowedToolName).join(',');
}
