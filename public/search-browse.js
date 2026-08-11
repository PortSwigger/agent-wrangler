// Pure logic for the Search view's browse mode (search.js), split out so it can
// be unit-tested without a DOM. Reimplements the retired History view's
// time-bucket scheme and archived-task token filter on the search reply's shape
// — deliberately NOT imported from history-group.js, which the Search view
// superseded and which is now deleted.
//
// Also reimplements (in a lighter form) the two hierarchy facets History had:
// a task-archive marker with the sessions cascade-archived alongside it nested
// beneath it, and a parent session with its archived children nested beneath
// it. Unlike History's tile grid (task × time-bucket columns, each a boxed
// unit), buckets here are time-only, so a lightweight task heading groups same-
// task rows within a bucket instead of a bordered tile, and parent/child
// nesting only draws when both land in the SAME bucket — a cross-bucket parent
// link (a long-running parent, a child archived much later) can't be hoisted
// across bucket boundaries without breaking recency order, so it renders as a
// `parentTitle` breadcrumb on the child's own (still top-level) row instead of
// losing the relationship outright.

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

function bucketKeyOf(ts, now) {
  return bucketMetaFor(now - (ts || 0)).key;
}

// One level deep, exactly like the board's own computeAbsorption (public/
// workflow.js) and History's foldTile: a session is absorbed into its parent
// iff the parent is present AND in the same bucket AND the parent itself is NOT
// absorbed into a grandparent — so a chained grandchild promotes to top-level
// instead of nesting two deep. Cycle-safe (a parentSession chain shouldn't
// cycle, but this never hangs if one does).
function foldSameBucketChildren(sessions, now) {
  const byCardId = new Map(sessions.filter((g) => g.cardId).map((g) => [g.cardId, g]));
  const cache = new Map();
  const isAbsorbed = (g) => {
    if (!g || !g.parentSession) return false;
    const parent = byCardId.get(g.parentSession);
    if (!parent) return false;
    if (bucketKeyOf(g.lastActivity, now) !== bucketKeyOf(parent.lastActivity, now)) return false;
    if (cache.has(g.sessionId)) return cache.get(g.sessionId);
    cache.set(g.sessionId, false); // cycle guard
    const result = !isAbsorbed(parent);
    cache.set(g.sessionId, result);
    return result;
  };
  const childrenByParent = new Map();
  for (const g of sessions) {
    if (isAbsorbed(g)) {
      const list = childrenByParent.get(g.parentSession) || [];
      list.push(g);
      childrenByParent.set(g.parentSession, list);
    }
  }
  const top = [];
  for (const g of sessions) {
    if (isAbsorbed(g)) continue; // drawn under its parent
    const children = g.cardId ? childrenByParent.get(g.cardId) || [] : [];
    const entry = { group: g };
    if (children.length) entry.children = children;
    // A breadcrumb for a top-level row whose parent we know about but couldn't
    // nest under (cross-bucket) — never for a row already nested as a child.
    if (g.parentSession && byCardId.has(g.parentSession)) entry.parentTitle = rowTitle(byCardId.get(g.parentSession));
    top.push(entry);
  }
  return top;
}

// Cluster same-task top-level rows into a heading group. A singleton (only one
// row for that task in this bucket) stays a plain row — its own inline task
// chip already says which task it's in, so a heading would be pure noise; a
// heading only earns its keep once there are ≥2 rows to cluster.
function foldTaskGroups(topLevel) {
  const byTask = new Map();
  const order = [];
  for (const entry of topLevel) {
    const taskId = entry.group.taskId;
    if (!taskId) { order.push(entry); continue; }
    let g = byTask.get(taskId);
    if (!g) { g = { taskId, entries: [] }; byTask.set(taskId, g); order.push(g); }
    g.entries.push(entry);
  }
  return order.map((o) => {
    if (o.taskId === undefined) return { kind: 'session', ts: o.group.lastActivity || 0, ...o };
    if (o.entries.length < 2) return { kind: 'session', ts: o.entries[0].group.lastActivity || 0, ...o.entries[0] };
    // Newest snapshot's name wins — a task rename between two archives shouldn't
    // show two different headings for the same id.
    const taskName = o.entries[0].group.task || '';
    const ts = Math.max(...o.entries.map((e) => e.group.lastActivity || 0));
    return { kind: 'task-group', ts, taskId: o.taskId, taskName, entries: o.entries };
  });
}

