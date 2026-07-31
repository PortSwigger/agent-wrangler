import cronParser from 'cron-parser';

// The ONLY import site for `cron-parser` — every other module (store, tests)
// depends on this `nextRunAt` surface, not on the dep directly, so the cron-parser
// API (v4 `parseExpression` vs v5 `CronExpressionParser.parse`) is isolated to one
// file and the rest of the server stays testable without it.
//
// Compute the next firing instant (epoch ms) for a schedule's `when`, evaluated
// from `fromMs`:
//   - `once`: a fixed absolute instant — `Date.parse(when.runAt)` regardless of
//     `fromMs` (firing is gated by the store's `due()`, not by recomputation).
//   - `cron`: the next occurrence STRICTLY AFTER `fromMs`, evaluated in `when.tz`
//     (so "09:00" stays 09:00 across DST). Returns null on an unparseable cron —
//     callers persist null and the schedule simply never becomes due.
// Returns null for an unknown `kind` or an unparseable `once.runAt`.
export function nextRunAt(when, fromMs) {
  if (!when || typeof when !== 'object') return null;
  if (when.kind === 'once') {
    const ms = Date.parse(when.runAt);
    return Number.isNaN(ms) ? null : ms;
  }
  if (when.kind === 'cron') {
    try {
      const interval = cronParser.parseExpression(when.cron, {
        currentDate: new Date(fromMs),
        tz: when.tz || undefined,
      });
      return interval.next().getTime();
    } catch {
      return null; // a cron we can't parse never fires (validateSchedule rejects it on create)
    }
  }
  return null;
}

// True iff `cron` is a non-empty string cron-parser accepts. Used by
// validateSchedule so a malformed cron is rejected at create/edit time rather
// than silently never firing.
export function isValidCron(cron) {
  if (typeof cron !== 'string' || !cron.trim()) return false;
  try {
    cronParser.parseExpression(cron);
    return true;
  } catch {
    return false;
  }
}
