// Node self-raises its own open-fd soft limit to the hard limit at startup (verified
// empirically — it does not respect a lowered soft limit), so the old `ulimit -n 256`
// in wrangler-start.sh never worked as a canary the way its comment claimed: it was
// really just a shared hard cap, which meant a spawned MCP server needing a brief fd
// burst (chrome-devtools-mcp opens ~270 files concurrently at startup) died with
// EMFILE right alongside a genuinely leaking server. This watchdog is the real
// canary: it polls only *this* process's own fd count (children have a separate
// table — /dev/fd never includes them) and logs loudly once it climbs past a
// threshold and stays there, which is what a leak looks like (the chokidar
// per-file-watch and node-pty per-attach kqueue leaks described in CLAUDE.md) as
// opposed to a momentary legitimate burst.

import fs from 'node:fs';

const DEFAULT_THRESHOLD = 200;
const DEFAULT_STEP = 50;
const DEFAULT_INTERVAL_MS = 30000;

// Pure: this process's current open fd count, or null if /dev/fd isn't available
// (some non-macOS/Linux environments) — callers must treat null as "can't tell".
export function countOpenFds(readdirSync = fs.readdirSync) {
  try {
    return readdirSync('/dev/fd').length;
  } catch {
    return null;
  }
}

// Pure decision: given the current count, should we warn now? Edge-triggered on
// crossing `threshold`, then re-fires every further `step` fds so sustained growth
// keeps escalating instead of going silent after the first warning. Returns the
// crossed level (for the log message) or null to stay quiet. `lastWarnedAt` is the
// highest level already warned about since the count last dropped below threshold.
export function fdWatchdogDecision({ count, threshold = DEFAULT_THRESHOLD, step = DEFAULT_STEP, lastWarnedAt = 0 }) {
  if (count == null || count < threshold) return null;
  const level = threshold + Math.floor((count - threshold) / step) * step;
  return level > lastWarnedAt ? level : null;
}

// Wires the poll loop. unref'd like the other background intervals in index.js so
// it never keeps the process alive on its own. `onAlert`/`onClear` let the caller
// push the state to the dashboard (a console line alone goes unread on a
// background daemon — see CLAUDE.md) without this module knowing about
// WebSockets; `onAlert` fires on every new level crossed while climbing, `onClear`
// fires once when the count drops back under `threshold`.
export function startFdWatchdog({
  intervalMs = DEFAULT_INTERVAL_MS,
  threshold = DEFAULT_THRESHOLD,
  step = DEFAULT_STEP,
  onAlert = () => {},
  onClear = () => {},
} = {}) {
  let lastWarnedAt = 0;
  const timer = setInterval(() => {
    const count = countOpenFds();
    if (count != null && count < threshold) {
      if (lastWarnedAt > 0) onClear();
      lastWarnedAt = 0;
      return;
    }
    const level = fdWatchdogDecision({ count, threshold, step, lastWarnedAt });
    if (level == null) return;
    lastWarnedAt = level;
    console.warn(`[fd-watchdog] open fd count ${count} has crossed ${level} — possible leak (see CLAUDE.md for past offenders: chokidar watch scope, node-pty attach teardown)`);
    onAlert({ count, level });
  }, intervalMs);
  timer.unref();
  return timer;
}
