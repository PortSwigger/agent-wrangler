import { latestHistory, latestTasks, send, setPendingSelect } from './app.js';
import { toast } from './toast.js';
import { openFork } from './modals.js';
import { groupHistory, fmtDuration, filterHistory } from './history-group.js';
import { isWorkflowRun } from './workflow.js';
import { WORKFLOW_ICON } from './icons.js';
import { esc, timeAgo, truncate } from './util.js';

// Current History filter text. Module-scoped (not in the DOM) so it survives the
// full-innerHTML re-render renderHistory() does on every graph push.
let histQuery = '';

// Called when the History view is left (setView in app.js) so a stale filter —
// and a scrolled-open "Show older" pagination — don't carry over into the next visit.
export function resetHistorySearch() {
  histQuery = '';
  weeksShown = 0;
}

// One-shot: set by app.js (setView) so switching to History focuses the filter
// input on the next render. Stays armed across the empty-state render (which has
// no input yet) so a deep-link reload lands focus once the first graph populates.
let focusPending = false;
export function requestHistorySearchFocus() { focusPending = true; }

// The History view: archived sessions grouped by elapsed-time bucket then task.
// Pure rendering + its own action wiring; the session-action side (archive,
// post-archive toast) stays in app.js since it's driven from the board too.

function fmtWhen(ms) {
  if (!ms) return '—';
  const rel = timeAgo(ms);
  return `${new Date(ms).toLocaleString()}${rel ? ` · ${rel}` : ''}`;
}
function histDesc(h) {
  if (h.label && h.label.trim()) return h.label.trim();
  if (h.name && h.name.trim()) return h.name.trim();
  if (h.intent && h.intent.trim()) return h.intent.trim();
  if (h.cwd) return h.cwd.split('/').slice(-1)[0];
  return h.sessionId.slice(0, 8);
}
// One archived-session card: status stripe + body (desc/model, optional
// "was:" note for a deleted task, dir, meta row) + stacked actions. `wf` shows a
// small workflow badge by the desc (a solo autopilot run with no boxed worker);
// `orchestrator` tints the card frame violet as the lead of a History workflow box.
function histCard(h, { wf = false, orchestrator = false } = {}) {
  const sid = esc(h.sessionId);
  const model = h.model ? `<span class="chip model">${esc(h.model)}</span>` : '';
  const wfBadge = wf
    ? `<span class="hc-wf-badge" title="Autopilot workflow run">${WORKFLOW_ICON}</span>`
    : '';
  const was = h.wasName
    ? `<div class="hc-was">was: <b>${esc(h.wasName)}</b> (deleted)</div>`
    : '';
  const dur = fmtDuration(h.archivedAt && h.createdAt ? h.archivedAt - h.createdAt : 0);
  const meta = [
    `<span title="${esc(fmtWhen(h.archivedAt))}">${esc(timeAgo(h.archivedAt) || '—')}</span>`,
    dur ? `<span>ran ${esc(dur)}</span>` : '',
    `<span>${sid.slice(0, 8)}</span>`,
  ].filter(Boolean).join('<span class="sep">·</span>');
  return `<div class="hc${orchestrator ? ' wf-orchestrator' : ''}" data-sid="${sid}">
      <div class="hc-stripe"></div>
      <div class="hc-body">
        <div class="hc-row1">${wfBadge}<div class="hc-desc">${esc(histDesc(h))}</div>${model}</div>
        ${was}
        <div class="hc-dir">📁 ${esc(h.cwd || '—')}</div>
        <div class="hc-meta">${meta}</div>
      </div>
      <div class="hc-acts">
        <button class="hist-resume" data-sid="${sid}" title="Resume">↩</button>
        <button class="hist-fork" data-sid="${sid}" title="Fork into a new session">⑂</button>
        <button class="hist-remove" data-sid="${sid}" title="Delete permanently">🗑</button>
      </div>
    </div>`;
}

// Kinds the workflow_phase MCP tool can stamp; anything else (or absent) reads as
// neutral. Each tints the outcome chip via its own CSS class (semantic theme vars).
const OUTCOME_KINDS = new Set(['neutral', 'active', 'warning', 'success', 'danger']);
function outcomeClass(kind) {
  return OUTCOME_KINDS.has(kind) ? `wf-outcome--${kind}` : 'wf-outcome--neutral';
}

