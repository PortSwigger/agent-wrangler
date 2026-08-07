// Pure logic for the Search view's browse mode (search.js), split out so it can
// be unit-tested without a DOM. Reimplements the retired History view's
// time-bucket scheme and archived-task token filter on the search reply's shape
// — deliberately NOT imported from history-group.js, which the Search view
// superseded and which is now deleted.

const HOUR = 3600e3;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

// Fixed granular buckets covering the last week, newest first; `maxMs` is
// inclusive. Anything older buckets per whole week elapsed ("1–2 weeks ago", …)
// so the tail stays scannable without a wall of undifferentiated rows.
const RECENT_BUCKETS = [
  { key: '4h', label: 'Last 4 hours', maxMs: 4 * HOUR },
  { key: '1d', label: 'Last day', maxMs: DAY },
  { key: '2d', label: 'Last 2 days', maxMs: 2 * DAY },
  { key: '1w', label: 'Last week', maxMs: 7 * DAY },
];

// Bucket meta for one elapsed span: {key, label, sort}. `sort` orders buckets
// newest-first (recent buckets by index, then the per-week tail ascending).
// A negative elapsed (clock skew, a just-touched row) lands in the newest bucket.
export function bucketMetaFor(elapsed) {
  for (let i = 0; i < RECENT_BUCKETS.length; i++) {
    const b = RECENT_BUCKETS[i];
    if (elapsed <= b.maxMs) return { key: b.key, label: b.label, sort: i };
  }
  const n = Math.floor(elapsed / WEEK);
  return { key: `w${n}`, label: `${n}–${n + 1} weeks ago`, sort: RECENT_BUCKETS.length + n };
}

// Merge server browse groups (recency-sorted conversations) with client-known
// archived tasks into ordered time buckets:
//   [{ key, label, rows: [{kind:'session', ts, group} | {kind:'task', ts, task}] }]
// Buckets newest-first, rows within a bucket newest-first; empties never exist.
// A row with no timestamp (ts 0) sinks to the oldest weekly bucket rather than
// being dropped — a conversation is never hidden just because its metadata is thin.
export function buildBrowseBuckets(groups, archivedTasks, now) {
  const rows = [
    ...(groups || []).map((g) => ({ kind: 'session', ts: g.lastActivity || 0, group: g })),
    ...(archivedTasks || []).map((t) => ({ kind: 'task', ts: t.archivedAt || 0, task: t })),
  ];
  const byKey = new Map();
  for (const r of rows) {
    const meta = bucketMetaFor(now - r.ts);
    let b = byKey.get(meta.key);
    if (!b) { b = { ...meta, rows: [] }; byKey.set(meta.key, b); }
    b.rows.push(r);
  }
  return [...byKey.values()]
    .sort((a, b) => a.sort - b.sort)
    .map((b) => ({ key: b.key, label: b.label, rows: b.rows.sort((x, y) => y.ts - x.ts) }));
}

// Multi-token AND substring filter over a task's name — the only user-visible
// text an archived task carries. Same semantics as History's filterArchivedTasks:
// empty/whitespace query is a no-op; a task matches iff every whitespace-delimited
// token is a case-insensitive substring of its name.
export function filterTasksByName(tasks, query) {
  const tokens = (query || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return tasks;
  return tasks.filter((t) => {
    const name = (t.name || '').toLowerCase();
    return tokens.every((tok) => name.includes(tok));
  });
}

// The display title for one search/browse group, in falling priority: the board
// label the user gave it, the transcript title, the cwd basename, the id prefix.
export function rowTitle(g) {
  if (g.boardLabel) return g.boardLabel;
  if (g.title) return g.title;
  const base = (g.cwd || '').split('/').filter(Boolean).slice(-1)[0];
  if (base) return base;
  return String(g.sessionId || '').slice(0, 8);
}
