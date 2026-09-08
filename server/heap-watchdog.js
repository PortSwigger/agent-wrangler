// The fd-watchdog's sibling, for the other resource that has silently killed this
// service: heap. The OOM that motivated it (pid 58457, heap full at 4094 MB with
// Mark-Compact reclaiming nothing) arrived with no warning at all — nothing in the
// logs showed the climb, so the first evidence was a crash dump and sixteen launchd
// restarts. This gives advance notice instead.
//
// Same edge-triggered shape as fd-watchdog.js, for the same reason: a daemon that
// logs a number on a schedule is a daemon nobody reads. The graph rebuild is on a
// ~4 s interval and the mail sweep every 2 s, so anything sampling on those
// cadences would emit tens of thousands of lines a day and bury the one line that
// matters. This warns ONCE per threshold crossed on the way up, never while sitting
// at a level, and says nothing at all in the normal case.
//
// Measured against `heap_size_limit` rather than a fixed byte count: the limit is
// what the process actually dies at (~4.5 GB here, but it varies with machine RAM
// and any --max-old-space-size), so a percentage stays meaningful wherever this runs.

import v8 from 'node:v8';
import { logWarn } from './log.js';

const DEFAULT_LEVELS = [50, 75, 90];
const DEFAULT_INTERVAL_MS = 60000;

// Pure: current heap use as a percentage of the limit the process will die at,
// plus the raw figures for the message. Returns null when v8 gives us nothing
// usable — callers must treat that as "can't tell", never as "healthy".
export function heapUsage(getStats = () => v8.getHeapStatistics()) {
  try {
    const s = getStats();
    const limit = s?.heap_size_limit;
    const used = s?.used_heap_size;
    if (!limit || used == null) return null;
    return { used, limit, pct: (used / limit) * 100 };
  } catch {
    return null;
  }
}

// Pure decision: the highest configured level this reading has crossed and we
// haven't already warned about, or null to stay quiet. Levels are absolute
// percentages rather than fd-watchdog's fixed step because the interesting
// thresholds here aren't evenly spaced — 90% is an emergency, 50% is a note.
export function heapWatchdogDecision({ pct, levels = DEFAULT_LEVELS, lastWarnedAt = 0 }) {
  if (pct == null) return null;
  const crossed = levels.filter((l) => pct >= l);
  if (!crossed.length) return null;
  const level = Math.max(...crossed);
  return level > lastWarnedAt ? level : null;
}

// Wires the poll loop. unref'd like every other background interval in index.js so
// it never keeps the process alive on its own. `onAlert`/`onClear` mirror
// startFdWatchdog so the caller can push the state to the dashboard without this
// module knowing about WebSockets — a console line alone goes unread on a
// background daemon (see CLAUDE.md). The warning names the known offender so the
// reader gets a lead rather than just a number, exactly as the fd one does.
export function startHeapWatchdog({
  intervalMs = DEFAULT_INTERVAL_MS,
  levels = DEFAULT_LEVELS,
  onAlert = () => {},
  onClear = () => {},
  getStats,
} = {}) {
  const lowest = Math.min(...levels);
  let lastWarnedAt = 0;
  const timer = setInterval(() => {
    const u = heapUsage(getStats);
    if (!u) return;
    // Dropping back under the lowest level re-arms every threshold, so a heap that
    // climbs, is reclaimed, and climbs again warns on the second climb too.
    if (u.pct < lowest) {
      if (lastWarnedAt > 0) onClear();
      lastWarnedAt = 0;
      return;
    }
    const level = heapWatchdogDecision({ pct: u.pct, levels, lastWarnedAt });
    if (level == null) return;
    lastWarnedAt = level;
    const mb = (n) => Math.round(n / 1024 / 1024);
    logWarn(`[heap-watchdog] heap ${mb(u.used)}MB of ${mb(u.limit)}MB (${u.pct.toFixed(0)}%) has crossed ${level}% — possible leak (past offender: a WebSocket client that stopped reading, queueing every graph broadcast in memory; check process.memoryUsage().arrayBuffers)`);
    onAlert({ level, pct: u.pct, used: u.used, limit: u.limit });
  }, intervalMs);
  timer.unref();
  return timer;
}
