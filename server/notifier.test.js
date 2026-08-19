import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffCheckStatus, planCheckTransition, prPaneNudge, repoFromPrUrl, diffDirty, planDirtyTransition, prDirtyPaneNudge, prLabel, prPaneLine, diffUnresolvedComments, planUnresolvedTransition, prUnresolvedPaneNudge, prNudgeEnabled } from './notifier.js';

// link factory: { scope, ownerId, url, number, checkStatus }.
const L = (checkStatus, { scope = 'session', ownerId = 's1', url = 'https://github.com/o/r/pull/1', number = 1 } = {}) =>
  ({ scope, ownerId, url, number, checkStatus });
const urls = (events) => events.map((e) => `${e.scope}:${e.ownerId}:${e.url}`).sort();

// diffCheckStatus has module-level prev/seeded state (like diffNeedsYou), so
// these run as one stateful sequence — the FIRST test must seed. Each later
// scenario passes its baseline call first (which resets prev to just its keys),
// making the asserted transition deterministic regardless of prior tests.

test('the first call seeds and emits nothing (no replay on restart)', () => {
  assert.deepEqual(diffCheckStatus([L('passing'), L('failing', { ownerId: 's2' })]), []);
});

test('pending→failing and pending→passing emit', () => {
  diffCheckStatus([L('pending', { ownerId: 'a' }), L('pending', { ownerId: 'b' })]); // baseline
  const events = diffCheckStatus([L('failing', { ownerId: 'a' }), L('passing', { ownerId: 'b' })]);
  assert.equal(events.length, 2);
  assert.deepEqual(events.map((e) => e.checkStatus).sort(), ['failing', 'passing']);
});

test('failing→failing does not emit (no net transition)', () => {
  diffCheckStatus([L('pending', { ownerId: 'c' })]);   // baseline pending
  diffCheckStatus([L('failing', { ownerId: 'c' })]);   // pending→failing (emits, ignored)
  assert.deepEqual(diffCheckStatus([L('failing', { ownerId: 'c' })]), []); // failing→failing
});

test('failing→passing (recovery) emits', () => {
  diffCheckStatus([L('failing', { ownerId: 'd' })]);   // baseline failing (first appearance, ignored)
  const events = diffCheckStatus([L('passing', { ownerId: 'd' })]);
  assert.equal(events.length, 1);
  assert.equal(events[0].checkStatus, 'passing');
});

test('passing→failing (regression) emits', () => {
  diffCheckStatus([L('passing', { ownerId: 'e' })]);   // baseline passing (ignored)
  const events = diffCheckStatus([L('failing', { ownerId: 'e' })]);
  assert.equal(events.length, 1);
  assert.equal(events[0].checkStatus, 'failing');
});

test('X→pending never emits', () => {
  diffCheckStatus([L('passing', { ownerId: 'f' })]);   // baseline (ignored)
  assert.deepEqual(diffCheckStatus([L('pending', { ownerId: 'f' })]), []);
});

test('task and session links to the same url do not collide (scope in key)', () => {
  const same = (cs, scope) => L(cs, { scope, ownerId: scope === 'task' ? 't1' : 's1', url: 'https://github.com/o/r/pull/9' });
  diffCheckStatus([same('pending', 'task'), same('pending', 'session')]); // baseline both pending
  const events = diffCheckStatus([same('passing', 'task'), same('failing', 'session')]);
  assert.equal(events.length, 2);
  assert.deepEqual(urls(events), ['session:s1:https://github.com/o/r/pull/9', 'task:t1:https://github.com/o/r/pull/9']);
});

test('a brand-new key appearing already-terminal after seed emits on first sight', () => {
  const events = diffCheckStatus([L('passing', { ownerId: 'fresh', url: 'https://github.com/o/r/pull/42' })]);
  assert.equal(events.length, 1);
  assert.equal(events[0].ownerId, 'fresh');
});

