// Per-checkpoint Codex usage from a rollout, shared by the live card (codex-rollout.js
// analyzeCodex) and the durable ledger (codex-usage-ledger.js) so both charge exactly the
// same deltas.
//
// Accounting authority is the CUMULATIVE `token_count.info.total_token_usage`: each rise
// is usage that happened at that line's timestamp, under the `turn_context` model/effort
// in force. `token_usage_record.usage` is per response and is NOT summed — real rollouts
// show it exceeding the cumulative counter (retries), so it is kept as a diagnostic only.
//
// A rollout's counter does not always start at zero, and the reason decides who owns the
// starting value (the "baseline"):
//  - `history_base` in session_meta: a resume continuing the same thread in a new file.
//    The baseline is the previous file's usage, already charged there.
//  - `forked_from_id`: the fork replays its source's history (checkpoints included) in a
//    burst as the file is created. Those replayed checkpoints and any starting value are
//    the source thread's usage, never this one's.
//  - neither: unexplained. It is real usage of this thread with unknown time and model,
//    emitted as one explicit unattributed entry rather than dropped or guessed.
//
// A fork's replay is recognised by time: every replayed line is written within a few ms
// of the file's first line (measured up to ~50ms on real forks), while a genuinely new
// checkpoint needs a full model round trip. `subagent_history_start_ordinal` looked like
// an explicit marker but disagrees with the observed replay boundary on real forked
// sub-agents, so it is not used.
export const FORK_REPLAY_WINDOW_MS = 1000;

export const USAGE_FIELDS = [
  ['input_tokens', 'input'],
  ['cached_input_tokens', 'cached'],
  ['output_tokens', 'output'],
  ['reasoning_output_tokens', 'reasoning'],
  ['total_tokens', 'total'],
  ['cache_write_input_tokens', 'cacheWrite'],
];

export const blankDelta = () => ({ input: 0, cached: 0, output: 0, reasoning: 0, total: 0, cacheWrite: 0 });

function toDelta(usage) {
  const out = blankDelta();
  if (!usage || typeof usage !== 'object') return out;
  for (const [raw, k] of USAGE_FIELDS) out[k] = Number(usage[raw]) || 0;
  return out;
}

const isZero = (d) => USAGE_FIELDS.every(([, k]) => !d[k]);

