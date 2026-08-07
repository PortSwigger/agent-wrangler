import { search } from '../../search/query.js';
import { updateIndex, readMeta, statsOf, isUpdating } from '../../search/corpus.js';
import { buildCandidates, boardFields, tokenize, matchMeta, statusOf, passesFacets } from '../../search/board-rows.js';

// Conversation search + browse, over the already-origin-gated control WS (like
// usage / subagent-detail), so no new browser-reachable HTTP surface is opened.
//
// Two answer modes, picked by trimmed query length (the client renders both from
// one reply shape):
//   • browse (< 2 chars) — no corpus scan: a recency-sorted listing of every
//     conversation, index docs UNION board entries whose transcript is gone.
//     This is what lets the Search view replace both find-&-attach and History.
//   • search (≥ 2 chars) — the corpus scan, with metadata-matched rows (board
//     label, cwd, task, …) appended after the scan groups, so a session is
//     findable by its label even if the string was never said in the conversation.
//
// Freshness policy, which is the only interesting decision here:
//   • no index yet   → build it, streaming progress, then answer. This is the one
//                      slow path (seconds, once).
//   • index present  → answer from what's on disk NOW and top up in the
//                      background. A refresh has to stat every transcript, and
//                      making a keystroke wait on that would trade the whole
//                      point of the design for at most one message of staleness —
//                      which the very next keystroke picks up anyway.
const REFRESH_MS = 5_000;
let lastRefresh = 0;

const BROWSE_LIMIT = 60;
const VALID_STATUS = new Set(['board', 'archived', 'offboard']);

// The candidate list the join runs over: index docs + board entries, with live
// activity from the graph (graph sessions are keyed on the CARD id, which is
// what every entry field is keyed on too — never the conversation id).
function candidateRows(ctx, docs) {
  const live = new Map((ctx.graph()?.sessions || []).map((s) => [s.sessionId, s.lastActivity || 0]));
  return buildCandidates({ docs, entries: ctx.sessionManager?.map || new Map(), live });
}

// Pure-ish core, split from the handler so tests can stub the scan and the doc
// table (mirrors adopt.js's DI seam) without an on-disk index.
export async function answerSearch(msg, ctx, {
  docs = () => readMeta().docs || [],
  scan = search,
  stats = () => statsOf(readMeta()),
} = {}) {
  const started = process.hrtime.bigint();
  const raw = String(msg.query || '').replace(/\0/g, '');
  const trimmed = raw.trim();
  const requestId = msg.requestId ?? null;
  const facets = {
    agents: Array.isArray(msg.agents) ? msg.agents : null,
    status: VALID_STATUS.has(msg.status) ? msg.status : 'all',
    since: Number(msg.since) || 0,
    until: Number(msg.until) || 0,
  };
  const rows = candidateRows(ctx, docs());

  // Browse: too short to scan for, so list instead. A 1-char query (or any
  // tokens) still filters by metadata — same multi-token AND as History's
  // filterHistory, so the old view's muscle memory keeps working.
  if (trimmed.length < 2) {
    const tokens = tokenize(trimmed);
    let list = rows.filter((r) => passesFacets(r, facets));
    if (tokens.length) list = list.filter((r) => matchMeta(r, tokens));
    list.sort((a, b) => (b.lastActivity || 0) - (a.lastActivity || 0));
    const limit = Math.max(1, Math.min(1000, Number(msg.limit) || BROWSE_LIMIT));
    const shown = list.slice(0, limit);
    return {
      type: 'search-results', requestId, browse: true, query: trimmed,
      matches: 0, shownHits: 0,
      groups: shown.map((r) => ({ ...r, matches: 0, hits: [] })),
      total: list.length, truncated: list.length > shown.length,
      ms: Number(process.hrtime.bigint() - started) / 1e6,
      index: stats(),
    };
  }

  const res = await scan({
    query: raw,
    caseSensitive: Boolean(msg.caseSensitive),
    wholeWord: Boolean(msg.wholeWord),
    roles: Array.isArray(msg.roles) ? msg.roles : null,
    agents: facets.agents,
    since: facets.since,
    until: facets.until,
    limit: Number(msg.limit) || 0,
  });

  const byConversation = new Map(rows.map((r) => [r.sessionId, r]));
  const tokens = tokenize(raw);
  const present = new Set(res.groups.map((g) => g.sessionId));

  // Scan groups keep their order; each gains the board join, a metaMatch marker
  // when its metadata ALSO matches (the client shows why), and the status facet
  // — which must drop scan groups too, so it runs post-enrich, here.
  const groups = [];
  for (const g of res.groups) {
    const c = byConversation.get(g.sessionId);
    if (c) {
      Object.assign(g, boardFields(c));
      const mf = matchMeta(c, tokens);
      if (mf) { g.metaMatch = true; g.matchedFields = mf; }
    }
    if (facets.status !== 'all' && statusOf(c || {}) !== facets.status) continue;
    groups.push(g);
  }

  // Metadata-only matches — findable by label/cwd/task/… without the text ever
  // appearing in the conversation. Appended AFTER the scan groups (text hits
  // stay the headline), recency-sorted among themselves. The scan already
  // applied agents (docMask) and per-hit since/until; these rows get the same
  // facets via passesFacets, with since/until cutting on lastActivity instead.
  const metaOnly = [];
  for (const r of rows) {
    if (present.has(r.sessionId)) continue;
    const mf = matchMeta(r, tokens);
    if (!mf || !passesFacets(r, facets)) continue;
    metaOnly.push({ ...r, matches: 0, hits: [], metaMatch: true, matchedFields: mf });
  }
  metaOnly.sort((a, b) => (b.lastActivity || 0) - (a.lastActivity || 0));
  groups.push(...metaOnly);

  return { type: 'search-results', requestId, browse: false, ...res, groups };
}

