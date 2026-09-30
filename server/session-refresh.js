import { lastActiveAt } from './session-manager.js';

export const REFRESH_MIN_IDLE_MS = 10 * 60 * 1000;

export function isOnOlderCode(session, codeVersion) {
  return Boolean(session?.tmux && codeVersion && session.launchedCodeVersion && session.launchedCodeVersion !== codeVersion);
}

// At most one per call: a relaunch re-reads the whole conversation, so refreshing
// the board in one burst would be a burst of prompt-cache rewrites too.
export function nextSessionToRefresh(sessions, { codeVersion, attached = new Set(), isResuming = () => false, entryFor = () => null, now, minIdleMs = REFRESH_MIN_IDLE_MS }) {
  return sessions.find((s) => {
    if (!isOnOlderCode(s, codeVersion)) return false;
    if (!s.lastActivity || s.status !== 'idle' || s.hasBackgroundShell || s.snooze || attached.has(s.tmux) || isResuming(s.sessionId)) return false;
    const entry = entryFor(s.sessionId);
    const since = lastActiveAt({ lastActivity: s.lastActivity, relaunchedAt: entry?.relaunchedAt, createdAt: entry?.createdAt });
    return since != null && now - since >= minIdleMs;
  }) || null;
}
