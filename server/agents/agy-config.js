import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installPath } from '../install-root.js';
import { MCP_SERVER_NAME, allowedToolsArg } from '../mcp/client-config.js';
import { BOARD_ROOT } from './agy-db.js';

// agy 1.5.13 takes no MCP servers or hooks on its command line: `--settings`
// rejects both keys, and its MCP headers do not expand environment variables.
// It does load the plugins in the `.agents/plugins/` folder of every workspace
// it opens, so each board launch adds one board-owned folder (BOARD_ROOT) with
// `--add-dir`. Its plugin carries:
//   - the board's MCP server, through a stdio bridge (agy-mcp-bridge.js) that
//     reads the URL and the session token from the launch's environment;
//   - a SessionStart hook (agy-hook.js) that records which conversation the
//     launch is on and hands agy the launch's instructions;
// One folder serves every session, and nothing in ~/.gemini is written. The
// plugin is inert outside a board launch: nothing else opens the folder.

export const PLUGIN_NAME = 'agent-wrangler';
export const BRIDGE_PATH = installPath(fileURLToPath(new URL('./agy-mcp-bridge.js', import.meta.url)));
export const HOOK_PATH = installPath(fileURLToPath(new URL('./agy-hook.js', import.meta.url)));

const quote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const node = (script, ...args) => [process.execPath, script, ...args].map(quote).join(' ');

// The board tools a session may call without a prompt, by their bare names
// (agy.js grants each as `mcp(agent-wrangler/<tool>)` in the launch's settings).
export function allowedAgyTools({ ext } = {}) {
  const prefix = `mcp__${MCP_SERVER_NAME}__`;
  return allowedToolsArg(ext ? { ext } : undefined).split(',').filter((t) => t.startsWith(prefix)).map((t) => t.slice(prefix.length));
}

export function pluginFiles() {
  return {
    'plugin.json': { name: PLUGIN_NAME, author: 'Agent Wrangler' },
    'mcp_config.json': { mcpServers: { [MCP_SERVER_NAME]: { command: process.execPath, args: [BRIDGE_PATH] } } },
    'hooks.json': {
      [PLUGIN_NAME]: {
        SessionStart: [{ type: 'command', command: node(HOOK_PATH, 'SessionStart'), timeout: 10 }],
      },
    },
  };
}

function writeIfChanged(file, text) {
  try { if (fs.readFileSync(file, 'utf8') === text) return; } catch { /* absent */ }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

// Writes the board's plugin folder and returns the folder a launch adds.
// Called while building each launch, so it always names this install's node,
// bridge and hook.
export function ensureAgyRoot({ root = BOARD_ROOT } = {}) {
  const dir = path.join(root, '.agents', 'plugins', PLUGIN_NAME);
  for (const [name, body] of Object.entries(pluginFiles())) writeIfChanged(path.join(dir, name), `${JSON.stringify(body, null, 2)}\n`);
  return root;
}
