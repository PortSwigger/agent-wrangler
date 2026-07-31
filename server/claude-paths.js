import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const CLAUDE_DIR = path.join(os.homedir(), '.claude');
export const SESSIONS_DIR = path.join(CLAUDE_DIR, 'sessions');

export function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export function statusOf(raw) {
  switch (raw) {
    case 'waiting': return 'needs-you';
    case 'busy': return 'working';
    // Claude reports 'shell' while a Bash tool is executing (a foreground command,
    // loop, build, test, etc.). It IS busy — map to working so the board shows it
    // live AND, crucially, so the idle-only suspend gate never tears down a session
    // mid-command (the command's process tree would die with the tmux).
    case 'shell': return 'working';
    case 'idle': return 'idle';
    default: return 'unknown';
  }
}

// Decide a live session's board status from the raw value Claude wrote to its
// session file, telling the caller to pane-scrape ONLY when nothing was reported.
// A recognized value maps directly; a reported-but-unrecognized value (a NEW Claude
// status we don't map yet) becomes 'unknown' so it shows in the UI as '?' and is
// never mistaken for idle (so the suspend reconcile can't reap it); an absent/blank
// value means we have no signal at all → 'scrape' (the caller pane-scrapes, e.g. for
// Codex, which writes no status file). This is the policy that makes a future new
// status safe-by-default and visible, instead of being silently scraped into idle.
export function liveStatusDecision(rawStatus) {
  const mapped = statusOf(rawStatus);
  if (mapped !== 'unknown') return mapped;
  if (typeof rawStatus === 'string' && rawStatus.trim() !== '') return 'unknown';
  return 'scrape';
}

// Live state of the Claude running in an owned tmux, from the pane process's
// per-pid session file (post-fork id, hook status, dispatch name). Null when
// absent/unreadable so callers fall back to scraping.
export function liveState(claudePid, sessionsDir = SESSIONS_DIR) {
  const data = readJsonSafe(path.join(sessionsDir, `${claudePid}.json`));
  if (!data || !data.sessionId) return null;
  return {
    liveSid: data.sessionId,
    status: statusOf(data.status),
    rawStatus: data.status ?? null, // the unmapped value, so callers can tell a
    // reported-but-unrecognized status from a genuinely absent one (scrape vs show).
    waitingFor: data.waitingFor || null,
    name: data.name || null,
    updatedAt: data.updatedAt || null,
  };
}