test('pending→awaiting-review and pending→changes-requested emit (review states are notifiable)', () => {
  diffCheckStatus([L('pending', { ownerId: 'g' }), L('pending', { ownerId: 'h' })]); // baseline
  const events = diffCheckStatus([L('awaiting-review', { ownerId: 'g' }), L('changes-requested', { ownerId: 'h' })]);
  assert.equal(events.length, 2);
  assert.deepEqual(events.map((e) => e.checkStatus).sort(), ['awaiting-review', 'changes-requested']);
});

test('awaiting-review→passing (review approved → mergeable) emits', () => {
  diffCheckStatus([L('awaiting-review', { ownerId: 'i' })]);   // baseline (first sight, ignored)
  const events = diffCheckStatus([L('passing', { ownerId: 'i' })]);
  assert.equal(events.length, 1);
  assert.equal(events[0].checkStatus, 'passing');
});

test('awaiting-review→awaiting-review does not re-emit (no net transition)', () => {
  diffCheckStatus([L('pending', { ownerId: 'j' })]);             // baseline
  diffCheckStatus([L('awaiting-review', { ownerId: 'j' })]);     // pending→awaiting-review (emits, ignored)
  assert.deepEqual(diffCheckStatus([L('awaiting-review', { ownerId: 'j' })]), []); // stable
});

// prNudgeEnabled: the one definition of "should this session get a PR pane line",
// shared by the three transition plans AND the merged/closed link-removal line.
test('prNudgeEnabled: an explicit per-session choice wins over the install-wide default', () => {
  assert.equal(prNudgeEnabled({ autoFixPrChecks: true }, false), true);
  assert.equal(prNudgeEnabled({ autoFixPrChecks: false }, true), false);
});

test('prNudgeEnabled: a session with no choice follows the default (ON when omitted)', () => {
  assert.equal(prNudgeEnabled({}), true);
  assert.equal(prNudgeEnabled(undefined), true);
  assert.equal(prNudgeEnabled({}, false), false);
  assert.equal(prNudgeEnabled(undefined, false), false);
});

// planCheckTransition: pure gate deciding merge / pane-nudge for one transition.
// ev = { scope, checkStatus }; entry = the owning session's mapping entry (flags).
const ev = (checkStatus, scope = 'session') => ({ scope, checkStatus });

test('auto-merge is OFF by default: a passing session does not merge, but still nudges', () => {
  assert.deepEqual(planCheckTransition(ev('passing'), {}), { merge: false, nudge: true });
  assert.deepEqual(planCheckTransition(ev('passing'), undefined), { merge: false, nudge: true });
  assert.deepEqual(planCheckTransition(ev('passing'), { autoMergeOnPass: false }), { merge: false, nudge: true });
});

test('auto-merge ON merges on a passing session transition and suppresses the duplicate nudge', () => {
  assert.deepEqual(planCheckTransition(ev('passing'), { autoMergeOnPass: true }), { merge: true, nudge: false });
});

test('auto-merge only fires on passing — never on failing/awaiting-review/changes-requested', () => {
  for (const s of ['failing', 'awaiting-review', 'changes-requested']) {
    assert.equal(planCheckTransition(ev(s), { autoMergeOnPass: true }).merge, false, s);
  }
});

test('auto-merge never fires for a task-scope link (no single entry to own the merge)', () => {
  assert.deepEqual(planCheckTransition(ev('passing', 'task'), { autoMergeOnPass: true }), { merge: false, nudge: false });
});

test('auto-fix is ON by default: failing/changes-requested nudge the live session', () => {
  assert.equal(planCheckTransition(ev('failing'), {}).nudge, true);
  assert.equal(planCheckTransition(ev('changes-requested'), undefined).nudge, true);
  assert.equal(planCheckTransition(ev('awaiting-review'), {}).nudge, true);
});

test('auto-fix OFF suppresses every pane nudge (board toast is unaffected — not this gate)', () => {
  for (const s of ['failing', 'passing', 'awaiting-review', 'changes-requested']) {
    assert.equal(planCheckTransition(ev(s), { autoFixPrChecks: false }).nudge, false, s);
  }
});

