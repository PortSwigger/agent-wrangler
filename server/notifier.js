// Track previous status per session so we only notify on the transition
// *into* needs-you, not on every poll.
let prev = new Map();
// A restart restores state but isn't a transition: the first poll seeds the
// baseline and notifies nothing, or every already-waiting session would alarm.
let seeded = false;

export function diffNeedsYou(sessions) {
  const fresh = [];
  const next = new Map();
  for (const s of sessions) {
    next.set(s.sessionId, s.status);
    if (seeded && s.status === 'needs-you' && prev.get(s.sessionId) !== 'needs-you') {
      fresh.push(s);
    }
  }
  prev = next;
  seeded = true;
  return fresh;
}

// Same transition-detection shape as diffNeedsYou, but for PR CI checks — its
// own prev Map + seeded flag so it's independent of the needs-you baseline.
let prevChecks = new Map();
let checksSeeded = false;

// A checkStatus is *notifiable* when it's a state worth nudging the agent/board
// about: mergeable (`passing`), broken (`failing`), or review-blocked
// (`awaiting-review`/`changes-requested`). `pending`/`none` are in-flight and
// stay silent — so we never fire a premature "passed".
const NOTIFY = new Set(['passing', 'failing', 'awaiting-review', 'changes-requested']);

// links: [{ scope, ownerId, url, number, checkStatus }]. Emit a link only when
// its checkStatus CHANGES into a notifiable state — so it fires on
// pending→passing, pending→awaiting-review, awaiting-review→passing, etc., but
// never on X→X or X→pending. Seeded on the first call so a restart doesn't
// replay every already-green PR. The key includes scope so a task link and a
// session link to the same url don't collide. A freshly attached PR that's
// already notifiable fires on first appearance (new key, prev undefined ≠ status).
export function diffCheckStatus(links) {
  const events = [];
  const next = new Map();
  for (const l of links) {
    const key = `${l.scope}:${l.ownerId}:${l.url}`;
    next.set(key, l.checkStatus);
    if (checksSeeded && NOTIFY.has(l.checkStatus) && prevChecks.get(key) !== l.checkStatus) events.push(l);
  }
  prevChecks = next;
  checksSeeded = true;
  return events;
}

// The effective PR pane-nudge gate for one session: its own explicit
// `autoFixPrChecks` when it has one, else the install-wide default the caller
// passes in (config-store's autoFixPrChecksDefault; ON when omitted). THE single
// definition of that precedence — every site that types a PR line into a pane
// routes through it (the checks/dirty/unresolved transitions below AND the
// merged/closed link-removal line in index.js's sweep), so turning the toggle
// off silences all of them rather than most of them. Board toasts are never
// gated on it.
export function prNudgeEnabled(entry, fixDefault = true) {
  return entry?.autoFixPrChecks ?? fixDefault;
}

// Decide what a single check-status transition should trigger for the owning
// session, given its mapping entry's two opt-in flags. Pure — all the I/O
// (board broadcast, pane sendText, mergePr) stays in the poll loop; this just
// returns the two gated decisions:
//   merge — run `gh pr merge` ONLY on a session-scope `passing` (== CLEAN ==
//     mergeable) transition when `autoMergeOnPass` is set. Defaults OFF (merging
//     is consequential); task links have no single entry so never merge.
//   nudge — sendText a pane line to the live session. Gated by `autoFixPrChecks`,
//     which falls back to the install-wide default (`fixDefault`, from
//     config-store's autoFixPrChecksDefault) when the session has no explicit
//     choice — hence ON when the caller passes nothing; suppressed for a task
//     link (no single pane) and when we're about to merge (the merge sends its
//     own line, and two unawaited sendTexts to one pane interleave).
// The board toast is deliberately NOT gated here — it always fires in the poll
// loop, independent of either flag.
export function planCheckTransition(ev, entry, fixDefault = true) {
  const merge = ev.scope === 'session' && ev.checkStatus === 'passing' && Boolean(entry?.autoMergeOnPass);
  const fixEnabled = prNudgeEnabled(entry, fixDefault);
  const nudge = ev.scope === 'session' && fixEnabled && !merge;
  return { merge, nudge };
}

