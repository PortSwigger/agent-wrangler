// The candidate list behind browse mode and metadata matching: every live index
// doc LEFT-JOINed with its board entry (by conversation id), UNIONed with the
// board entries that have no live doc at all. The union half is what lets the
// Search view supersede History: Claude Code deletes transcripts past ~30 days,
// so an old archived card has no doc in the index — without a synthesized row it
// would silently vanish from browse the day its transcript aged out.
//
// Pure over plain inputs (docs array, mappings entries iterable, a live-card
// map) so it's unit-testable without a session manager — the handler wires in
// `ctx.sessionManager.map` and `ctx.graph()`.
//
// The conversation id is `liveSessionId || cardId`: the card id is a board
// handle, never a conversation id, EXCEPT legacy pre-split entries whose card id
// IS the conversation id (see CLAUDE.md) — the `||` is that fallback.

// Field attribution for matchedFields mirrors the fixed vocabulary the client
// renders: which piece of metadata made this row match.
const META_FIELDS = [
  ['title', (r) => r.title],
  ['cwd', (r) => r.cwd],
  ['branch', (r) => r.branch],
  ['label', (r) => r.boardLabel],
  ['task', (r) => r.task],
  ['model', (r) => r.model],
  ['worktree', (r) => [r.worktreeBranch, r.worktreePath].filter(Boolean).join(' ')],
  ['issue', (r) => r.workflowIssue],
  ['id', (r) => [r.sessionId, r.cardId].filter(Boolean).join(' ')],
];

// Same label chain as the old boardIndex/enrich pair: the frozen archive label,
// then the user's name, then the first line of the dispatch intent.
function labelOf(e) {
  return e.lastLabel || e.name || String(e.intent || '').split('\n')[0].slice(0, 120);
}

// The board-join fields, split out so the handler can Object.assign them onto a
// scan group without clobbering the group's own doc-derived title/cwd/branch.
// `live` maps card id -> lastActivity for sessions currently in the graph.
function boardFieldsOf(cardId, e, live, docLastMs) {
  return {
    cardId,
    boardLabel: labelOf(e),
    task: (e.task && e.task.name) || '',
    // The task snapshot's id, not just its name — lets the client group same-task
    // rows even if two tasks happen to share a display name. Only ever set on an
    // archived row (session-manager's archive() stamps `entry.task` from the live
    // assignment at archive time); a live board row has no snapshot yet, so it's
    // null and simply doesn't group — matching History, which only ever grouped
    // archived sessions.
    taskId: (e.task && e.task.id) || null,
    onBoard: live.has(cardId),
    archived: Boolean(e.archivedAt),
    model: e.model || null,
    createdAt: e.createdAt || null,
    archivedAt: e.archivedAt || null,
    worktreeBranch: e.worktree?.branch || '',
    worktreePath: e.worktree?.path || '',
    workflowIssue: e.workflow?.issue || '',
    // Generic parent-session link (see CLAUDE.md's session-hierarchy note) — lets
    // the client fold an archived child under its archived parent, mirroring the
    // board's own nesting. Just the id: which card it points at is all the client
    // folding logic needs.
    parentSession: e.parentSession || null,
    // Whether THIS session was itself an autopilot orchestrator — a boolean, not
    // the `workflow` object (whose `phase.label` is agent-written text that would
    // need the same untrusted-text handling as everything else search.js renders,
    // for no rendering benefit over a boolean).
    isWorkflow: Boolean(e.workflow),
    // Set only when this session was swept up by a task-archive cascade (see
    // session-manager's archive()) — the link the client uses to nest it under
    // its task's archive marker rather than showing it as a loose row.
    viaTaskArchive: e.viaTaskArchive || null,
    // Best recency signal available: the transcript's own tail, the entry's
    // lifecycle stamps, and the graph's live activity — whichever is newest.
    lastActivity: Math.max(docLastMs || 0, e.archivedAt || 0, e.createdAt || 0, live.get(cardId) || 0),
  };
}

