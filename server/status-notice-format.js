export const LAST_SAID_CHARS = 200;

export function clipLastSaid(text) {
  const line = String(text).replace(/\s+/g, ' ').trim();
  return line.length > LAST_SAID_CHARS ? line.slice(0, LAST_SAID_CHARS) + '…' : line;
}

export function formatIdleFor(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  const pad = (n) => String(n).padStart(2, '0');
  if (minutes >= 60) return `${Math.floor(minutes / 60)}h ${pad(minutes % 60)}m`;
  if (minutes) return `${minutes}m ${pad(seconds % 60)}s`;
  return `${seconds}s`;
}

export function composeStatusNotice(events, detail) {
  const lines = ['[Agent Wrangler] Status notice for sessions you spawned'];
  for (const event of events) {
    const { child, kind } = event;
    const info = detail.get(child.sessionId);
    let text;
    if (kind === 'idle') {
      text = `idle for ${formatIdleFor(event.idleMs)} with no report to you. Unread mail waiting for it: ${info?.unread ?? 0}.`;
      if (info?.lastSaid) text += ` Last said: "${info.lastSaid}"`;
    } else if (kind === 'needs-you') {
      text = child.waitingFor ? `needs you — ${child.waitingFor}` : 'needs you.';
    } else if (kind === 'exited') {
      text = event.exitReason === 'archived' ? 'archived.' : 'exited.';
      if (child.exitOutput) text += ` Last output: "${clipLastSaid(child.exitOutput)}"`;
    } else if (kind === 'quiet') {
      text = `still working but nothing written for ${formatIdleFor(event.quietMs)}; it may be stuck.`;
    }
    lines.push(`- ${child.label || child.sessionId.slice(0, 8)} (${child.sessionId.slice(0, 8)}): ${text}`);
  }
  lines.push('These are observations from the board, not messages from the sessions. A session that is idle may be finished, waiting for you, or have stopped early; read its transcript or send_message it before assuming.');
  return lines.join('\n');
}
