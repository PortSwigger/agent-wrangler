// Pure grouping logic for the History view, split out of app.js so it can be
// unit-tested without a DOM. The browser loads this as a module (it also pins the
// exports onto window for the classic app.js script); node imports it directly.

import { isWorkflowRun } from './workflow.js';

const HOUR = 3600e3;
const DAY = 24 * HOUR;

// Fixed granular buckets covering the last week, newest first. `maxMs` is
// inclusive; groupHistory walks them in order. Anything OLDER than a week is
// bucketed per whole week elapsed instead (weeklyBucket) so the History view can
// reveal the tail a week at a time — see the client's "Show older" pagination.
const RECENT_BUCKETS = [
  { key: '4h', label: 'Last 4 hours', maxMs: 4 * HOUR },
  { key: '1d', label: 'Last day', maxMs: DAY },
  { key: '2d', label: 'Last 2 days', maxMs: 2 * DAY },
  { key: '1w', label: 'Last week', maxMs: 7 * DAY },
];
const WEEK = 7 * DAY;
// A bucket for something older than a week: n = whole weeks elapsed (≥1),
// labelled with an en-dash range ("1–2 weeks ago", "2–3 weeks ago", …). `sort`
// keeps it after every recent bucket and orders the weeks newest-first.
function weeklyBucket(elapsed) {
  const n = Math.floor(elapsed / WEEK);
  return { key: `w${n}`, label: `${n}–${n + 1} weeks ago`, sort: RECENT_BUCKETS.length + n };
}

// Compact, two-unit duration: "1h 47m", "3h", "3d 2h", "22m", "<1m". Anything
// non-positive or missing (no createdAt) returns null so the caller omits it.
export function fmtDuration(ms) {
  if (!ms || ms <= 0) return null;
  const d = Math.floor(ms / DAY);
  const h = Math.floor((ms % DAY) / HOUR);
  const m = Math.floor((ms % HOUR) / 60e3);
  if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  if (m > 0) return `${m}m`;
  return '<1m';
}

// Build the searchable corpus for one archived session: the user-visible text
// History carries. Internals (session id, repoRoot, sockets, timestamps) are
// deliberately excluded.
function corpus(h) {
  return [
    h.label, h.cwd, h.task && h.task.name, h.model, h.agent,
    h.worktree && h.worktree.branch, h.worktree && h.worktree.path,
    h.workflow && h.workflow.issue,
  ].filter(Boolean).join(' ').toLowerCase();
}

