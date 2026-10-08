import { mcpSeenAt as defaultMcpSeenAt } from './mcp-activity.js';
import fs from 'node:fs';
import os from 'node:os';
import { resolveResumeDir } from './transcript-reader.js';

// Deliver mail to a live session. A dormant recipient keeps its mail unread
// until it is resumed by a human or another workflow, unless `wakesDormant()`
// is true: then it is resumed bare and the notification follows through the
// gated live path on the next sweep, so it never pastes into a booting pane or
// over a draft.
export async function deliverMailNotification(to, text, deps) {
  const { tmuxFor, socketFor, sessionManager, paneDeferral } = deps;
  const mcpSeenAt = deps.mcpSeenAt ?? defaultMcpSeenAt;
  const mcpReadyTimeoutMs = deps.mcpReadyTimeoutMs ?? MCP_READY_TIMEOUT_MS;
  const mcpReadyPollMs = deps.mcpReadyPollMs ?? MCP_READY_POLL_MS;
  const entry = sessionManager.entryFor(to);
  if (!entry || entry.archivedAt) return { mode: 'skip' };

  const target = tmuxFor(to);
  if (!target) {
    if (!deps.wakesDormant?.()) return { mode: 'deferred', reason: 'no tmux target' };
    return wakeDormant(to, entry, deps);
  }

  const beforeSend = async () => {
    const relaunchedAt = entry.relaunchedAt;
    const relaunchAge = Date.now() - relaunchedAt;
    if (typeof relaunchedAt === 'number' && relaunchAge >= 0 && relaunchAge <= mcpReadyTimeoutMs
      && mcpSeenAt(to) <= relaunchedAt) {
      await waitForMcpReady(to, relaunchedAt, mcpSeenAt, mcpReadyTimeoutMs, mcpReadyPollMs);
    }
  };
  let reason = null;
  const onDefer = (r) => { reason = r; };
  const delivery = await liveTransport(to, target, text, socketFor(to), paneDeferral, beforeSend, onDefer);
  return delivery === 'deferred' ? { mode: 'deferred', reason } : { mode: 'live' };
}

async function wakeDormant(to, entry, deps) {
  const { sessionManager } = deps;
  let dir = await resolveResumeDir(entry.liveSessionId || to, { entryCwd: entry.cwd });
  if (!dir || !fs.existsSync(dir)) {
    try { fs.mkdirSync(dir, { recursive: true }); } catch { dir = os.homedir(); }
  }
  const fresh = sessionManager.entryFor(to);
  if (!fresh || fresh.archivedAt) return { mode: 'skip' };
  await sessionManager.resume(to, dir, { reason: 'mail' });
  return { mode: 'deferred', reason: 'woken dormant session, delivering next sweep' };
}

// Today's only live transport: paste into the pane, gated by paneDeferral so it
// can never land in the middle of a half-typed prompt. The swap point for a live
// Claude session to instead use Claude Code's SendMessage socket (deferred past
// Phase 1 — see the spec's "Claude Code cross-session messaging" section); that
// swap would make the gate unnecessary for Claude, since a socket message does
// not go through the composer at all.
function liveTransport(id, tmux, text, socket, paneDeferral, beforeSend, onDefer) {
  return paneDeferral.deliverOrDefer({
    id, text, tmux, socket, deferWhileWorking: true, queueOnDefer: false, beforeSend, onDefer,
  });
}

const MCP_READY_TIMEOUT_MS = 15000;
const MCP_READY_POLL_MS = 250;

// Wait for a recently resumed live process to report its MCP connection rather
// than accepting a stale timestamp from the previous process.
async function waitForMcpReady(cardId, since, mcpSeenAt, timeoutMs, pollMs) {
  const deadline = Date.now() + timeoutMs;
  do {
    if (mcpSeenAt(cardId) > since) return true;
    await new Promise((r) => setTimeout(r, pollMs));
  } while (Date.now() < deadline);
  return false;
}