// A History workflow box: the violet board classes (.workflow-box/.workflow-head/
// .wf-*) for visual parity, headed by the issue + an outcome chip tinted by the
// orchestrator's last phase + worker count + a collapse chevron, then the
// orchestrator's histCard (accented) and its workers' full histCards (so
// Resume/Fork/Delete work on each). The header collapses just the workers.
function histWorkflowBox(unit) {
  const orch = unit.orch;
  const sid = esc(orch.sessionId);
  const n = unit.workers.length;
  const collapsed = collapsedHistWorkflows.has(orch.sessionId);
  const issue = unit.issue ? `<span class="wf-issue">${esc(unit.issue)}</span>` : '';
  const outcome = unit.outcome && unit.outcome.label && String(unit.outcome.label).trim()
    ? `<span class="wf-outcome ${outcomeClass(unit.outcome.kind)}">${esc(String(unit.outcome.label).trim())}</span>`
    : '';
  const count = `${n} worker${n > 1 ? 's' : ''}`;
  const chevron = `<span class="wf-chevron">${collapsed ? '▸' : '▾'}</span>`;
  const head = `<div class="workflow-head" role="button" tabindex="0" title="${collapsed ? 'Show workers' : 'Hide workers'}">
      <span class="wf-ico">${WORKFLOW_ICON}</span>
      <span class="wf-title">Workflow</span>
      ${issue}${outcome}
      <span class="wf-spacer"></span>
      <span class="wf-count">${esc(count)}</span>
      ${chevron}
    </div>`;
  const workers = collapsed
    ? ''
    : `<div class="hist-wf-workers">${unit.workers.map((w) => histCard(w)).join('')}</div>`;
  return `<div class="workflow-box hist-wf${collapsed ? ' collapsed' : ''}" data-sid="${sid}">
      ${head}
      ${histCard(orch, { wf: true, orchestrator: true })}
      ${workers}
    </div>`;
}

// A generic nested-child stack (e.g. an archived review under its reviewed
// session): the parent's full histCard immediately followed by an
// always-visible stack of its children's full histCards, each independently
// resumable. No wrapping box, header, chevron, or accent tint — nesting reads
// from position + the neutral connector alone (see styles.css .hist-children),
// mirroring the board's plain child spine.
function histChildStack(unit) {
  return histCard(unit.session, { wf: isWorkflowRun(unit.session) })
    + `<div class="hist-children">${unit.children.map((c) => histCard(c)).join('')}</div>`;
}

// Render one tile render-unit: a folded workflow box, a folded generic child
// stack, or a loose archived card (badged when it's a solo autopilot run).
function renderUnit(u) {
  if (u.kind === 'workflow') return histWorkflowBox(u);
  if (u.kind === 'children') return histChildStack(u);
  return histCard(u.session, { wf: isWorkflowRun(u.session) });
}

// History-local collapse state for workflow boxes — a personal "fold the workers
// away" cue, persisted to localStorage. Separate from the board's set (different
// view, different key); keyed on the orchestrator's sessionId, like the board.
const COLLAPSED_HIST_WF_KEY = 'wrangler.collapsedHistoryWorkflows';
const collapsedHistWorkflows = (() => {
  try { return new Set(JSON.parse(localStorage.getItem(COLLAPSED_HIST_WF_KEY)) || []); } catch { return new Set(); }
})();
function toggleHistWorkflowCollapse(sessionId) {
  if (collapsedHistWorkflows.has(sessionId)) collapsedHistWorkflows.delete(sessionId);
  else collapsedHistWorkflows.add(sessionId);
  try { localStorage.setItem(COLLAPSED_HIST_WF_KEY, JSON.stringify([...collapsedHistWorkflows])); } catch {}
  renderGrid();
}

// How many of the older (per-week) buckets are currently revealed. Starts at 0 —
// the initial view is just the ≤1-week buckets, which is the whole point: laying
// out all ~500 archived cards at once cost ~300ms, and the bulk of them are
// older. "Show older" reveals the next week (renderGrid). Reset on leaving the
// view (resetHistorySearch) so a fresh visit starts collapsed; a live filter
// ignores it entirely and shows every match, since search spans all of history.
let weeksShown = 0;

export function renderHistory() {
  const el = document.getElementById('history');
  if (!latestHistory.length) {
    el.innerHTML = `<div class="hist-empty">No archived sessions yet. Archiving a session from the board stops its process and moves it here, where you can resume it later.</div>`;
    return;
  }
  // Rebuild the shell (header + input + empty grid container) only on a full
  // render. Typing re-renders just the grid (renderGrid) so the input element is
  // never destroyed mid-keystroke; a background graph push does rebuild the input,
  // so preserve focus + caret across that path.
  const prev = document.activeElement;
  const wasFocused = prev && prev.id === 'hist-search';
  const prevScrollTop = el.scrollTop;

  el.innerHTML = `
    <div class="hist-head"><h2>History</h2>
      <input id="hist-search" class="hist-search" type="search" placeholder="🔍 Filter sessions…" autocomplete="off" />
      <span id="hist-count" class="hist-count"></span>
    </div>
    <div id="hist-grid"></div>`;

  const search = document.getElementById('hist-search');
  search.value = histQuery;
  if (wasFocused || focusPending) {
    focusPending = false;
    search.focus();
    const n = search.value.length;
    search.setSelectionRange(n, n);
  }
  search.addEventListener('input', (e) => {
    histQuery = e.target.value;
    renderGrid();
  });
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); histQuery = ''; search.value = ''; renderGrid(); search.blur(); }
  });

  renderGrid();
  el.scrollTop = prevScrollTop;
}

