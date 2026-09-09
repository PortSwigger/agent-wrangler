import { scanAllDaily, rollup } from '../../usage-report.js';
import { cachedScan } from '../../usage-scan-memo.js';
// Re-exported so usage.test.js keeps its existing reset seam after the memo moved out.
export { _resetUsageCache } from '../../usage-scan-memo.js';

// The Usage dashboard's data source. A request carries a granularity (day / week /
// month) and an optional absolute date range ({start, end}, each 'YYYY-MM-DD' or
// null for "unbounded on that side" — no preset vocabulary crosses the wire, that's
// resolved client-side); the reply is per-bucket, per-task $ + token totals for the
// resolved window. Request/reply over the already-origin-gated control WS (like
// subagent-detail / search), so no new HTTP surface is exposed.
//
// scanAllDaily reads EVERY on-disk transcript (O(all history)), so its result comes
// from the process-wide memo in usage-scan-memo.js — shared with the Jobs board's
// per-job price so the two never walk all of disk separately for the same numbers.

// Accept only a well-formed 'YYYY-MM-DD' whose parse is finite; anything else (absent,
// wrong shape, '2026-02-31', a number, an object) drops to null — "unbounded on that
// side" — never throws. The request is fire-and-forget over the control WS with no
// error surface, so a bad range must degrade quietly rather than break the panel.
function dayKeyMs(v) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const ms = Date.parse(`${v}T00:00:00.000Z`);
  return Number.isFinite(ms) ? ms : null;
}

export const usageHandler = {
  type: 'usage',
  async handler(msg, ctx) {
    const granularity = ['day', 'week', 'month'].includes(msg.granularity) ? msg.granularity : 'day';
    let start = dayKeyMs(msg.start);
    let end = dayKeyMs(msg.end);
    // A reversed pair is a half-finished custom entry (the user set the second date
    // first) — swap rather than reject, so the chart doesn't blank mid-typing.
    if (start !== null && end !== null && start > end) { const t = start; start = end; end = t; }
    const scanFn = ctx.scanUsage || scanAllDaily;
    const scan = await cachedScan(scanFn);
    // Echo the sanitised (post-swap) day keys back so the client's stale-reply guard
    // (replyMatchesWindow) can compare exactly against what it asked for.
    const reqStart = start !== null ? new Date(start).toISOString().slice(0, 10) : null;
    const reqEnd = end !== null ? new Date(end).toISOString().slice(0, 10) : null;
    ctx.reply({ type: 'usage', ...rollup(scan, { granularity, start, end }), reqStart, reqEnd });
  },
};
