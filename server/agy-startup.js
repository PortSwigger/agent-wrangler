import crypto from 'node:crypto';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { INSTALL_ROOT } from './install-root.js';
const exec = promisify(execFile);
const nativeClients = new Map();
export const AGY_MCP_SERVER = 'agent-wrangler_agent-wrangler';
export const AGY_STARTUP_PROBE = `Agent Wrangler startup check only. Discover the native MCP server ${AGY_MCP_SERVER} and call get_session_info with empty arguments through call_mcp_tool. Do not name the card, read mail, run the task, use shell commands, inspect configuration, or build an HTTP/Node bridge. If native tools are unavailable, stop and report that integration is unavailable. After the native read, stop; Wrangler will deliver the task separately.`;
export const AGY_STARTUP_FAILURE = 'Antigravity native Wrangler tools are unavailable. Task and mail are retained. Complete sign-in, inspect the native /mcp manager, then retry native get_session_info. Resume is available once a root identity is bound. Do not use shell repair commands.';
export function createAgyStartup(previous) {
  nativeClients.delete(previous?.launchId);
  return { launchId: crypto.randomUUID(), probeSent: false, forkSent: false };
}
export function agyNativeReady(entry, alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } }) {
  const client = nativeClients.get(entry?.agyStartup?.launchId);
  return Boolean(client?.ready && alive(client.pid));
}
async function processInfo(pid) {
  const { stdout } = await exec('ps', ['-p', String(pid), '-o', 'ppid=', '-o', 'command='], { timeout: 1000 });
  const match = stdout.trim().match(/^(\d+)\s+(.+)$/);
  return match ? { parentPid: Number(match[1]), command: match[2] } : null;
}
export async function acceptAgyNative(payload, { map, rootPid, inspect = processInfo }) {
  const entry = map.get(payload.cardId);
  const launchId = entry?.agyStartup?.launchId;
  if (entry?.agent !== 'agy' || !launchId || payload.launchId !== launchId || !Number.isSafeInteger(payload.pid) || payload.pid <= 0 || !/^[a-zA-Z0-9-]{1,64}$/.test(payload.connectionId || '')) return false;
  const previous = nativeClients.get(launchId);
  if (payload.state === 'disconnected') {
    if (previous?.connectionId !== payload.connectionId || previous.pid !== payload.pid) return false;
    nativeClients.delete(launchId);
    return true;
  }
  if (payload.state !== 'ready') return false;
  try {
    const info = await inspect(payload.pid);
    if (info?.command !== `${process.execPath} ${path.join(INSTALL_ROOT, 'server/agy-mcp-entry.js')}`) return false;
    const root = Number(await rootPid(entry));
    if (!root) return false;
    if (info.parentPid !== root) {
      const parent = await inspect(info.parentPid);
      if (parent?.parentPid !== root || !/^(?:\S*\/)?(?:language_server(?:_[a-zA-Z0-9]+)*|antigravity)(?:\s|$)/.test(parent.command)) return false;
    }
    if (map.get(payload.cardId)?.agyStartup?.launchId !== launchId) return false;
    nativeClients.set(launchId, { connectionId: payload.connectionId, pid: payload.pid, ready: true });
    return true;
  } catch { return false; }
}