// One time-bucket: its header (label + count) followed by the task-tile grid.
function bucketHtml(g) {
  return `<div class="hist-bucket"><span>${esc(g.label)}</span><span class="rule"></span><span class="n">${g.count}</span></div>
        <div class="hist-cols">
          ${g.tiles
            .map(
              (t) => `<div class="hist-tile">
            <div class="hist-tile-head"><span class="badge${t.unassigned ? ' unassigned' : ''}">${
                t.unassigned ? '' : '▦ '
              }${esc(t.taskName)}</span><span class="n">${t.count}</span></div>
            <div class="hist-stack">${t.units.map(renderUnit).join('')}</div>
          </div>`
            )
            .join('')}
        </div>`;
}

// Rebuild just the bucket/tile/card grid + the count badge from the current
// filter. Called on every keystroke (the input element is left untouched) and
// once per full renderHistory().
function renderGrid() {
  const grid = document.getElementById('hist-grid');
  if (!grid) return;
  const filtered = filterHistory(latestHistory, histQuery);
  const groups = groupHistory(filtered, latestTasks, Date.now());
  const q = histQuery.trim();
  const countEl = document.getElementById('hist-count');
  if (countEl) countEl.textContent = q ? `${filtered.length} of ${latestHistory.length}` : `${latestHistory.length} archived`;

  if (!groups.length) {
    grid.innerHTML = `<div class="hist-empty">No sessions match your filter.</div>`;
    return;
  }

  // A filter spans all of history, so show every match (older included) and drop
  // the pager. Otherwise render the recent buckets plus the first `weeksShown`
  // older weeks, gating the heavy tail behind "Show older" so it isn't laid out
  // up front. groups is ordered recent-first then weeks ascending, so a prefix
  // slice is exactly "recent + the N oldest-revealed weeks".
  const olderGroups = groups.filter((g) => g.older);
  const recentCount = groups.length - olderGroups.length;
  const shownOlder = q ? olderGroups.length : Math.min(weeksShown, olderGroups.length);
  const visible = q ? groups : groups.slice(0, recentCount + shownOlder);

  let html = visible.map(bucketHtml).join('');
  const hiddenOlder = olderGroups.slice(shownOlder);
  if (!q && hiddenOlder.length) {
    // Styled like the bucket separators it sits between (rule + label rhythm),
    // but the label itself is a pill button so it still reads as an action.
    const remaining = hiddenOlder.reduce((n, g) => n + g.count, 0);
    html += `<div class="hist-bucket hist-bucket--more">
      <span class="rule"></span>
      <button class="hist-show-older" type="button">Show older ↓</button>
      <span class="n">${remaining} older session${remaining > 1 ? 's' : ''}</span>
      <span class="rule"></span>
    </div>`;
  }
  grid.innerHTML = html;

  grid.querySelectorAll('.hist-resume').forEach((b) =>
    b.addEventListener('click', () => {
      // Jump to the session once the resume round-trip puts it back on the board.
      setPendingSelect(b.dataset.sid);
      send({ type: 'resume', sessionId: b.dataset.sid });
      toast('Resuming…');
    }));
  grid.querySelectorAll('.hist-fork').forEach((b) =>
    b.addEventListener('click', () => openFork(b.dataset.sid)));
  grid.querySelectorAll('.hist-remove').forEach((b) =>
    b.addEventListener('click', () => {
      const h = latestHistory.find((x) => x.sessionId === b.dataset.sid);
      if (confirm(`Permanently remove "${truncate(histDesc(h || { sessionId: b.dataset.sid }), 60)}"?\n\nThis deletes its record for good — it can no longer be resumed.`)) {
        send({ type: 'remove', sessionId: b.dataset.sid });
        toast('Removed');
      }
    }));
  // Clicking a workflow box header folds its worker cards away (and back).
  // Keyboard-operable since the head is role=button; the box's own data-sid is
  // the orchestrator's, so collapse state keys on it.
  grid.querySelectorAll('.hist-wf .workflow-head').forEach((head) => {
    const sid = head.closest('.workflow-box')?.dataset.sid;
    if (!sid) return;
    head.addEventListener('click', () => toggleHistWorkflowCollapse(sid));
    head.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleHistWorkflowCollapse(sid); }
    });
  });
  // "Show older" reveals the next older week. The hidden weeks' cards were never
  // in the DOM, which is what keeps first paint cheap; each click renders one more.
  const showOlder = grid.querySelector('.hist-show-older');
  if (showOlder) showOlder.addEventListener('click', () => { weeksShown += 1; renderGrid(); });
}

// `/` focuses the History filter — but only when History is the visible view, no
// modal/overlay is open, and the user isn't already typing in a field.
document.addEventListener('keydown', (e) => {
  if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
  const history = document.getElementById('history');
  const main = document.querySelector('main');
  if (!history || history.classList.contains('hidden')) return;
  if (main && main.classList.contains('maximized')) return;
  const tgt = e.target;
  if (tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA' || tgt.isContentEditable)) return;
  const modalOpen = [...document.querySelectorAll('#modal, #find-modal, #fork-modal, #memory-modal, #snooze-modal, #schedules-modal, #confirm-modal')]
    .some((m) => !m.classList.contains('hidden'));
  if (modalOpen) return;
  const search = document.getElementById('hist-search');
  if (!search) return;
  e.preventDefault();
  search.focus();
  search.select();
});