function statusReply(extra = {}) {
  return { type: 'search-status', ...statsOf(readMeta()), building: isUpdating(), ...extra };
}

async function build(ctx) {
  lastRefresh = Date.now();
  let last = 0;
  await updateIndex({
    onProgress: (p) => {
      // Throttled by the indexer itself (250 ms); this guard covers a second
      // client attaching to the same in-flight build.
      if (Date.now() - last < 200) return;
      last = Date.now();
      ctx.reply({ type: 'search-status', building: true, progress: p });
    },
  });
  ctx.reply(statusReply());
}

export const searchHandler = {
  type: 'search',
  async handler(msg, ctx) {
    if (!readMeta().recordCount) {
      ctx.reply({ type: 'search-status', building: true, progress: { done: 0, total: 0 } });
      await build(ctx);
    } else if (!isUpdating() && Date.now() - lastRefresh > REFRESH_MS) {
      lastRefresh = Date.now();
      // Fire and forget: this query answers from the current index.
      updateIndex().then(() => ctx.reply(statusReply())).catch(() => {});
    }
    // requestId lets the client drop a reply that a later keystroke has already
    // superseded — replies are not ordered with respect to each other.
    ctx.reply(await answerSearch(msg, ctx));
  },
};

export const searchStatusHandler = {
  type: 'search-status',
  async handler(msg, ctx) {
    ctx.reply(statusReply());
    if (!readMeta().recordCount && !isUpdating()) await build(ctx);
  },
};

export const searchReindexHandler = {
  type: 'search-reindex',
  async handler(msg, ctx) {
    if (isUpdating()) return;
    ctx.reply({ type: 'search-status', building: true, progress: { done: 0, total: 0 } });
    lastRefresh = Date.now();
    let last = 0;
    await updateIndex({
      rebuild: Boolean(msg.rebuild),
      onProgress: (p) => {
        if (Date.now() - last < 200) return;
        last = Date.now();
        ctx.reply({ type: 'search-status', building: true, progress: p });
      },
    });
    ctx.reply(statusReply({ rebuilt: Boolean(msg.rebuild) }));
  },
};

export function _resetSearchRefresh() { lastRefresh = 0; }
