import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DATA_DIR } from './data-dir.js';
import { manageAgyIntegration } from './config-store.js';
const exec = promisify(execFile);
const VERSION = '5';
let state = { ready: false, error: null };
let pending = Promise.resolve();
export function agyIntegrationReady() { return manageAgyIntegration() && state.ready; }
export function agyIntegrationState() { return state; }
const wrapper = `#!/bin/sh
[ -n "\${AW_SESSION_ID:-}" ] || exit 0
[ -n "\${AW_INSTALL_ROOT:-}" ] && [ -x "\${AW_NODE:-}" ] || exit 0
case "$1" in
  hook) file=agy-hook-entry.js ;;
  mcp) file=agy-mcp-entry.js ;;
  *) exit 0 ;;
esac
[ -f "$AW_INSTALL_ROOT/server/$file" ] || exit 0
shift
exec "$AW_NODE" "$AW_INSTALL_ROOT/server/$file" "$@"
`;
export function pluginFiles(root = '${pluginRoot}') {
  const script = `${root}/bridge.sh`;
  const quoted = "'" + script.replaceAll("'", "'\"'\"'") + "'";
  const events = ['SessionStart', 'PreInvocation', 'PostInvocation', 'PreToolUse', 'PostToolUse', 'Stop'];
  return {
    'plugin.json': JSON.stringify({ name: 'agent-wrangler', version: '0.1.0', description: 'Identity-scoped Agent Wrangler integration' }, null, 2),
    'hooks.json': JSON.stringify({ 'agent-wrangler': Object.fromEntries(events.map((event) => {
      const hook = { type: 'command', command: `/bin/sh ${quoted} hook ${event}`, timeout: 2 };
      return [event, ['PreToolUse', 'PostToolUse'].includes(event) ? [{ matcher: '*', hooks: [hook] }] : [hook]];
    })) }, null, 2),
    'mcp_config.json': JSON.stringify({ mcpServers: { 'agent-wrangler': { command: '/bin/sh', args: [script, 'mcp'] } } }, null, 2),
    'bridge.sh': wrapper,
    '.aw-version': VERSION,
  };
}
async function availableOnPath() {
  try { return Boolean((await exec('sh', ['-c', 'command -v agy'], { timeout: 1000 })).stdout.trim()); } catch { return false; }
}
export function syncAgyPlugin(options = {}) {
  const next = pending.then(() => synchronize(options));
  pending = next.catch(() => {});
  return next;
}
async function synchronize({ enabled = manageAgyIntegration(), home = os.homedir(), available = availableOnPath, execImpl = exec } = {}) {
  const dir = path.join(home, '.gemini', 'config', 'plugins', 'agent-wrangler');
  state = { ready: false, error: null };
  try {
    if (!enabled) {
      if (fs.existsSync(path.join(dir, '.aw-version'))) {
        if (await available()) { try { await execImpl('agy', ['plugin', 'uninstall', 'agent-wrangler'], { env: { ...process.env, HOME: home }, timeout: 10000, maxBuffer: 65536 }); } catch {} }
        await fsp.rm(dir, { recursive: true, force: true });
      }
      return state;
    }
    let stamp; try { stamp = await fsp.readFile(path.join(dir, '.aw-version'), 'utf8'); } catch {}
    if (stamp !== VERSION) {
      if (!(await available())) return state;
      if (fs.existsSync(dir) && !fs.existsSync(path.join(dir, '.aw-version'))) throw new Error('An unowned agent-wrangler plugin already exists.');
      const staging = path.join(DATA_DIR, 'agy-plugin-source');
      await fsp.rm(staging, { recursive: true, force: true });
      await fsp.mkdir(staging, { recursive: true });
      for (const [name, body] of Object.entries(pluginFiles(dir))) { await fsp.writeFile(path.join(staging, name), body, { mode: name.endsWith('.sh') ? 0o755 : 0o600 }); }
      const opts = { env: { ...process.env, HOME: home }, timeout: 10000, maxBuffer: 65536 };
      await execImpl('agy', ['plugin', 'validate', staging], opts);
      await execImpl('agy', ['plugin', 'install', staging], opts);
      if (!fs.existsSync(dir)) throw new Error('Antigravity did not create the managed plugin directory.');
      await fsp.writeFile(path.join(dir, '.aw-version'), VERSION, { mode: 0o600 });
    }
    state = { ready: true, error: null };
  } catch (err) { state = { ready: false, error: err.cmd ? 'Antigravity plugin validation or installation failed. Inspect agy locally.' : err.message }; }
  return state;
}
