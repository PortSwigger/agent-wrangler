// What a job cost, for the Jobs board. Pure over a usage scan (usage-report.js
// scanAllDaily) plus a jobs snapshot: the expensive half stays in the scanner, and
// this module only ever SUMS dollars it was handed — never a fourth token-pricing
// scanner beside transcript-reader / usage-report / cost-report.mjs.
//
// Why the scan rather than graph.sessions, which already carries a per-card `usd`:
// a job step is archived the instant it stops (job-runtime retire) and an archived
// entry is transcript-free by design, while a headless comment triage has no card
// of its own and is billed onto the sub-job's latest card as a priorLiveSessionId —
// which the live enrichment never reads. scanAllDaily resolves every transcript a
// card has owned (priorLiveSessionIds included), applies the fork bound and
// estimates Codex, so it is the only source that sees a finished job's whole bill.

// cardId -> { usd, estimated }. Two rows can share a card (a `/clear` leaves an
// earlier transcript behind, and each is its own row), so they accumulate. A row's
// `estimatedUsd` is a dollar SLICE, not a flag: any of it means the card's total
// carries a Codex estimate and must be shown with `~`.
export function usdByCard(scan) {
  const out = new Map();
  for (const row of scan?.sessions || []) {
    if (!row.cardId) continue;
    const cur = out.get(row.cardId) || { usd: 0, estimated: false };
    for (const bag of Object.values(row.days || {})) {
      cur.usd += bag.usd || 0;
      if ((bag.estimatedUsd || 0) > 0) cur.estimated = true;
    }
    out.set(row.cardId, cur);
  }
  return out;
}

// Zero reads as "nothing attributable yet" and is carried as null, so a backlog
// job renders nothing rather than advertising $0.00 — the board hides a null.
// `usdEstimated` is deliberately NOT called `estimatedUsd`: that name is already a
// dollar amount in the scanner's day bags, and this is a boolean.
function sumCards(byCard, ids) {
  let usd = 0;
  let estimated = false;
  for (const id of new Set(ids.filter(Boolean))) {
    const hit = byCard.get(id);
    if (!hit) continue;
    usd += hit.usd;
    estimated ||= hit.estimated;
  }
  return { usd: usd > 0 ? usd : null, usdEstimated: usd > 0 && estimated };
}

export function withJobSpend(snapshot, byCard = new Map()) {
  return {
    ...snapshot,
    jobs: (snapshot?.jobs || []).map((job) => {
      const subJobs = (job.subJobs || []).map((sub) => ({ ...sub, ...sumCards(byCard, sub.sessions || []) }));
      // Planning and ticketing runs carry a null subJobId, so no sub-job holds
      // their cards: a job's total is every card ANY of its runs bound, unioned
      // with whatever its sub-jobs list (identical today — sub.sessions is filled
      // from bindRun — but the union can never under-report if that changes).
      const cards = [...(job.runs || []).map((r) => r.sessionId), ...subJobs.flatMap((s) => s.sessions || [])];
      return { ...job, subJobs, ...sumCards(byCard, cards) };
    }),
  };
}
