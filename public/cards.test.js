import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  STATUS_WORDS, PR_DOT_TITLE,
  linkChipsHtml, sessionCardHtml, devcontainerChip, workerStatusWord, workerRowHtml,
  workflowBoxHtml, renderTileCards, snoozedRowHtml, todoRowHtml, todoZoneHtml,
  tileHtml, ghostHtml, mailBadgeHtml, modelPillHtml,
  visibleSubAgents, SUBAGENT_RECENT_MS, subagentZoneHtml, subagentPillHtml, subagentRowHtml,
  subagentDividerHtml,
} from './cards.js';

// A render context matching app.js `cardCtx()`. Derived-status helpers are the real
// shapes (a status word, a bar affordance, a snooze phase) so the builders exercise
// the same branches they do on the board.
function ctx(over = {}) {
  return {
    selectedSessionId: null,
    selectedNewSlot: null,
    flashingPr: new Set(),
    collapsedWorkflows: new Set(),
    activitySortedTasks: new Set(),
    justFinished: new Set(),
    cardState: (s) => s.status || 'idle',
    barWord: (s) => (s.managed ? (STATUS_WORDS[s.status] || '?') : 'resume'),
    phaseOf: (s) => (s.snooze && s.snooze.until ? 'asleep' : 'awake-none'),
    todosFor: () => [],
    ADHOC_ID: 'adhoc',
    isChildFullView: (s) => Boolean(s.childFullView),
    ...over,
  };
}

const sess = (over = {}) => ({
  sessionId: 's1', label: 'my session', cwd: '/home/me/repo', managed: true,
  status: 'working', agent: 'claude', ...over,
});

test('linkChipsHtml: empty / non-array → empty string', () => {
  assert.equal(linkChipsHtml(null, ctx()), '');
  assert.equal(linkChipsHtml([], ctx()), '');
  assert.equal(linkChipsHtml(undefined, ctx()), '');
});