// Build the full candidate list. `entries` is an iterable of [cardId, entry]
// (a Map works); `live` is a Map of cardId -> lastActivity (ms) for sessions in
// the current graph. Dead (tombstoned) docs are skipped exactly as the scan's
// docMask skips them — their bytes describe a rewritten file — which also routes
// their board entry through the mappings-only union below.
export function buildCandidates({ docs = [], entries = new Map(), live = new Map() } = {}) {
  const byConversation = new Map();
  for (const [cardId, e] of entries) byConversation.set(e.liveSessionId || cardId, [cardId, e]);

  const rows = [];
  const joined = new Set();
  docs.forEach((d, docIdx) => {
    if (!d || d.dead || !d.id) return;
    const lastMs = (d.lastTs || 0) * 1000;
    const row = {
      docIdx,
      sessionId: d.id,
      agent: d.agent || 'claude',
      cwd: d.cwd || '',
      title: d.title || '',
      branch: d.branch || '',
      lastTs: lastMs,
      lastActivity: lastMs,
    };
    const hit = byConversation.get(d.id);
    if (hit) {
      joined.add(d.id);
      Object.assign(row, boardFieldsOf(hit[0], hit[1], live, lastMs));
    }
    rows.push(row);
  });

  // The union half: board entries with no live doc — a transcript deleted by
  // retention, tombstoned by a rewrite, or simply not indexed yet. One row per
  // conversation, never two: anything already joined above is skipped here.
  for (const [conversationId, [cardId, e]] of byConversation) {
    if (joined.has(conversationId)) continue;
    rows.push({
      docIdx: -1,
      sessionId: conversationId,
      agent: e.agent || 'claude',
      cwd: e.cwd || '',
      title: labelOf(e),
      branch: '',
      lastTs: 0,
      noTranscript: true,
      ...boardFieldsOf(cardId, e, live, 0),
    });
  }
  return rows;
}

// The join subset a scan group gains from its candidate row — everything that
// isn't already the group's own doc-derived shape (docIdx/title/cwd/branch/hits
// stay the scan's). A doc-only candidate contributes just lastActivity.
const BOARD_KEYS = ['cardId', 'boardLabel', 'task', 'taskId', 'onBoard', 'archived', 'model', 'createdAt',
  'archivedAt', 'worktreeBranch', 'worktreePath', 'workflowIssue', 'parentSession', 'isWorkflow',
  'viaTaskArchive', 'lastActivity'];
export function boardFields(row) {
  const out = {};
  for (const k of BOARD_KEYS) if (row[k] !== undefined) out[k] = row[k];
  return out;
}

export function tokenize(query) {
  return String(query || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
}

// Multi-token AND, case-insensitive substring over the joined metadata corpus —
// the same semantics as the History view's filterHistory, so retiring that view
// doesn't change what a query finds. Returns the matched field names (for the
// client's "why did this match" chips), or null when the row doesn't match.
// Matching is decided on the JOINED corpus; attribution is per-field afterwards,
// so a token that only spans a join boundary can match with empty attribution.
export function matchMeta(row, tokens) {
  if (!tokens.length) return null;
  const parts = META_FIELDS.map(([name, get]) => [name, String(get(row) || '').toLowerCase()]);
  const corpus = parts.map(([, v]) => v).filter(Boolean).join(' ');
  if (!tokens.every((t) => corpus.includes(t))) return null;
  return parts.filter(([, v]) => v && tokens.some((t) => v.includes(t))).map(([name]) => name);
}

// Status facet vocabulary: archived beats board (an archived card still has a
// cardId), and a doc with no board entry at all is off-board.
export function statusOf(row) {
  if (row.archived) return 'archived';
  if (row.cardId) return 'board';
  return 'offboard';
}

// The non-text facets, applied uniformly to browse rows and meta-only rows in
// search mode. `since`/`until` are ms and cut on lastActivity — the per-hit
// timestamp cut stays the scan's own business.
export function passesFacets(row, { agents = null, status = 'all', since = 0, until = 0 } = {}) {
  if (status && status !== 'all' && statusOf(row) !== status) return false;
  if (Array.isArray(agents) && agents.length && !agents.includes(row.agent)) return false;
  const at = row.lastActivity || 0;
  if (since && at < since) return false;
  if (until && at > until) return false;
  return true;
}
