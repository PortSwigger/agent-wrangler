import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installPath } from '../install-root.js';
import { MCP_SERVER_NAME, SESSION_TOKEN_ENV, allowedToolsArg, mcpUrl } from '../mcp/client-config.js';
import { PR_HOOK_PATH, shellQuote } from './claude.js';
import { BOARD_GEMINI_HOME, userGeminiDir } from './gemini-files.js';

// Gemini CLI takes no settings, MCP config or hooks on its command line, and
// reads a system settings file only when root owns it. So the sessions the
// board launches run with GEMINI_CLI_HOME pointing at a Gemini home of the
// board's own (BOARD_GEMINI_HOME):
//   - settings.json is the user's own ~/.gemini/settings.json with ours merged
//     in (geminiSettings), rewritten at each launch;
//   - projects.json, tmp/ (the conversations) and the rest of Gemini's own
//     bookkeeping are the board's, so nothing it writes lands in ~/.gemini;
//   - everything else in ~/.gemini (credentials, extensions, skills, commands,
//     GEMINI.md, .env) is symlinked, so a session signs in and behaves as the
//     user's own Gemini does.
// The user's ~/.gemini is never written. One home serves every session: the
// session token reaches the MCP header through $AW_SESSION_TOKEN, which Gemini
// expands in settings values.

const CONTEXT_HOOK_PATH = installPath(fileURLToPath(new URL('./gemini-context-hook.js', import.meta.url)));
export const HEADLESS_POLICY_PATH = installPath(fileURLToPath(new URL('./gemini-headless-policy.toml', import.meta.url)));

// Entries of ~/.gemini the board's home keeps for itself rather than linking.
const OWN_ENTRIES = new Set(['settings.json', 'projects.json', 'projects.json.lock', 'tmp', 'history', 'state.json', 'trustedFolders.json', 'policy.toml']);

// Gemini allows comments in settings.json.
function readJsonc(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return {}; }
  for (const candidate of [text, text.replace(/("(?:\\.|[^"\\])*")|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m, str) => str ?? '')]) {
    try {
      const parsed = JSON.parse(candidate);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch { /* try the next form */ }
  }
  return {};
}

const node = (script) => `${shellQuote(process.execPath)} ${shellQuote(script)}`;

// The user's settings with what every board-launched Gemini session needs:
//   - the board's MCP server, the session token as its bearer;
//   - the PR-attach hook after each shell command (scripts/pr-attach-hook.mjs
//     scans the AfterTool payload's command and output as it does Claude's);
//   - a SessionStart hook that hands Gemini the launch's instructions
//     ($AW_GEMINI_CONTEXT: skills catalog, card naming, worktree guardrail);
//   - folder trust off: a launch already trusts its directory (`--skip-trust`),
//     and with trust on every `--include-directories` folder (task memory)
//     stops the session on a "trust these folders?" dialog. The board trusts
//     the folders it launches Claude and Codex in the same way.
// The user's own MCP servers and hooks stay beside ours.
export function geminiSettings({ port, base = {} } = {}) {
  const hooks = { ...(base.hooks || {}) };
  const add = (event, group) => { hooks[event] = [...(Array.isArray(hooks[event]) ? hooks[event] : []), group]; };
  add('SessionStart', { hooks: [{ type: 'command', name: 'agent-wrangler-context', command: node(CONTEXT_HOOK_PATH) }] });
  add('AfterTool', { matcher: 'run_shell_command', hooks: [{ type: 'command', name: 'agent-wrangler-pr-attach', command: node(PR_HOOK_PATH) }] });
  return {
    ...base,
    security: { ...(base.security || {}), folderTrust: { ...(base.security?.folderTrust || {}), enabled: false } },
    mcpServers: {
      ...(base.mcpServers || {}),
      [MCP_SERVER_NAME]: { httpUrl: mcpUrl(port), headers: { Authorization: `Bearer $${SESSION_TOKEN_ENV}` }, description: 'Agent Wrangler board' },
    },
    hooks,
  };
}

// A user-tier policy allowing the board's always-on MCP tools without a prompt,
// the counterpart of Claude's --allowedTools list.
export function geminiPolicy({ ext } = {}) {
  const prefix = `mcp__${MCP_SERVER_NAME}__`;
  const tools = allowedToolsArg(ext ? { ext } : undefined).split(',').filter((t) => t.startsWith(prefix)).map((t) => t.slice(prefix.length));
  // Fully qualified (mcp_<server>_<tool>): a bare name beside `mcpName` is also
  // checked against Gemini's built-in tools, and read_mail warns as a typo of read_file.
  return [
    '# Written by Agent Wrangler for the Gemini sessions it launches.',
    '[[rule]]',
    `toolName = [${tools.map((t) => JSON.stringify(`mcp_${MCP_SERVER_NAME}_${t}`)).join(', ')}]`,
    'decision = "allow"',
    'priority = 500',
    '',
  ].join('\n');
}

function writeIfChanged(file, text) {
  try { if (fs.readFileSync(file, 'utf8') === text) return; } catch { /* absent */ }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

// Links each shared entry of the user's Gemini dir into the board's, leaving an
// entry Gemini has since replaced with a file of its own (a refreshed sign-in).
function linkShared(userDir, ownDir) {
  let names = [];
  try { names = fs.readdirSync(userDir); } catch { return; }
  for (const name of names) {
    if (OWN_ENTRIES.has(name)) continue;
    const link = path.join(ownDir, name);
    try { fs.lstatSync(link); continue; } catch { /* absent: link it */ }
    try { fs.symlinkSync(path.join(userDir, name), link); } catch { /* raced another launch */ }
  }
}

// Prepares the board's Gemini home and returns what a launch names: the home
// (GEMINI_CLI_HOME) and the policy file. Called while building each launch,
// resume and fork command, so it always matches the running server's port,
// install and the user's current settings.
export function ensureGeminiHome({ home = BOARD_GEMINI_HOME, userDir = userGeminiDir(), port, ext } = {}) {
  const ownDir = path.join(home, '.gemini');
  fs.mkdirSync(ownDir, { recursive: true });
  linkShared(userDir, ownDir);
  // ~/.agents/skills is Gemini's other user skills folder, found under the home too.
  const agents = path.join(path.dirname(userDir), '.agents');
  try { if (fs.existsSync(agents) && !fs.existsSync(path.join(home, '.agents'))) fs.symlinkSync(agents, path.join(home, '.agents')); } catch { /* raced */ }
  writeIfChanged(path.join(ownDir, 'settings.json'), `${JSON.stringify(geminiSettings({ port, base: readJsonc(path.join(userDir, 'settings.json')) }), null, 2)}\n`);
  const policyPath = path.join(ownDir, 'policy.toml');
  writeIfChanged(policyPath, geminiPolicy({ ext }));
  return { home, policyPath };
}