// The install-wide default (config.json autoFixPrChecksDefault, passed in by the
// poll loop) only applies to a session with NO explicit choice of its own.
test('auto-fix default OFF suppresses the nudge for a session with no explicit choice', () => {
  assert.equal(planCheckTransition(ev('failing'), {}, false).nudge, false);
  assert.equal(planCheckTransition(ev('failing'), undefined, false).nudge, false);
});

test('an explicit per-session auto-fix choice outranks the install-wide default either way', () => {
  assert.equal(planCheckTransition(ev('failing'), { autoFixPrChecks: true }, false).nudge, true);
  assert.equal(planCheckTransition(ev('failing'), { autoFixPrChecks: false }, true).nudge, false);
});

test('auto-fix OFF + auto-merge ON still merges a passing PR (merge is its own gate)', () => {
  assert.deepEqual(planCheckTransition(ev('passing'), { autoFixPrChecks: false, autoMergeOnPass: true }),
    { merge: true, nudge: false });
});

test('a task-scope link never nudges (no single session pane to target)', () => {
  assert.equal(planCheckTransition(ev('failing', 'task'), {}).nudge, false);
});

test('repoFromPrUrl extracts just the repo name (not owner/repo)', () => {
  assert.equal(repoFromPrUrl('https://github.com/PortSwigger/agent-wrangler/pull/42'), 'agent-wrangler');
  assert.equal(repoFromPrUrl('not a url'), '');
});

test('prPaneNudge composes [Agent Wrangler] PR #<n> (<repo>): <phrase>: <url>', () => {
  const url = 'https://github.com/o/agent-wrangler/pull/42';
  assert.equal(prPaneNudge({ number: 42, url, checkStatus: 'failing' }),
    '[Agent Wrangler] PR #42 (agent-wrangler): required checks are now failing: ' + url);
});

test('prPaneNudge omits the (<repo>) segment entirely for an enterprise/malformed url (no bare "()")', () => {
  // repoFromPrUrl only matches github.com, so an enterprise host yields '' — the
  // composition must drop the parenthesised segment rather than emit "PR #7 (): ...".
  const url = 'https://github.example.com/o/internal/pull/7';
  const line = prPaneNudge({ number: 7, url, checkStatus: 'failing' });
  assert.equal(line, '[Agent Wrangler] PR #7: required checks are now failing: ' + url);
  assert.doesNotMatch(line, /\(\)/); // never a bare empty pair
});