// Pane-nudge phrasing per notifiable checkStatus (see fetchPrStatus). Deliberately
// contextual and non-instructive (no emoji, no imperative) — the line states what
// happened, not what to do. `passing` means genuinely mergeable (mergeStateStatus
// CLEAN), hence "mergeable" rather than a prescriptive "ready to merge".
const PR_PANE_PHRASE = {
  passing: 'all checks passing, mergeable',
  failing: 'required checks are now failing',
  'awaiting-review': 'all checks passing, awaiting review',
  'changes-requested': 'changes requested on review',
};

// Repo name (just the `<repo>`, not `owner/repo`) parsed from a GitHub PR url, for
// the notification prefix. '' on a non-match — defensive; the url is a normalised
// pr link (mcp/links.js GITHUB_PR_RE), so a match is expected.
export function repoFromPrUrl(url) {
  const m = /github\.com\/[^/]+\/([^/]+)\/pull\/\d+/.exec(url || '');
  return m ? m[1] : '';
}

// `PR #<n> (<repo>)`, or bare `PR #<n>` for an enterprise/malformed url
// (repoFromPrUrl returns '' there — omit the `(<repo>)` segment ENTIRELY rather
// than emit a bare `()`). Shared by every PR pane line so they all read the
// same regardless of which transition produced them; the client toast composes
// the same way (prRepoName in app.js), so the two must stay in step.
export function prLabel(number, url) {
  const repo = repoFromPrUrl(url);
  return repo ? `PR #${number} (${repo})` : `PR #${number}`;
}

// Every PR pane line shares this shape: a stable `[Agent Wrangler]` prefix, the
// PR label, a contextual phrase, and the clickable url. Pure so the exact format
// is unit-tested; SOME of these lines double as a dormant session's resume
// intent, so the wording must read as context to an agent resuming cold, not a
// mid-conversation instruction — hence non-instructive, emoji-free phrasing.
export function prPaneLine(number, url, phrase) {
  return `[Agent Wrangler] ${prLabel(number, url)}: ${phrase}: ${url}`;
}

// The one-line pane nudge for a check-status transition.
export function prPaneNudge(ev) {
  return prPaneLine(ev.number, ev.url, PR_PANE_PHRASE[ev.checkStatus] || ev.checkStatus);
}

// Same transition-detection shape as diffCheckStatus, but for the `dirty` (merge
// conflict) flag — its own prev Map + seeded flag, independent of checkStatus's
// baseline, because dirty is an orthogonal axis (a PR can be DIRTY with fully
// green checks: checkStatus stays `pending` there since mergeStateStatus isn't
// CLEAN, so diffCheckStatus alone would never notify a conflict).
let prevDirty = new Map();
let dirtySeeded = false;

// links: [{ scope, ownerId, url, number, dirty }]. Emit a link only when it just
// BECAME dirty (false/undefined → true) — becoming dirty is the notifiable event;
// a rebase clearing it is not alarming and stays silent, mirroring diffCheckStatus's
// forward-only semantics. Seeded on first call so a restart doesn't replay every
// already-dirty PR. A freshly attached PR that's already dirty fires on first
// appearance (new key, prevDirty undefined ≠ true).
export function diffDirty(links) {
  const events = [];
  const next = new Map();
  for (const l of links) {
    const key = `${l.scope}:${l.ownerId}:${l.url}`;
    next.set(key, Boolean(l.dirty));
    if (dirtySeeded && l.dirty && !prevDirty.get(key)) events.push(l);
  }
  prevDirty = next;
  dirtySeeded = true;
  return events;
}

// Decide whether a dirty transition should nudge the owning session's pane.
// Session-scope only (a task link has no single pane to nudge); reuses the same
// `autoFixPrChecks` opt-in the check-status nudge uses, with the same
// install-wide `fixDefault` fallback when the session has no explicit choice —
// dirty is just another PR notification, not a new toggle surface. There is no
// auto-merge equivalent: a DIRTY PR is by definition not mergeable.
export function planDirtyTransition(ev, entry, fixDefault = true) {
  return ev.scope === 'session' && prNudgeEnabled(entry, fixDefault);
}

// The one-line pane nudge for a dirty transition, sharing prPaneLine's exact
// shape so a dormant session's resume intent reads consistently regardless of
// which PR event woke it.
export function prDirtyPaneNudge(ev) {
  return prPaneLine(ev.number, ev.url, 'merge conflicts with the base branch — needs a rebase');
}

