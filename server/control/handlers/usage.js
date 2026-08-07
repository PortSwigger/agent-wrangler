import { scanAllDaily, rollup } from '../../usage-report.js';

// The Usage dashboard's data source. A request carries a granularity (day / week /
// month); the reply is per-bucket, per-task $ + token totals for that granularity's
// default window. Request/reply over the already-origin-gated control WS (like
// subagent-detail / search), so no new HTTP surface is exposed.
//
// scanAllDaily reads EVERY on-disk transcript (O(all history)), so its result is
// cached: a granularity toggle re-rolls the cached day bags in memory instead of
// re-scanning disk, and rapid re-opens within the TTL are free. The cache is
// granularity-independent (day bags roll up to any granularity), invalidated by a
// short TTL — simple, and staleness is bounded to seconds while the board's own
// ~4s rebuild keeps live cost fresh elsewhere.
const CACHE_TTL_MS = 30_000;
let cache = null; // { at, inflight, scan? } — inflight is set on entry, scan added on resolve

// Memoise the IN-FLIGHT promise, not just the resolved value: the first (cold) scan
// is the multi-second one, and concurrent requests are the norm here (panel open +
// every granularity toggle + multiple tabs, all dispatched fire-and-forget). Sharing
// the running promise means N concurrent requests trigger ONE scan, not N — else the
// unprotected cold window multiplies disk reads, memory, and event-loop stall by N.
async function cachedScan(scanFn) {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.scan || cache.inflight;
  const entry = { at: now, inflight: scanFn() };
  cache = entry;
  try {
    entry.scan = await entry.inflight; // resolve replaces inflight with the value; TTL still measured from scan start
    return entry.scan;
  } catch (e) {
    if (cache === entry) cache = null; // clear on reject so the next request retries (don't pin a failed scan)
    throw e;
  }
}

// Test seam: drop the memoized scan so a test never sees another test's data.
export function _resetUsageCache() { cache = null; }

export const usageHandler = {
  type: 'usage',
  async handler(msg, ctx) {
    const granularity = ['day', 'week', 'month'].includes(msg.granularity) ? msg.granularity : 'day';
    const scanFn = ctx.scanUsage || scanAllDaily;
    const scan = await cachedScan(scanFn);
    ctx.reply({ type: 'usage', ...rollup(scan, { granularity }) });
  },
};