// Multi-token AND substring filter. Empty/whitespace query is a no-op (returns
// the input). A session matches iff every whitespace-delimited token is a
// substring of its corpus.
export function filterHistory(history, query) {
  const tokens = (query || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return history;
  return history.filter((h) => {
    const c = corpus(h);
    return tokens.every((t) => c.includes(t));
  });
}

// Same multi-token AND substring filter as filterHistory, scoped to a task's
// name — the only user-visible text a task-archive marker carries. Kept as its
// own function (matching corpus/filterHistory's split) rather than sharing one
// generic filter, since the two corpora are unrelated shapes.
export function filterArchivedTasks(tasks, query) {
  const tokens = (query || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return tasks;
  return tasks.filter((t) => {
    const name = (t.name || '').toLowerCase();
    return tokens.every((tok) => name.includes(tok));
  });
}

// Fold one tile's flat (newest-first) session list into ordered render-units,
// grouping each archived session that has ≥1 of its `parentSession` children
// present in the SAME tile (same task + same time-bucket) — mirroring
// renderTileCards on the board. An orchestrator parent (isWorkflowRun) folds
// into the violet workflow box; any other parent folds into a plain 'children'
// unit (e.g. an archived review stack under its reviewed session). The parent's
// slot fixes where its unit lands. A solo parent (no present child) or an orphan
// child (its parent not in this tile) stays a loose card so it's never lost.
// Like renderTileCards, nesting resolves one level deep: a child whose own
// parent is itself absorbed elsewhere is promoted to its own top-level unit
// (isAbsorbed, recursive over the chain) instead of being silently dropped.
// `count` stays the total archived sessions in the tile so the tile-head badge
// is accurate.
function foldTile(tile) {
  const sessions = tile.sessions;
  const present = new Set(sessions.map((s) => s.sessionId));
  const byId = new Map(sessions.map((s) => [s.sessionId, s]));
  const absorbedCache = new Map();
  const isAbsorbed = (s) => {
    if (!s || !s.parentSession || !present.has(s.parentSession)) return false;
    if (absorbedCache.has(s.sessionId)) return absorbedCache.get(s.sessionId);
    absorbedCache.set(s.sessionId, false); // cycle guard (parentSession chains shouldn't cycle, but never hang)
    const result = !isAbsorbed(byId.get(s.parentSession));
    absorbedCache.set(s.sessionId, result);
    return result;
  };
  const childrenByParent = new Map();
  for (const s of sessions) {
    if (isAbsorbed(s)) {
      const list = childrenByParent.get(s.parentSession) || [];
      list.push(s);
      childrenByParent.set(s.parentSession, list);
    }
  }
  const units = [];
  for (const s of sessions) {
    if (isAbsorbed(s)) continue; // drawn under its parent
    const children = childrenByParent.get(s.sessionId) || [];
    if (isWorkflowRun(s) && children.length) {
      const phase = s.workflow && s.workflow.phase;
      units.push({
        kind: 'workflow',
        orch: s,
        workers: children,
        issue: (s.workflow && s.workflow.issue) || null,
        outcome: phase ? { label: phase.label, kind: phase.kind ?? null } : null,
      });
    } else if (children.length) {
      units.push({ kind: 'children', session: s, children });
    } else {
      units.push({ kind: 'card', session: s });
    }
  }
  // The task-archive marker (if this tile's task was itself archived in this
  // bucket) always leads — it's the event the sessions below it happened
  // alongside. Unlike a workflow box's worker count (a distinct label shown
  // elsewhere), the tile-head badge's whole job is "how many cards you'll see
  // here", so the marker counts too, or the badge undercounts what's rendered.
  if (tile.taskArchive) units.unshift({ kind: 'task-archive', task: tile.taskArchive });
  return {
    taskId: tile.taskId,
    taskName: tile.taskName,
    unassigned: tile.unassigned,
    units,
    count: sessions.length + (tile.taskArchive ? 1 : 0),
  };
}

// Group archived sessions into time buckets, then into task tiles within each
// bucket. `tasks` is the TaskStore snapshot ({tasks, order, assignments}); `now`
// is injectable for testing. `archivedTasks` (already search-filtered by the
// caller, like `history`) are tasks themselves set aside via taskStore.archiveTask
// — each folds into its OWN tile (tileKey = its own id) in the bucket matching
// its OWN archivedAt, so a task archived alongside its cascade-archived sessions
// (near-identical timestamps) lands in the same tile as them. Returns ordered
// buckets (newest-first; empties omitted):
//   [{ key, label, count, older, tiles: [{ taskId, taskName, unassigned, units, count }] }]
// `older` is true for the per-week buckets beyond a week (key `w<n>`) — the ones
// the client paginates behind "Show older"; false for the fixed recent buckets.
// Each tile's `units` is the ordered render-unit list from foldTile — an optional
// leading `{ kind:'task-archive', task }` marker, then a `{ kind:'card', session }`
// (the item plus a resolved `wasName`, the snapshotted task name when its task
// was since DELETED — distinct from archived, which keeps the live task lookup
// working), a `{ kind:'workflow', orch, workers, issue, outcome }` box folding an
// orchestrator + its present workers, or a `{ kind:'children', session, children }`
// stack folding any other parent + its present non-workflow children. `count` is
// the total cards in the tile (sessions, plus the task-archive marker if present).
// Tiles follow the board's task order; the Unassigned tile is always last.
export function groupHistory(history, tasks, now, archivedTasks = []) {
  const taskList = (tasks && tasks.tasks) || [];
  const order = (tasks && tasks.order) || [];
  const assignments = (tasks && tasks.assignments) || {};
  const taskById = new Map(taskList.map((t) => [t.id, t]));
  // Real tasks ranked by board order; anything unordered sorts after, stably.
  const rank = new Map(order.filter((id) => taskById.has(id)).map((id, i) => [id, i]));
  const rankOf = (id) => (rank.has(id) ? rank.get(id) : Number.MAX_SAFE_INTEGER);

  // A fixed recent bucket (≤1 week) or a per-week bucket beyond that.
  const bucketMetaFor = (elapsed) => {
    for (let i = 0; i < RECENT_BUCKETS.length; i++) {
      const b = RECENT_BUCKETS[i];
      if (elapsed <= b.maxMs) return { key: b.key, label: b.label, sort: i };
    }
    return weeklyBucket(elapsed);
  };

  // Buckets are created lazily (keyed by their meta key), so empties never exist.
  const bucketsByKey = new Map();
  const tileFor = (meta, tileKey, seed) => {
    let bucket = bucketsByKey.get(meta.key);
    if (!bucket) { bucket = { ...meta, count: 0, tiles: new Map() }; bucketsByKey.set(meta.key, bucket); }
    let tile = bucket.tiles.get(tileKey);
    if (!tile) { tile = { ...seed, sessions: [] }; bucket.tiles.set(tileKey, tile); }
    return { bucket, tile };
  };

  for (const h of [...history].sort((a, b) => (b.archivedAt || 0) - (a.archivedAt || 0))) {
    const liveTask = taskById.get(assignments[h.sessionId]);
    const { bucket, tile } = tileFor(bucketMetaFor(now - (h.archivedAt || 0)), liveTask ? liveTask.id : '__unassigned__', {
      taskId: liveTask ? liveTask.id : null,
      taskName: liveTask ? liveTask.name : 'Unassigned',
      unassigned: !liveTask,
    });
    // wasName: only when the session has no live task but carries a snapshot — the
    // task it was archived from has since been DELETED (an archived-but-present
    // task still resolves via liveTask above, so this stays null for it).
    const wasName = !liveTask && h.task && h.task.name ? h.task.name : null;
    tile.sessions.push({ ...h, wasName });
    bucket.count += 1;
  }

  for (const t of archivedTasks) {
    const { bucket, tile } = tileFor(bucketMetaFor(now - (t.archivedAt || 0)), t.id, {
      taskId: t.id,
      taskName: t.name,
      unassigned: false,
    });
    tile.taskArchive = t;
    bucket.count += 1;
  }

  return [...bucketsByKey.values()]
    .sort((a, b) => a.sort - b.sort)
    .map((b) => ({
      key: b.key,
      label: b.label,
      count: b.count,
      older: /^w\d+$/.test(b.key),
      tiles: [...b.tiles.values()]
        .sort((x, y) => {
          if (x.unassigned !== y.unassigned) return x.unassigned ? 1 : -1; // Unassigned last
          return rankOf(x.taskId) - rankOf(y.taskId);
        })
        .map(foldTile),
    }));
}