// Transition-detection for unresolved review-THREAD counts — its own prev Map,
// but DELIBERATELY no `seeded` flag (unlike diffCheckStatus/diffDirty). Those
// two track small enum/bool state spaces where firing on first sight is exactly
// the wanted behaviour for an already-terminal/dirty PR. Unresolved-comment
// count is an unbounded counter that's already non-zero on almost every
// established PR, so firing on first attach would spam "N unresolved comments"
// on every newly-linked PR. Instead, a key not yet in `prevUnresolved` is
// ALWAYS silently baselined (regardless of any global seeded state) — the
// per-key baseline alone gives restart-safety, no separate flag needed.
// Forward-only, mirroring diffDirty's precedent: only a previously-known key's
// count INCREASING emits (carrying the delta); a decrease (including all the
// way to zero) never emits — see the approved design for why "cleared" is
// deliberately not a notification (it would double-fire alongside the existing
// checkStatus pending→passing transition on repos where conversation
// resolution is the only blocker, and is noise everywhere else).
let prevUnresolved = new Map();

// links: [{ scope, ownerId, url, number, unresolvedCount }]. Emits
// { ...l, delta } for a link whose count rose since it was last seen. A link
// whose count is not yet a real number (undefined — never successfully fetched,
// e.g. every attempt so far hit a transient gh failure) is skipped entirely:
// neither baselined nor emitted, carrying its PREVIOUS baseline (if any)
// forward unchanged. Baselining it at 0 here would be wrong — the very next
// successful fetch could return the PR's real, already-nonzero count and read
// as a spurious increase, exactly the first-attach notification storm this
// diff exists to prevent.
export function diffUnresolvedComments(links) {
  const events = [];
  // Fresh each call (not seeded from prevUnresolved) so a link no longer in
  // `links` — merged/closed and removed upstream — drops out of tracking
  // rather than leaking forever, exactly like diffCheckStatus/diffDirty.
  const next = new Map();
  for (const l of links) {
    const key = `${l.scope}:${l.ownerId}:${l.url}`;
    if (typeof l.unresolvedCount !== 'number' || Number.isNaN(l.unresolvedCount)) {
      // Carry the prior baseline forward unchanged rather than dropping the key —
      // dropping it would make the count's NEXT real value look brand-new and
      // silently re-baseline, swallowing a genuine increase that spans the gap.
      const prevCount = prevUnresolved.get(key);
      if (prevCount !== undefined) next.set(key, prevCount);
      continue;
    }
    const count = l.unresolvedCount;
    const prevCount = prevUnresolved.get(key);
    if (prevCount !== undefined && count > prevCount) events.push({ ...l, delta: count - prevCount });
    next.set(key, count);
  }
  prevUnresolved = next;
  return events;
}

// Decide whether an unresolved-comment increase should nudge the owning
// session's pane. Session-scope only (a task link has no single pane to
// nudge); reuses the same `autoFixPrChecks` opt-in the check/dirty nudges use,
// with the same install-wide `fixDefault` fallback when the session has no
// explicit choice — this is just another PR notification, not a new toggle
// surface. There is no merge branch — an unresolved comment never makes a PR
// mergeable.
export function planUnresolvedTransition(ev, entry, fixDefault = true) {
  return ev.scope === 'session' && prNudgeEnabled(entry, fixDefault);
}

// The one-line pane nudge for an unresolved-comment increase, pluralized and
// sharing prPaneLine's exact shape so a dormant session's resume intent reads
// consistently regardless of which PR event woke it. "thread(s)", not
// "comment(s)" — a thread with several replies still counts as one, so
// "comment" would overstate it (matches reviewThreads/unresolvedCount/
// fetchUnresolvedThreadCount's vocabulary elsewhere). Carries the running
// total alongside the delta since it's already on the event and materially
// more actionable than the delta alone.
export function prUnresolvedPaneNudge(ev) {
  const phrase = `${ev.delta} new unresolved review thread${ev.delta === 1 ? '' : 's'} (${ev.unresolvedCount} unresolved total)`;
  return prPaneLine(ev.number, ev.url, phrase);
}