// Merge server browse groups (recency-sorted conversations) with client-known
// archived tasks into ordered time buckets:
//   [{ key, label, rows: [...] }]
// Each row is one of:
//   { kind:'session', ts, group, children?, parentTitle? }  — a lone/top-level
//     session, optionally with its same-bucket archived children nested under
//     it (children: raw group objects) and/or a cross-bucket parent breadcrumb.
//   { kind:'task-group', ts, taskId, taskName, entries: [{group, children?, parentTitle?}] }
//     — ≥2 same-task top-level rows in this bucket, clustered under one heading.
//   { kind:'task', ts, task, nested }  — a whole task was archived; `nested` is
//     the sessions cascade-archived alongside it (flat, no further nesting —
//     mirrors History, which never chained past this point either).
// Buckets newest-first, rows within a bucket newest-first (by each row's own
// ts — a task-group's ts is its most-recently-active member, so a cluster
// sorts exactly where its newest row would have alone). Empties never exist.
// A row with no timestamp (ts 0) sinks to the oldest weekly bucket rather than
// being dropped — a conversation is never hidden just because its metadata is thin.
export function buildBrowseBuckets(groups, archivedTasks, now) {
  const allSessions = groups || [];
  const tasks = archivedTasks || [];
  const archivedTaskIds = new Set(tasks.map((t) => t.id));

  // Sessions swept into a task-archive marker's nest are pulled out up front —
  // they render flat beneath their marker, never through the top-level folding
  // below (matches History: a nested session's own children, if it had any,
  // were never chained further either).
  const nestedByTask = new Map();
  const loose = [];
  for (const g of allSessions) {
    if (g.viaTaskArchive && archivedTaskIds.has(g.viaTaskArchive)) {
      const list = nestedByTask.get(g.viaTaskArchive) || [];
      list.push(g);
      nestedByTask.set(g.viaTaskArchive, list);
    } else {
      loose.push(g);
    }
  }

  // Parent/child absorption runs over the WHOLE set first (it already checks
  // same-bucket-ness per pair internally) — a child's bucket placement below is
  // by its own timestamp, never hoisted onto its parent's.
  const topLevel = foldSameBucketChildren(loose, now);

  const byKey = new Map();
  const bucketFor = (ts) => {
    const meta = bucketMetaFor(now - (ts || 0));
    let b = byKey.get(meta.key);
    if (!b) { b = { ...meta, entries: [], tasks: [] }; byKey.set(meta.key, b); }
    return b;
  };
  for (const entry of topLevel) bucketFor(entry.group.lastActivity).entries.push(entry);
  for (const t of tasks) {
    bucketFor(t.archivedAt).tasks.push({
      kind: 'task',
      ts: t.archivedAt || 0,
      task: t,
      nested: (nestedByTask.get(t.id) || []).sort((a, b) => (b.lastActivity || 0) - (a.lastActivity || 0)),
    });
  }

  // Task-group clustering runs LAST, scoped to one bucket's entries at a time —
  // running it before bucketing would merge a task's rows across bucket
  // boundaries into a single row carrying one (necessarily wrong) timestamp.
  return [...byKey.values()]
    .sort((a, b) => a.sort - b.sort)
    .map((b) => ({
      key: b.key,
      label: b.label,
      rows: [...foldTaskGroups(b.entries), ...b.tasks].sort((x, y) => (y.ts || 0) - (x.ts || 0)),
    }));
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