test('prPaneNudge does not throw on a null/garbage url and still omits the repo segment', () => {
  assert.doesNotThrow(() => prPaneNudge({ number: 1, url: null, checkStatus: 'passing' }));
  const line = prPaneNudge({ number: 1, url: 'not a url', checkStatus: 'passing' });
  assert.match(line, /^\[Agent Wrangler\] PR #1: all checks passing, mergeable: /);
  assert.doesNotMatch(line, /\(\)/);
});

test('prPaneNudge phrasing per notifiable status is non-instructive and emoji-free', () => {
  const url = 'https://github.com/o/r/pull/1';
  const phrase = (checkStatus) => prPaneNudge({ number: 1, url, checkStatus })
    .replace(`[Agent Wrangler] PR #1 (r): `, '').replace(`: ${url}`, '');
  assert.equal(phrase('failing'), 'required checks are now failing');
  assert.equal(phrase('passing'), 'all checks passing, mergeable');
  assert.equal(phrase('awaiting-review'), 'all checks passing, awaiting review');
  assert.equal(phrase('changes-requested'), 'changes requested on review');
  // no emoji left over from the old prescriptive phrasing
  assert.doesNotMatch(prPaneNudge({ number: 1, url, checkStatus: 'passing' }), /[☀-➿\uD83C-\uDBFF]/);
});

// diffDirty: own transition-detection baseline, independent of diffCheckStatus's.
// link factory: { scope, ownerId, url, number, dirty }.
const D = (dirty, { scope = 'session', ownerId = 's1', url = 'https://github.com/o/r/pull/1', number = 1 } = {}) =>
  ({ scope, ownerId, url, number, dirty });

test('diffDirty: the first call seeds and emits nothing (no replay on restart)', () => {
  assert.deepEqual(diffDirty([D(true), D(true, { ownerId: 's2' })]), []);
});

test('diffDirty: false→true emits; true→true does not re-emit', () => {
  diffDirty([D(false, { ownerId: 'a' })]); // baseline clean
  const events = diffDirty([D(true, { ownerId: 'a' })]);
  assert.equal(events.length, 1);
  assert.equal(events[0].ownerId, 'a');
  assert.deepEqual(diffDirty([D(true, { ownerId: 'a' })]), []); // true→true: no re-emit
});

test('diffDirty: true→false (rebased clean) does not emit', () => {
  diffDirty([D(false, { ownerId: 'b' })]);
  diffDirty([D(true, { ownerId: 'b' })]); // clean→dirty (emits, ignored)
  assert.deepEqual(diffDirty([D(false, { ownerId: 'b' })]), []);
});

test('diffDirty: a brand-new key appearing already dirty emits on first sight', () => {
  const events = diffDirty([D(true, { ownerId: 'fresh', url: 'https://github.com/o/r/pull/42' })]);
  assert.equal(events.length, 1);
  assert.equal(events[0].ownerId, 'fresh');
});

test('diffDirty: task and session links to the same url do not collide (scope in key)', () => {
  const same = (dirty, scope) => D(dirty, { scope, ownerId: scope === 'task' ? 't1' : 's1', url: 'https://github.com/o/r/pull/9' });
  diffDirty([same(false, 'task'), same(false, 'session')]); // baseline both clean
  const events = diffDirty([same(true, 'task'), same(true, 'session')]);
  assert.equal(events.length, 2);
});

test('planDirtyTransition: session scope with autoFixPrChecks ON (default) nudges', () => {
  assert.equal(planDirtyTransition({ scope: 'session' }, {}), true);
  assert.equal(planDirtyTransition({ scope: 'session' }, undefined), true);
});

test('planDirtyTransition: autoFixPrChecks OFF suppresses the nudge', () => {
  assert.equal(planDirtyTransition({ scope: 'session' }, { autoFixPrChecks: false }), false);
});

test('planDirtyTransition: honours the install-wide default, but an explicit choice wins', () => {
  assert.equal(planDirtyTransition({ scope: 'session' }, {}, false), false);
  assert.equal(planDirtyTransition({ scope: 'session' }, { autoFixPrChecks: true }, false), true);
  assert.equal(planDirtyTransition({ scope: 'session' }, { autoFixPrChecks: false }, true), false);
});

test('planDirtyTransition: a task-scope link never nudges (no single session pane to target)', () => {
  assert.equal(planDirtyTransition({ scope: 'task' }, {}), false);
});

test('prDirtyPaneNudge composes [Agent Wrangler] PR #<n> (<repo>): <conflict phrase>: <url>', () => {
  const url = 'https://github.com/o/agent-wrangler/pull/42';
  assert.equal(prDirtyPaneNudge({ number: 42, url }),
    '[Agent Wrangler] PR #42 (agent-wrangler): merge conflicts with the base branch — needs a rebase: ' + url);
});

test('prDirtyPaneNudge omits the (<repo>) segment entirely for an enterprise/malformed url', () => {
  const url = 'https://github.example.com/o/internal/pull/7';
  const line = prDirtyPaneNudge({ number: 7, url });
  assert.equal(line, '[Agent Wrangler] PR #7: merge conflicts with the base branch — needs a rebase: ' + url);
  assert.doesNotMatch(line, /\(\)/);
});

// prLabel/prPaneLine: the shared composition every PR pane line (checks, dirty,
// merged/closed removal, auto-merge outcome) is built from, so they all read
// consistently regardless of which transition produced them.
test('prLabel: PR #<n> (<repo>) when the url matches, bare PR #<n> otherwise', () => {
  assert.equal(prLabel(42, 'https://github.com/o/agent-wrangler/pull/42'), 'PR #42 (agent-wrangler)');
  assert.equal(prLabel(7, 'https://github.example.com/o/internal/pull/7'), 'PR #7');
  assert.equal(prLabel(1, null), 'PR #1');
});

test('prPaneLine composes [Agent Wrangler] <label>: <phrase>: <url>', () => {
  const url = 'https://github.com/o/agent-wrangler/pull/42';
  assert.equal(prPaneLine(42, url, 'merged — link removed'),
    '[Agent Wrangler] PR #42 (agent-wrangler): merged — link removed: ' + url);
});

test('prPaneLine omits the (<repo>) segment entirely for an enterprise/malformed url (no bare "()")', () => {
  const url = 'https://github.example.com/o/internal/pull/7';
  const line = prPaneLine(7, url, 'closed — link removed');
  assert.equal(line, '[Agent Wrangler] PR #7: closed — link removed: ' + url);
  assert.doesNotMatch(line, /\(\)/);
});

// diffUnresolvedComments: own transition-detection baseline, own key space —
// DELIBERATELY no seeded flag (see notifier.js). link factory:
// { scope, ownerId, url, number, unresolvedCount }.
const U = (unresolvedCount, { scope = 'session', ownerId = 's1', url = 'https://github.com/o/r/pull/1', number = 1 } = {}) =>
  ({ scope, ownerId, url, number, unresolvedCount });

test('diffUnresolvedComments: a brand-new key is ALWAYS silently baselined, even already non-zero (no first-sight emit)', () => {
  assert.deepEqual(diffUnresolvedComments([U(5), U(2, { ownerId: 's2' })]), []);
});

test('diffUnresolvedComments: a known key increasing emits with the delta; staying flat does not', () => {
  diffUnresolvedComments([U(2, { ownerId: 'a' })]); // baseline 2
  const events = diffUnresolvedComments([U(5, { ownerId: 'a' })]);
  assert.equal(events.length, 1);
  assert.equal(events[0].delta, 3);
  assert.deepEqual(diffUnresolvedComments([U(5, { ownerId: 'a' })]), []); // flat: no re-emit
});

test('diffUnresolvedComments: a decrease (including down to zero) never emits — forward-only', () => {
  diffUnresolvedComments([U(4, { ownerId: 'b' })]); // baseline
  assert.deepEqual(diffUnresolvedComments([U(1, { ownerId: 'b' })]), []);
  assert.deepEqual(diffUnresolvedComments([U(0, { ownerId: 'b' })]), []);
});

test('diffUnresolvedComments: a brand-new key appearing later (after other keys are known) is still baselined, not emitted', () => {
  diffUnresolvedComments([U(1, { ownerId: 'c' })]); // establishes some baseline state
  const events = diffUnresolvedComments([U(1, { ownerId: 'c' }), U(9, { ownerId: 'fresh', url: 'https://github.com/o/r/pull/42' })]);
  assert.deepEqual(events, []);
  // now that 'fresh' is known, a further increase emits
  const next = diffUnresolvedComments([U(1, { ownerId: 'c' }), U(12, { ownerId: 'fresh', url: 'https://github.com/o/r/pull/42' })]);
  assert.equal(next.length, 1);
  assert.equal(next[0].delta, 3);
});

test('diffUnresolvedComments: task and session links to the same url do not collide (scope in key)', () => {
  const same = (n, scope) => U(n, { scope, ownerId: scope === 'task' ? 't1' : 's1', url: 'https://github.com/o/r/pull/9' });
  diffUnresolvedComments([same(1, 'task'), same(1, 'session')]); // baseline
  const events = diffUnresolvedComments([same(3, 'task'), same(2, 'session')]);
  assert.equal(events.length, 2);
});

test('diffUnresolvedComments: a missing/non-numeric count is skipped entirely — not baselined at 0', () => {
  // Baselining an unknown count at 0 would misread the PR's first SUCCESSFUL
  // fetch (which may return an already-nonzero real count) as a spurious
  // increase — exactly the first-attach notification storm this diff exists
  // to prevent.
  assert.deepEqual(diffUnresolvedComments([U(undefined, { ownerId: 'd' })]), []);
  assert.deepEqual(diffUnresolvedComments([U(undefined, { ownerId: 'd' })]), []);
  // once a real number finally arrives, it's baselined silently (not emitted)
  assert.deepEqual(diffUnresolvedComments([U(4, { ownerId: 'd' })]), []);
  // and NOW increases emit normally
  const events = diffUnresolvedComments([U(6, { ownerId: 'd' })]);
  assert.equal(events.length, 1);
  assert.equal(events[0].delta, 2);
});

test('diffUnresolvedComments: a fetch gap after a real baseline carries the baseline forward, so the increase across the gap still emits', () => {
  // Regression: the skip branch must not just drop the key — dropping it makes
  // the count's next real value look brand-new and silently re-baseline,
  // swallowing a genuine increase that spans the gap.
  diffUnresolvedComments([U(1, { ownerId: 'e' })]);           // baseline 1
  assert.deepEqual(diffUnresolvedComments([U(undefined, { ownerId: 'e' })]), []); // gap: skipped, but 1 carries forward
  const events = diffUnresolvedComments([U(9, { ownerId: 'e' })]); // real value returns
  assert.equal(events.length, 1);
  assert.equal(events[0].delta, 8); // 1 -> 9, not re-baselined at 9
});

test('planUnresolvedTransition: session scope with autoFixPrChecks ON (default) nudges', () => {
  assert.equal(planUnresolvedTransition({ scope: 'session' }, {}), true);
  assert.equal(planUnresolvedTransition({ scope: 'session' }, undefined), true);
});

test('planUnresolvedTransition: autoFixPrChecks OFF suppresses the nudge', () => {
  assert.equal(planUnresolvedTransition({ scope: 'session' }, { autoFixPrChecks: false }), false);
});

test('planUnresolvedTransition: honours the install-wide default, but an explicit choice wins', () => {
  assert.equal(planUnresolvedTransition({ scope: 'session' }, {}, false), false);
  assert.equal(planUnresolvedTransition({ scope: 'session' }, { autoFixPrChecks: true }, false), true);
  assert.equal(planUnresolvedTransition({ scope: 'session' }, { autoFixPrChecks: false }, true), false);
});

test('planUnresolvedTransition: a task-scope link never nudges (no single session pane to target)', () => {
  assert.equal(planUnresolvedTransition({ scope: 'task' }, {}), false);
});

test('prUnresolvedPaneNudge says "thread(s)" (not "comment(s)"), pluralizes correctly, and carries the running total', () => {
  const url = 'https://github.com/o/agent-wrangler/pull/42';
  assert.equal(prUnresolvedPaneNudge({ number: 42, url, delta: 1, unresolvedCount: 1 }),
    '[Agent Wrangler] PR #42 (agent-wrangler): 1 new unresolved review thread (1 unresolved total): ' + url);
  assert.equal(prUnresolvedPaneNudge({ number: 42, url, delta: 3, unresolvedCount: 7 }),
    '[Agent Wrangler] PR #42 (agent-wrangler): 3 new unresolved review threads (7 unresolved total): ' + url);
});

test('prUnresolvedPaneNudge omits the (<repo>) segment entirely for an enterprise/malformed url', () => {
  const url = 'https://github.example.com/o/internal/pull/7';
  const line = prUnresolvedPaneNudge({ number: 7, url, delta: 2, unresolvedCount: 5 });
  assert.equal(line, '[Agent Wrangler] PR #7: 2 new unresolved review threads (5 unresolved total): ' + url);
  assert.doesNotMatch(line, /\(\)/);
});
