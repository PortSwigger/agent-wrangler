import { classify } from '../tmux-scraper.js';
import { readTurnRecord } from '../codex-turns.js';
import { readTurnMarks } from './codex-turn-marks.js';
import { findRollout } from './codex-rollout.js';

export const IN_FLIGHT_STALE_MS = 900000;

export function codexLiveStatus({ paneStatus, marks, turnEnd, now }) {
  if (paneStatus !== 'idle' && paneStatus !== 'unknown') return paneStatus;
  const ends = [turnEnd?.endedAt, marks.completedAt, marks.abortedAt].filter(Number.isFinite);
  const lastEnd = ends.length ? Math.max(...ends) : null;
  const inFlight = Number.isFinite(marks.startedAt)
    && (lastEnd == null || marks.startedAt > lastEnd)
    && Number.isFinite(marks.mtimeMs)
    && now - marks.mtimeMs < IN_FLIGHT_STALE_MS;
  if (inFlight) return 'working';
  if (paneStatus === 'idle') return 'idle';
  return Number.isFinite(marks.startedAt) && lastEnd != null && lastEnd >= marks.startedAt ? 'idle' : 'unknown';
}

export async function codexStatus({ liveSid, paneText, now = Date.now(), dataDir, sessionsDir }) {
  const pane = paneText === '' ? { status: 'unknown' } : classify(paneText);
  const turnEnd = liveSid ? readTurnRecord(liveSid, dataDir) : null;
  const rollout = liveSid ? await findRollout(liveSid, sessionsDir) : null;
  const marks = await readTurnMarks(rollout);
  const status = codexLiveStatus({ paneStatus: pane.status, marks, turnEnd, now });
  return { status, waitingFor: pane.waitingFor || null };
}