test('linkChipsHtml: a PR link renders #number, an anchor, and a status dot', () => {
  const html = linkChipsHtml([{ type: 'pr', number: 42, url: 'https://github.com/o/r/pull/42', checkStatus: 'passing' }], ctx());
  assert.match(html, /#42/);
  assert.match(html, /<a class="link-chip"/);
  assert.match(html, /href="https:\/\/github.com\/o\/r\/pull\/42"/);
  assert.match(html, /pr-dot pr-passing/);
  assert.match(html, new RegExp(PR_DOT_TITLE.passing));
});

test('linkChipsHtml: no dot when checkStatus is none/absent', () => {
  assert.doesNotMatch(linkChipsHtml([{ type: 'pr', number: 1, url: 'https://x/pull/1', checkStatus: 'none' }], ctx()), /pr-dot/);
  assert.doesNotMatch(linkChipsHtml([{ type: 'pr', number: 1, url: 'https://x/pull/1' }], ctx()), /pr-dot/);
});

test('linkChipsHtml: flashingPr adds the one-shot alert modifier for that url', () => {
  const url = 'https://x/pull/7';
  const html = linkChipsHtml([{ type: 'pr', number: 7, url, checkStatus: 'failing' }], ctx({ flashingPr: new Set([url]) }));
  assert.match(html, /pr-dot--alert/);
});

test('linkChipsHtml: dirty renders its own dot and takes precedence over checkStatus', () => {
  const html = linkChipsHtml([{ type: 'pr', number: 3, url: 'https://x/pull/3', checkStatus: 'passing', dirty: true }], ctx());
  assert.match(html, /pr-dot pr-dirty/);
  assert.doesNotMatch(html, /pr-passing/);
});

test('linkChipsHtml: jira link uses its key; a non-http url renders as a span, not a link', () => {
  const jira = linkChipsHtml([{ type: 'jira', key: 'ENT-9', url: 'https://jira/ENT-9' }], ctx());
  assert.match(jira, /ENT-9/);
  const unsafe = linkChipsHtml([{ type: 'jira', key: 'ENT-9', url: 'javascript:alert(1)' }], ctx());
  assert.match(unsafe, /<span class="link-chip"/);
  assert.doesNotMatch(unsafe, /<a /);
});

test('sessionCardHtml: escapes label, carries data-sid, marks selection', () => {
  const html = sessionCardHtml(sess({ label: '<x>' }), ctx({ selectedSessionId: 's1' }));
  assert.match(html, /data-sid="s1"/);
  assert.match(html, /&lt;x&gt;/);
  assert.match(html, /session-card [^"]*selected/);
});

test('sessionCardHtml: a slot selection suppresses the card ring', () => {
  const html = sessionCardHtml(sess(), ctx({ selectedSessionId: 's1', selectedNewSlot: 'adhoc' }));
  assert.doesNotMatch(html, /session-card [^"]*\bselected\b/);
});

test('sessionCardHtml: dormant (unmanaged) session gets the dormant class', () => {
  assert.match(sessionCardHtml(sess({ managed: false }), ctx()), /session-card [^"]*dormant/);
});

test('sessionCardHtml: codex cost is prefixed with ~, claude is not', () => {
  assert.match(sessionCardHtml(sess({ agent: 'codex', usd: 1.5 }), ctx()), /~1\.50/);
  assert.match(sessionCardHtml(sess({ agent: 'claude', usd: 1.5 }), ctx()), /(?<!~)1\.50/);
});

test('sessionCardHtml: shows the short model label with a CPU icon only when resolved', () => {
  const known = sessionCardHtml(sess({ modelPill: { label: 'gpt-5.6 sol', title: 'gpt-5.6-sol' } }), ctx());
  const unknown = sessionCardHtml(sess({ modelPill: null }), ctx());
  assert.match(known, /<span class="card-tag model-pill" title="gpt-5\.6-sol"><svg class="icon"[^>]*>[^]*<\/svg><span class="model-pill-label">gpt-5\.6 sol<\/span><\/span>/);
  assert.doesNotMatch(unknown, /model-pill/);
});

test('modelPillHtml: keeps the label in its own truncatable element', () => {
  const html = modelPillHtml({ label: 'an-unrecognised-model-with-a-very-long-id', title: 'raw-model-id' });
  assert.match(html, /<span class="model-pill-label">an-unrecognised-model-with-a-very-long-id<\/span>/);
});

test('sessionCardHtml: long bar word is clipped to 6 chars with a full-text title', () => {
  const html = sessionCardHtml(sess(), ctx({ barWord: () => 'implementing' }));
  assert.match(html, /title="implementing"/);
  assert.match(html, /<span>implem<\/span>/);
});

// The devcontainer bring-up hint (dropped from the focus-mode activity line when we
// adopted main's card redesign) is re-surfaced as a state on the dc chip.
test('devcontainerChip: bring-up (working + waitingFor) shows the starting hint', () => {
  const html = devcontainerChip({ runtime: 'devcontainer', status: 'working', waitingFor: 'starting container' });
  assert.match(html, /runtime-dc--starting/);
  assert.match(html, /⬢ starting container/);
});

test('devcontainerChip: a fatal bring-up failure reads as an alert', () => {
  const html = devcontainerChip({ runtime: 'devcontainer', status: 'needs-you', waitingFor: 'container bring-up failed' });
  assert.match(html, /runtime-dc--failed/);
  assert.match(html, /⬢ bring-up failed/);
});

// A running container: an ordinary working session (no hint) OR a real needs-you
// prompt both stay the plain "⬢ dc" chip — main removed the generic waitingFor line
// and this must not resurrect it for non-bring-up prompts.
test('devcontainerChip: a running container stays the plain dc chip', () => {
  assert.match(devcontainerChip({ runtime: 'devcontainer', status: 'working', waitingFor: null }), /runtime-dc"[^>]*>⬢ dc/);
  assert.match(devcontainerChip({ runtime: 'devcontainer', status: 'needs-you', waitingFor: 'which file?' }), /runtime-dc"[^>]*>⬢ dc/);
});

test('sessionCardHtml: the dc bring-up chip renders on the card meta line for a devcontainer session', () => {
  const html = sessionCardHtml(sess({ runtime: 'devcontainer', status: 'working', waitingFor: 'starting container' }), ctx());
  assert.match(html, /runtime-dc--starting/);
  // A local session never gets a dc chip regardless of status/waitingFor.
  assert.doesNotMatch(sessionCardHtml(sess({ status: 'working', waitingFor: 'starting container' }), ctx()), /runtime-dc/);
});

test('sessionCardHtml: the sub-agent zone nests INSIDE the card, not after it — so it always reads as belonging to this card', () => {
  const s = sess({ subAgents: [{ id: 'r', agentType: 'a', label: 'L', kind: 'background', status: 'running', startedAt: null, endedAt: null, usd: null }] });
  const html = sessionCardHtml(s, ctx({ subagentShown: new Set(['s1']) }));
  const cardOpen = html.indexOf('<div class="session-card');
  const cardClose = html.lastIndexOf('</div>');
  const rowIdx = html.indexOf('data-subagent-id="r"');
  assert.ok(rowIdx > cardOpen && rowIdx < cardClose, 'the row must sit between the card\'s own open and close tags');
});

test('mailBadgeHtml: no unread mail → empty string (no pill at all)', () => {
  assert.equal(mailBadgeHtml(sess({ mail: null })), '');
  assert.equal(mailBadgeHtml(sess({ mail: { unread: 0, notifiedAt: null, amber: false } })), '');
  assert.equal(mailBadgeHtml(sess()), ''); // no `mail` field at all
});

test('mailBadgeHtml: normal unread mail renders the count, no "stale" class', () => {
  const html = mailBadgeHtml(sess({ mail: { unread: 3, notifiedAt: Date.now(), amber: false } }));
  assert.match(html, /class="mail-badge"/);
  assert.doesNotMatch(html, /stale/);
  assert.match(html, />3<\/span>$/);
});

test('mailBadgeHtml: stale (amber) unread mail adds the stale class and swaps to the filled envelope glyph — no background either way', () => {
  const normal = mailBadgeHtml(sess({ mail: { unread: 1, notifiedAt: Date.now(), amber: false } }));
  const stale = mailBadgeHtml(sess({ mail: { unread: 1, notifiedAt: Date.now(), amber: true } }));
  assert.match(stale, /class="mail-badge stale"/);
  assert.doesNotMatch(normal, /fill="currentColor"/); // outline glyph
  assert.match(stale, /fill="currentColor"/); // filled glyph — the shape carries the stale signal, not a background
});

test('mailBadgeHtml: senders ride the tooltip, not the visible count', () => {
  const html = mailBadgeHtml(sess({ mail: { unread: 2, notifiedAt: Date.now(), amber: false, senders: ['sess_abc', 'sess_def'] } }));
  assert.match(html, /title="[^"]*from sess_abc, sess_def[^"]*"/);
  assert.match(html, />2<\/span>$/); // visible text is just the count, session ids never shown as the pill's label
});

test('sessionCardHtml: the mail badge sits on the name row, before the agent icon', () => {
  const html = sessionCardHtml(sess({ mail: { unread: 2, notifiedAt: Date.now(), amber: false } }), ctx());
  assert.match(html, /<div class="card-name-row">[\s\S]*mail-badge[\s\S]*agent-ico[\s\S]*<\/div>/);
});

test('sessionCardHtml: no mail badge when there is no unread mail', () => {
  const html = sessionCardHtml(sess({ mail: { unread: 0, notifiedAt: null, amber: false } }), ctx());
  assert.doesNotMatch(html, /mail-badge/);
});

test('workerRowHtml: a bare amber worker-mail-dot renders only when mail is stale — never for normal unread, never for none', () => {
  assert.doesNotMatch(workerRowHtml(sess({ mail: { unread: 2, notifiedAt: Date.now(), amber: false } }), ctx()), /worker-mail-dot/);
  assert.doesNotMatch(workerRowHtml(sess({ mail: null }), ctx()), /worker-mail-dot/);
  assert.match(workerRowHtml(sess({ mail: { unread: 2, notifiedAt: Date.now(), amber: true } }), ctx()), /worker-mail-dot/);
});

test('snoozedRowHtml: never renders mail, even when the session has stale unread mail (an asleep session not reading mail is not news)', () => {
  const html = snoozedRowHtml({ sessionId: 's1', label: 'z', snooze: { until: Date.now() + 1000 }, mail: { unread: 5, notifiedAt: 1, amber: true } });
  assert.doesNotMatch(html, /mail-badge/);
  assert.doesNotMatch(html, /worker-mail-dot/);
});

test('workerStatusWord: dormant → resume; just-finished → done; else the status word', () => {
  assert.equal(workerStatusWord(sess({ managed: false }), ctx()), 'resume');
  assert.equal(workerStatusWord(sess({ status: 'needs-you' }), ctx()), STATUS_WORDS['needs-you']);
  assert.equal(workerStatusWord(sess({ status: 'idle' }), ctx({ justFinished: new Set(['s1']) })), 'done');
  assert.equal(workerStatusWord(sess({ status: 'working' }), ctx()), 'busy');
});

test('workerRowHtml: carries data-sid and the status word as the dot tooltip, not visible text', () => {
  const html = workerRowHtml(sess({ label: 'w', status: 'working' }), ctx());
  assert.match(html, /worker-row/);
  assert.match(html, /data-sid="s1"/);
  assert.match(html, /worker-dot" title="busy"/);
  assert.doesNotMatch(html, /worker-status/);
});

test('workerRowHtml: renders a trailing worker-ring element as the halo — not row-level outline/box-shadow, which the join line paints over', () => {
  const html = workerRowHtml(sess({ label: 'w', status: 'working' }), ctx());
  assert.match(html, /<span class="worker-ring" aria-hidden="true"><\/span>\s*<\/div>$/);
});

test('workerRowHtml: marks selection like a top-level card, suppressed by a slot selection', () => {
  const selected = workerRowHtml(sess(), ctx({ selectedSessionId: 's1' }));
  assert.match(selected, /worker-row [^"]*selected/);
  const slotted = workerRowHtml(sess(), ctx({ selectedSessionId: 's1', selectedNewSlot: 'adhoc' }));
  assert.doesNotMatch(slotted, /worker-row [^"]*\bselected\b/);
});

test('workerRowHtml: cost renders as a card-tag pill with the dollar icon, matching the full card, codex still gets the ~ prefix', () => {
  const html = workerRowHtml(sess({ usd: 1.5 }), ctx());
  assert.match(html, /<span class="card-tag" title="cost so far">.*1\.50<\/span>/);
  assert.doesNotMatch(html, /worker-cost/);
  const codex = workerRowHtml(sess({ agent: 'codex', usd: 1.5 }), ctx());
  assert.match(codex, /~1\.50/);
});

test('workerRowHtml: no cost pill when usd is absent/zero', () => {
  assert.doesNotMatch(workerRowHtml(sess({ usd: 0 }), ctx()), /card-tag/);
  assert.doesNotMatch(workerRowHtml(sess(), ctx()), /card-tag/);
});

test('workerRowHtml: link chips render alongside the cost pill, inside worker-meta, before the trailing ring', () => {
  const s = sess({ usd: 2, links: [{ type: 'jira', key: 'ENT-9', url: 'https://jira/ENT-9' }] });
  const html = workerRowHtml(s, ctx());
  assert.match(html, /<span class="worker-meta"><span class="card-tag"[^>]*>.*<\/span><span class="card-meta-links">.*ENT-9.*<\/span><\/span>/);
  const metaIdx = html.indexOf('worker-meta');
  const ringIdx = html.indexOf('worker-ring');
  assert.ok(metaIdx > -1 && metaIdx < ringIdx, 'worker-meta must render before the trailing ring');
});

test('workerRowHtml: no links → no card-meta-links span', () => {
  assert.doesNotMatch(workerRowHtml(sess({ links: [] }), ctx()), /card-meta-links/);
  assert.doesNotMatch(workerRowHtml(sess(), ctx()), /card-meta-links/);
});

test('workflowBoxHtml: solo run shows no chevron and no spine', () => {
  const html = workflowBoxHtml(sess({ sessionId: 'orch' }), [], ctx());
  assert.match(html, /wf-count">solo/);
  assert.doesNotMatch(html, /wf-chevron/);
  assert.doesNotMatch(html, /workflow-spine/);
});

test('workflowBoxHtml: workers render a spine; collapsed hides it but keeps the chevron', () => {
  const orch = sess({ sessionId: 'orch' });
  const workers = [sess({ sessionId: 'w1', label: 'w1' }), sess({ sessionId: 'w2', label: 'w2' })];
  const open = workflowBoxHtml(orch, workers, ctx());
  assert.match(open, /wf-count">2 workers/);
  assert.match(open, /workflow-spine/);
  assert.match(open, /▾/);
  const collapsed = workflowBoxHtml(orch, workers, ctx({ collapsedWorkflows: new Set(['orch']) }));
  assert.match(collapsed, /workflow-box collapsed/);
  assert.doesNotMatch(collapsed, /workflow-spine/);
  assert.match(collapsed, /▸/);
});

test('renderTileCards: a worker present under its run is folded into the spine, not drawn flat', () => {
  const orch = sess({ sessionId: 'orch', workflow: { issue: 'ENT-1' } });
  const worker = sess({ sessionId: 'w1', label: 'w1', parentSession: 'orch' });
  const html = renderTileCards([orch, worker], ctx());
  assert.equal(html.match(/data-sid="w1"/g).length, 1); // once, on the spine row
  assert.match(html, /worker-row/);
  assert.match(html, /workflow-box/);
});

test('renderTileCards: an orphan child (its parent absent) falls back to a plain card', () => {
  const worker = sess({ sessionId: 'w1', label: 'w1', parentSession: 'gone' });
  const html = renderTileCards([worker], ctx());
  assert.match(html, /session-card/);
  assert.doesNotMatch(html, /worker-row/);
});

test('renderTileCards: a child of a NON-workflow parent gets a plain always-visible spine, no box/header', () => {
  const parent = sess({ sessionId: 'p1', label: 'reviewed session' });
  const child = sess({ sessionId: 'c1', label: 'review', parentSession: 'p1' });
  const html = renderTileCards([parent, child], ctx());
  assert.equal(html.match(/data-sid="c1"/g).length, 1); // once, on the spine row
  assert.match(html, /worker-row/);
  assert.match(html, /child-spine/);
  assert.doesNotMatch(html, /workflow-box/);
  assert.doesNotMatch(html, /wf-title/); // no "Workflow" header
  assert.doesNotMatch(html, /wf-chevron/); // no collapse toggle
});

test('renderTileCards: a plain parent + spine is wrapped in one .child-group element, not two independent siblings', () => {
  // #grid.focus-mode .task-body is a multi-column CSS grid — two independent
  // top-level siblings land in whatever column auto-placement happens to put
  // them, visibly detaching a parent from its children. The wrapper keeps them
  // one grid item regardless.
  const parent = sess({ sessionId: 'p1', label: 'parent' });
  const child = sess({ sessionId: 'c1', label: 'child', parentSession: 'p1' });
  const html = renderTileCards([parent, child], ctx());
  const groupMatch = html.match(/<div class="child-group" data-sid="p1" draggable="true">([\s\S]*)<\/div>\s*$/);
  assert.ok(groupMatch, 'expected a single .child-group wrapper, carrying the parent\'s data-sid + draggable, around the card + spine');
  assert.match(groupMatch[1], /child-spine/);
  // The card nested inside yields drag/reorder to the wrapper — same split as a
  // workflow box's orchestrator card — so it must not also be independently
  // draggable (double-registering the drag source app.js wires up).
  assert.match(groupMatch[1], /session-card [^"]*" data-sid="p1" draggable="false"/);
});

test('renderTileCards: a workflow run with a live team is wrapped in a .child-group too, and its .workflow-box yields drag to the wrapper', () => {
  const orch = sess({ sessionId: 'orch', workflow: { issue: 'ENT-1' }, teammates: [{ name: 't1', color: 'blue' }] });
  const html = renderTileCards([orch], ctx());
  const groupMatch = html.match(/<div class="child-group" data-sid="orch" draggable="true">([\s\S]*)<\/div>\s*$/);
  assert.ok(groupMatch, 'expected a single .child-group wrapper, carrying the run\'s data-sid + draggable, around the box + team spine');
  assert.match(groupMatch[1], /team-spine/);
  assert.match(groupMatch[1], /workflow-box[^"]*" data-sid="orch" draggable="false"/);
});

test('renderTileCards: a solo parent (no children) is NOT wrapped in a .child-group', () => {
  const parent = sess({ sessionId: 'p1', label: 'parent' });
  const html = renderTileCards([parent], ctx());
  assert.doesNotMatch(html, /child-group/);
});

test('renderTileCards: a chained grandchild is never dropped — nesting is one level deep, so it promotes to its own top-level card', () => {
  const orch = sess({ sessionId: 'orch', workflow: { issue: 'ENT-1' } });
  const worker = sess({ sessionId: 'w1', label: 'w1', parentSession: 'orch' });
  const grandchild = sess({ sessionId: 'gc1', label: 'gc1', parentSession: 'w1' });
  const html = renderTileCards([orch, worker, grandchild], ctx());
  // w1 is absorbed into orch's box (unchanged).
  assert.equal(html.match(/data-sid="w1"/g).length, 1);
  assert.match(html, /workflow-box/);
  // gc1's immediate parent (w1) is itself nested, so gc1 renders as its own
  // top-level card (not a compact worker-row) rather than being silently lost.
  assert.equal(html.match(/data-sid="gc1"/g).length, 1);
  const gc1Row = html.split('\n').find((line) => line.includes('data-sid="gc1"'));
  assert.match(gc1Row, /session-card/);
  assert.doesNotMatch(gc1Row, /worker-row/);
});

test('renderTileCards: a 3-level chain nests the great-grandchild under the (promoted) grandchild\'s own spine', () => {
  const orch = sess({ sessionId: 'orch', workflow: { issue: 'ENT-1' } });
  const worker = sess({ sessionId: 'w1', label: 'w1', parentSession: 'orch' });
  const grandchild = sess({ sessionId: 'gc1', label: 'gc1', parentSession: 'w1' });
  const greatGrandchild = sess({ sessionId: 'ggc1', label: 'ggc1', parentSession: 'gc1' });
  const html = renderTileCards([orch, worker, grandchild, greatGrandchild], ctx());
  // w1/ggc1 render exactly once — folded into a spine, only the compact row
  // carries their data-sid. orch and gc1 are the two top-level parents here
  // (gc1 promoted, plus its own child), so each carries its data-sid on BOTH
  // the wrapper (.workflow-box / .child-group — the drag/reorder unit) and its
  // nested, non-draggable card — the same split, deliberate for both.
  for (const id of ['w1', 'ggc1']) {
    assert.equal(html.match(new RegExp(`data-sid="${id}"`, 'g'))?.length, 1, `${id} should render exactly once`);
  }
  assert.equal(html.match(/data-sid="gc1"/g)?.length, 2, 'gc1 renders on both its .child-group wrapper and its nested card');
  assert.match(html, /child-spine/); // ggc1 nests under gc1's own plain spine
});

test('renderTileCards: a "full view" child (ctx.isChildFullView) draws a real .session-card in the spine, not a .worker-row', () => {
  const parent = sess({ sessionId: 'p1', label: 'parent' });
  const child = sess({ sessionId: 'c1', label: 'full child', parentSession: 'p1', childFullView: true });
  const html = renderTileCards([parent, child], ctx());
  assert.equal(html.match(/data-sid="c1"/g).length, 1); // once, on the spine's own card
  assert.match(html, /spine-full-row/);
  assert.match(html, /child-spine/);
  const c1Row = html.split('\n').find((line) => line.includes('data-sid="c1"'));
  assert.match(c1Row, /session-card/);
  assert.doesNotMatch(c1Row, /worker-row/);
  // Non-draggable — the enclosing .child-group is the actual drag unit.
  assert.match(c1Row, /session-card [^"]*" data-sid="c1" draggable="false"/);
});

test('renderTileCards: a full-view child falls back to a compact row via the server-wide default when no per-session override is set', () => {
  const parent = sess({ sessionId: 'p1', label: 'parent' });
  const child = sess({ sessionId: 'c1', label: 'child', parentSession: 'p1' }); // no childFullView field
  const byDefault = renderTileCards([parent, child], ctx({ isChildFullView: () => true }));
  assert.match(byDefault, /spine-full-row/);
  const byDefaultOff = renderTileCards([parent, child], ctx({ isChildFullView: () => false }));
  assert.doesNotMatch(byDefaultOff, /spine-full-row/);
  assert.match(byDefaultOff, /worker-row/);
});

test('workflowBoxHtml: a full-view worker draws in the workflow spine too, wrapped the same way', () => {
  const orch = sess({ sessionId: 'orch' });
  const workers = [sess({ sessionId: 'w1', label: 'w1', childFullView: true }), sess({ sessionId: 'w2', label: 'w2' })];
  const html = workflowBoxHtml(orch, workers, ctx());
  assert.match(html, /workflow-spine/);
  assert.match(html, /spine-full-row/);
  const w1Row = html.split('\n').find((line) => line.includes('data-sid="w1"'));
  assert.match(w1Row, /session-card/);
  const w2Row = html.split('\n').find((line) => line.includes('data-sid="w2"'));
  assert.match(w2Row, /worker-row/);
});

test('snoozedRowHtml: greyed name-only row with a wake button and data-sid', () => {
  const html = snoozedRowHtml(sess({ snooze: { until: Date.now() + 3600_000 } }));
  assert.match(html, /snoozed-row/);
  assert.match(html, /data-sid="s1"/);
  assert.match(html, /snooze-wake/);
});

test('todoRowHtml / todoZoneHtml: rows escape text; empty zone is just the anchor', () => {
  const row = todoRowHtml({ id: 't1', text: '<b>do</b>' }, 'adhoc');
  assert.match(row, /data-todoid="t1"/);
  assert.match(row, /&lt;b&gt;do&lt;\/b&gt;/);
  assert.equal(todoZoneHtml([], 'adhoc'), '<div class="todo-zone" data-todo-key="adhoc"></div>');
  const zone = todoZoneHtml([{ id: 't1', text: 'x' }], 'adhoc');
  assert.match(zone, /todo-divider/);
  assert.match(zone, /data-todoid="t1"/);
});

test('tileHtml: placeholder tile renders a bare placeholder div', () => {
  assert.match(tileHtml({ kind: 'placeholder', col: 0, rowStart: 0, span: 1 }, ctx()), /task-placeholder/);
});

test('tileHtml: notask tile is the Unassigned cell and reads todos from ADHOC_ID', () => {
  let askedFor = null;
  const c = ctx({ todosFor: (k) => { askedFor = k; return []; } });
  const html = tileHtml({ kind: 'notask', col: 0, rowStart: 0, span: 1, sessions: [] }, c);
  assert.match(html, /task-cell no-task/);
  assert.match(html, /Unassigned/);
  assert.equal(askedFor, 'adhoc');
});

test('tileHtml: task tile shows the escaped name, its first link and a +N overflow', () => {
  const tile = {
    kind: 'task', col: 0, rowStart: 0, span: 1, sessions: [],
    task: { id: 'T1', name: 'My <task>', links: [
      { type: 'jira', key: 'ENT-1', url: 'https://j/ENT-1' },
      { type: 'pr', number: 2, url: 'https://x/pull/2' },
    ] },
  };
  const html = tileHtml(tile, ctx());
  assert.match(html, /data-taskid="T1"/);
  assert.match(html, /My &lt;task&gt;/);
  assert.match(html, /ENT-1/);
  assert.match(html, /link-overflow[^>]*>\+1/);
});

test('tileHtml: carries the restored-task halo class only when this tile is the just-restored task', () => {
  const tile = { kind: 'task', col: 0, rowStart: 0, span: 1, sessions: [], task: { id: 'T1', name: 'T', links: [] } };
  assert.match(tileHtml(tile, ctx({ restoredTaskId: 'T1' })), /task-cell task-restored-flash"/);
  assert.doesNotMatch(tileHtml(tile, ctx({ restoredTaskId: 'T2' })), /task-restored-flash/);
  assert.doesNotMatch(tileHtml(tile, ctx()), /task-restored-flash/);
});

test('tileHtml: both tile kinds carry the actions kebab (sort/focus/minimise/memory/delete now live in its menu)', () => {
  const task = { kind: 'task', col: 0, rowStart: 0, span: 1, sessions: [], task: { id: 'T1', name: 'T', links: [] } };
  const notask = { kind: 'notask', col: 0, rowStart: 0, span: 1, sessions: [] };
  assert.match(tileHtml(task, ctx()), /task-actions-btn"/);
  assert.match(tileHtml(notask, ctx()), /task-actions-btn"/);
});

test('tileHtml: asleep sessions sink under a snoozed divider', () => {
  const tile = {
    kind: 'task', col: 0, rowStart: 0, span: 1,
    sessions: [sess({ sessionId: 'a', snooze: { until: 1 } })],
    task: { id: 'T1', name: 'T', links: [] },
  };
  const html = tileHtml(tile, ctx());
  assert.match(html, /snooze-divider/);
  assert.match(html, /snoozed-row/);
});

test('ghostHtml: an empty grid cell renders the new-task drop target', () => {
  assert.match(ghostHtml({ col: 1, row: 2 }), /new-task-drop/);
  assert.match(ghostHtml({ col: 1, row: 2 }), /grid-column:2; grid-row:3;/);
});

const NOW = 1_000_000_000_000;
const mkSa = (o) => ({ id: o.id || 'x', agentType: o.agentType || 'a', label: o.label || 'L', kind: o.kind || 'background', status: o.status || 'completed', startedAt: null, endedAt: o.endedAt ?? null, usd: o.usd ?? null });

test('visibleSubAgents default (Active): running OR finished within RECENT_MS', () => {
  const list = [
    mkSa({ id: 'run', status: 'running' }),
    mkSa({ id: 'recent', status: 'completed', endedAt: NOW - 60_000 }),
    mkSa({ id: 'old', status: 'completed', endedAt: NOW - SUBAGENT_RECENT_MS - 1 }),
    mkSa({ id: 'legacy', kind: 'legacy', status: 'completed', endedAt: NOW - SUBAGENT_RECENT_MS - 1 }),
  ];
  const ids = visibleSubAgents(list, { showFinished: false, now: NOW }).map((a) => a.id);
  assert.deepEqual(ids, ['run', 'recent']);
});

test('visibleSubAgents showFinished reveals everything including old + legacy', () => {
  const list = [mkSa({ id: 'old', status: 'completed', endedAt: NOW - 1e9 }), mkSa({ id: 'legacy', kind: 'legacy', endedAt: null })];
  assert.equal(visibleSubAgents(list, { showFinished: true, now: NOW }).length, 2);
});

test('visibleSubAgents tolerates null/undefined', () => {
  assert.deepEqual(visibleSubAgents(null, { showFinished: false, now: NOW }), []);
});

test('visibleSubAgents: reverse-chronological — running first (no matter how old it started), then most-recently-finished', () => {
  const list = [
    mkSa({ id: 'finished-earlier', status: 'completed', endedAt: NOW - 1000 }),
    mkSa({ id: 'running', status: 'running', startedAt: NOW - 1e9 }),
    mkSa({ id: 'finished-later', status: 'completed', endedAt: NOW - 500 }),
  ];
  const ids = visibleSubAgents(list, { showFinished: true, now: NOW }).map((a) => a.id);
  assert.deepEqual(ids, ['running', 'finished-later', 'finished-earlier']);
});

test('subagentZoneHtml renders nothing when the card is not toggled shown', () => {
  const s = { sessionId: 'c1', subAgents: [mkSa({ id: 'r', status: 'running' })] };
  assert.equal(subagentZoneHtml(s, { subagentShown: new Set(), now: NOW }), '');
});

test('subagentZoneHtml renders nothing when shown but the Active filter is empty', () => {
  const s = { sessionId: 'c1', subAgents: [mkSa({ status: 'completed', endedAt: NOW - 1e9 })] };
  assert.equal(subagentZoneHtml(s, { subagentShown: new Set(['c1']), now: NOW }), '');
});

test('subagentZoneHtml rows carry data-subagent-id and NOT data-sid, once shown, with no redundant heading', () => {
  const s = { sessionId: 'c1', subAgents: [mkSa({ id: 'r', status: 'running' })] };
  const html = subagentZoneHtml(s, { subagentShown: new Set(['c1']), now: NOW });
  assert.doesNotMatch(html, /subagent-divider/);
  assert.match(html, /data-subagent-id="r"/);
  assert.match(html, /data-owner-sid="c1"/);
  assert.doesNotMatch(html, /data-sid=/);
});

test('subagentZoneHtml only ever shows the Active filter — old rows never appear even when shown', () => {
  const s = { sessionId: 'c1', subAgents: [mkSa({ id: 'old', status: 'completed', endedAt: NOW - 1e9 })] };
  assert.equal(subagentZoneHtml(s, { subagentShown: new Set(['c1']), now: NOW }), '');
});

test('subagentPillHtml: no sub-agents → empty; reflects the show/hide toggle when active', () => {
  assert.equal(subagentPillHtml({ sessionId: 'c1', subAgents: [] }, { subagentShown: new Set() }), '');
  const s = { sessionId: 'c1', subAgents: [mkSa({ status: 'running' })] };
  const hidden = subagentPillHtml(s, { subagentShown: new Set(), now: NOW });
  assert.doesNotMatch(hidden, /showing/);
  assert.doesNotMatch(hidden, /disabled/);
  const shown = subagentPillHtml(s, { subagentShown: new Set(['c1']), now: NOW });
  assert.match(shown, /class="card-tag subagent-pill showing"/);
});

test('subagentPillHtml: label is active\\/total', () => {
  const s = { sessionId: 'c1', subAgents: [mkSa({ id: 'a', status: 'running' }), mkSa({ id: 'b', status: 'completed', endedAt: NOW - 1e9 })] };
  assert.match(subagentPillHtml(s, { subagentShown: new Set(), now: NOW }), />1\/2</);
});

test('subagentPillHtml: disabled (and never "showing") when nothing is currently active', () => {
  const s = { sessionId: 'c1', subAgents: [mkSa({ status: 'completed', endedAt: NOW - 1e9 })] };
  const html = subagentPillHtml(s, { subagentShown: new Set(['c1']), now: NOW });
  assert.match(html, /<button class="card-tag subagent-pill" aria-disabled="true"/);
  assert.match(html, />0\/1</);
});

test('subagentRowHtml shows the label and cost when present; status reads off the dot alone, no verbal word', () => {
  const html = subagentRowHtml(mkSa({ id: 'r', label: 'my agent', agentType: 'general-purpose', status: 'running', usd: 0.42 }), 'c1');
  assert.match(html, /my agent/);
  assert.match(html, /\$0\.42/);
  assert.doesNotMatch(html, />run</);
  assert.doesNotMatch(html, />done</);
  assert.match(html, /class="subagent-agent-icon" title="general-purpose"/);
  assert.match(html, /class="subagent-dot" title="running"/);
});

test('subagentDividerHtml carries the label and any extra control passed in', () => {
  assert.match(subagentDividerHtml(), /subagent-label/);
  assert.match(subagentDividerHtml('<button id="x"></button>'), /<button id="x">/);
});
