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

// Decide what a single check-status transition should trigger for the owning
// session, given its mapping entry's two opt-in flags. Pure — all the I/O
// (board broadcast, pane sendText, mergePr) stays in the poll loop; this just
// returns the two gated decisions:
//   merge — run `gh pr merge` ONLY on a session-scope `passing` (== CLEAN ==
//     mergeable) transition when `autoMergeOnPass` is set. Defaults OFF (merging
//     is consequential); task links have no single entry so never merge.
//   nudge — sendText a pane line to the live session. Gated by `autoFixPrChecks`
//     (defaults ON when unset); suppressed for a task link (no single pane) and
//     when we're about to merge (the merge sends its own line, and two unawaited
//     sendTexts to one pane interleave).
// The board toast is deliberately NOT gated here — it always fires in the poll
// loop, independent of either flag.
export function planCheckTransition(ev, entry) {
  const merge = ev.scope === 'session' && ev.checkStatus === 'passing' && Boolean(entry?.autoMergeOnPass);
  const fixEnabled = entry?.autoFixPrChecks ?? true;
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
// `autoFixPrChecks` opt-in the check-status nudge uses (defaults ON when unset) —
// dirty is just another PR notification, not a new toggle surface. There is no
// auto-merge equivalent: a DIRTY PR is by definition not mergeable.
export function planDirtyTransition(ev, entry) {
  return ev.scope === 'session' && (entry?.autoFixPrChecks ?? true);
}

// The one-line pane nudge for a dirty transition, sharing prPaneLine's exact
// shape so a dormant session's resume intent reads consistently regardless of
// which PR event woke it.
export function prDirtyPaneNudge(ev) {
  return prPaneLine(ev.number, ev.url, 'merge conflicts with the base branch — needs a rebase');
}
