// The one process-wide memo of scanAllDaily's result. Lifted out of the usage
// control handler once the Jobs board needed the same scan for per-job price: two
// independent caches would mean two O(all-history) walks of every transcript on
// disk, minutes apart, for the same numbers.
//
// scanAllDaily reads EVERY on-disk transcript (O(all history)), so its result is
// cached: a granularity toggle re-rolls the cached day bags in memory instead of
// re-scanning disk, and rapid re-opens within the TTL are free. The cache is
// granularity-independent (day bags roll up to any granularity) and invalidated by
// a short TTL — simple, and staleness is bounded to seconds while the board's own
// ~4s rebuild keeps live cost fresh elsewhere.
const CACHE_TTL_MS = 30_000;
let cache = null; // { at, inflight, scan? } — inflight is set on entry, scan added on resolve

// Memoise the IN-FLIGHT promise, not just the resolved value: the first (cold) scan
// is the multi-second one, and concurrent requests are the norm here (panel open +
// every granularity toggle + multiple tabs + the Jobs board's own refresh, all
// dispatched fire-and-forget). Sharing the running promise means N concurrent
// requests trigger ONE scan, not N — else the unprotected cold window multiplies
// disk reads, memory, and event-loop stall by N.
export async function cachedScan(scanFn) {
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