function parseTs(v) {
  if (typeof v !== 'string') return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

export function newUsageState() {
  return {
    meta: null,
    firstTs: null,
    replayOpen: false,
    // Highest cumulative value seen per field. Deltas are measured against it so a
    // counter that dips and recovers is never charged twice.
    peak: null,
    final: null,
    baseline: null,
    baselineKind: null,
    inherited: null,
    model: null,
    effort: null,
    modelSource: null,
    tier: null,
    plan: null,
    turn: null,
    root: null,
    checkpoints: 0,
    charged: 0,
    recordCount: 0,
    recordSum: blankDelta(),
    lastLineTs: null,
    ord: null,
  };
}

function metaFrom(p, ts, ord) {
  return {
    startOrd: ord,
    threadId: typeof p.id === 'string' ? p.id : null,
    parentThreadId: p.thread_source === 'subagent' ? p.parent_thread_id || null : null,
    forkedFromId: typeof p.forked_from_id === 'string' ? p.forked_from_id : null,
    historyBase: p.history_base && typeof p.history_base === 'object'
      ? { threadId: p.history_base.thread_id || null, endOrdinal: Number.isFinite(p.history_base.end_ordinal_exclusive) ? p.history_base.end_ordinal_exclusive : null }
      : null,
    source: p.thread_source || (typeof p.source === 'string' ? p.source : p.source && typeof p.source === 'object' ? 'subagent' : null),
    originator: p.originator || null,
    cliVersion: p.cli_version || null,
    agentRole: p.agent_role || null,
    agentPath: p.agent_path || null,
    startedAt: ts,
  };
}

// Feed one rollout line. Returns the ledger entries it produced (usually none, at most
// two: an unattributed baseline and the checkpoint's own delta). `pos` identifies the
// line within its file and becomes part of each entry's id, so re-feeding the same line
// after a crash yields the same id and dedupes rather than double-counting.
export function parseUsageLine(state, line, pos) {
  if (!line || !line.trim()) return [];
  let entry;
  try { entry = JSON.parse(line); } catch { return []; }
  if (!entry || typeof entry !== 'object') return [];
  const ts = parseTs(entry.timestamp);
  state.ord = Number.isFinite(entry.ordinal) ? entry.ordinal : null;
  if (state.firstTs == null && ts != null) state.firstTs = ts;
  if (ts != null) state.lastLineTs = ts;
  const p = entry.payload && typeof entry.payload === 'object' ? entry.payload : entry;
  const kind = p.type || entry.type;

  if (entry.type === 'session_meta' && !state.meta) {
    state.meta = metaFrom(p, ts, state.ord);
    state.replayOpen = !!state.meta.forkedFromId;
    return [];
  }
  if (state.replayOpen && ts != null && state.firstTs != null && ts - state.firstTs > FORK_REPLAY_WINDOW_MS) {
    state.replayOpen = false;
  }
  if (entry.type === 'turn_context' || kind === 'turn_context') {
    if (typeof p.model === 'string') { state.model = p.model; state.modelSource = 'turn_context'; }
    const effort = p.effort ?? p.collaboration_mode?.settings?.reasoning_effort;
    if (typeof effort === 'string') state.effort = effort;
    if (typeof p.turn_id === 'string') state.turn = p.turn_id;
    if (typeof p.root_turn_id === 'string') state.root = p.root_turn_id;
    return [];
  }
  if (kind === 'thread_settings_applied' && p.thread_settings && typeof p.thread_settings === 'object') {
    const s = p.thread_settings;
    // The thread's applied settings, written before its first turn. Explicit evidence of
    // the model, but turn_context (per turn) wins whenever one has been seen.
    if (state.modelSource !== 'turn_context' && typeof s.model === 'string') {
      state.model = s.model;
      state.modelSource = 'thread_settings';
      if (typeof s.reasoning_effort === 'string') state.effort = s.reasoning_effort;
    }
    if (typeof s.service_tier === 'string') state.tier = s.service_tier;
    return [];
  }
  if (kind === 'task_started') {
    if (typeof p.turn_id === 'string') state.turn = p.turn_id;
    if (typeof p.root_turn_id === 'string') state.root = p.root_turn_id;
    return [];
  }
  if (entry.type === 'token_usage_record' && p.usage) {
    state.recordCount += 1;
    const d = toDelta(p.usage);
    for (const [, k] of USAGE_FIELDS) state.recordSum[k] += d[k];
    return [];
  }
  if (kind !== 'token_count' || !p.info || !p.info.total_token_usage) return [];

  const cur = toDelta(p.info.total_token_usage);
  const last = p.info.last_token_usage ? toDelta(p.info.last_token_usage) : null;
  if (p.rate_limits && typeof p.rate_limits.plan_type === 'string') state.plan = p.rate_limits.plan_type;
  state.checkpoints += 1;
  state.final = cur;
  const out = [];

  if (state.replayOpen) {
    // Replayed from the fork source: becomes this rollout's baseline, never a charge.
    state.peak = state.peak ? maxDelta(state.peak, cur) : { ...cur };
    state.baseline = { ...state.peak };
    state.baselineKind = 'fork';
    state.inherited = { ...state.peak };
    return out;
  }

  if (!state.peak) {
    // First charged checkpoint. What came before it is whatever the counter held
    // minus this request's own usage.
    const before = blankDelta();
    if (last) for (const [, k] of USAGE_FIELDS) before[k] = Math.max(0, cur[k] - last[k]);
    state.peak = before;
    state.baseline = { ...before };
    if (isZero(before)) {
      state.baselineKind = 'zero';
    } else if (state.meta?.historyBase) {
      state.baselineKind = 'history_base';
      state.inherited = { ...before };
    } else if (state.meta?.forkedFromId) {
      state.baselineKind = 'fork';
      state.inherited = { ...before };
    } else {
      state.baselineKind = 'unexplained';
      out.push(makeEntry(state, `${pos}:base`, null, { ...before }, { kind: 'baseline', model: null, effort: null }));
    }
  }

  const delta = blankDelta();
  for (const [, k] of USAGE_FIELDS) {
    delta[k] = Math.max(0, cur[k] - state.peak[k]);
    state.peak[k] += delta[k];
  }
  if (isZero(delta)) return out;
  state.charged += 1;
  out.push(makeEntry(state, pos, ts, delta, {
    kind: 'usage',
    reqIn: last ? last.input : null,
  }));
  return out;
}

function maxDelta(a, b) {
  const out = blankDelta();
  for (const [, k] of USAGE_FIELDS) out[k] = Math.max(a[k] || 0, b[k] || 0);
  return out;
}

function makeEntry(state, pos, ts, delta, extra) {
  const e = {
    pos,
    ord: state.ord,
    ts,
    model: state.model,
    effort: state.effort,
    turn: state.turn,
    root: state.root,
    tier: state.tier,
    plan: state.plan,
    reqIn: null,
    kind: 'usage',
    d: delta,
    ...extra,
  };
  return e;
}

// Parse a whole rollout text in one go. Used by the live card and tests; the ledger
// drives parseUsageLine incrementally from a byte cursor instead.
export function parseRolloutUsage(text) {
  const state = newUsageState();
  const entries = [];
  let pos = 0;
  for (const line of text.split('\n')) {
    for (const e of parseUsageLine(state, line, pos)) entries.push(e);
    pos += 1;
  }
  return { state, entries };
}

export function sumDeltas(entries) {
  const out = blankDelta();
  for (const e of entries) for (const [, k] of USAGE_FIELDS) out[k] += e.d[k] || 0;
  return out;
}

// Ledger-sum vs counter: every token this rollout charged plus what it inherited must
// equal its final cumulative counter. A dip in the counter that never recovered, or an
// entry lost or duplicated between parse and storage, shows up here.
export function reconcileRollout(state, entries) {
  if (!state.final) return { status: state.checkpoints ? 'mismatch' : 'empty', diff: null };
  const sum = sumDeltas(entries);
  const inherited = state.inherited || blankDelta();
  const diff = {};
  let ok = true;
  for (const [, k] of USAGE_FIELDS) {
    diff[k] = state.final[k] - inherited[k] - sum[k];
    if (diff[k] !== 0) ok = false;
  }
  return { status: ok ? 'ok' : 'mismatch', diff };
}
