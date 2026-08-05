/* global Terminal, FitAddon, WebLinksAddon, ClipboardAddon, Unicode11Addon */
import {
  snoozePhase, resolveUntil, wakeLabel, tileWeight,
  toDatetimeLocalValue, parseDatetimeLocal, customSnoozeValid, snoozeSetMessage,
} from './snooze.js';
import { todoKeyToTaskId, tooltipPosition, TOOLTIP_MARGIN_PX } from './todo.js';
import {
  MAX_ONSCREEN_ROWS,
  sessionsPerRow, columnsForWidth, rowSpan, computeLayout, orderSessions, sortByLastActivity, sortAsleepLast, tileSpan,
  localSwapPlacement, visibleTileIds, pruneMinimised, expandFocusToMinimised,
} from './layout.js';
import { workflowPhaseLabel, isWorkflowRun, isWorkflowWorker, computeAbsorption } from './workflow.js';
import { complementaryModel, REVIEW_PROMPT, reviewDispatchOpts } from './review.js';
import { cascadeSummary, cascadeDialogBody, worktreeStillInUse, containerStillInUse } from './archive-cascade.js';
import { attachCandidates, nestingDepth, orderAttachCandidates } from './attach-picker.js';
import { compileWhen, parseWhen, whenValid, cadenceSummary, formatNextRun, actionSummary } from './schedules.js';
import { groupHistory, fmtDuration } from './history-group.js';
import {
  TERMINAL_ICON, ROBOT_ICON, PENCIL_ICON, X_ICON, FORK_ICON, MEMORY_ICON, KEBAB_ICON, FOCUS_ICON,
  MAXIMIZE_ICON, MINIMIZE_ICON, MINIMISE_ICON, ARCHIVE_ICON, RESTART_ICON, CLOCK_ICON, BELL_ICON, DOLLAR_ICON, WAKE_ICON, MOON_ICON, PROMOTE_ICON, ATTACH_ICON, CHEVRON_RIGHT_ICON,
  CHECK_ICON, SPAWN_ICON, PLUS_ICON, MINUS_ICON, FILTER_ICON, SORT_ICON,
  agentIcon, JIRA_ICON, PR_ICON, GITHUB_ICON, WORKFLOW_ICON, DIFF_ICON,
} from './icons.js';
import {
  TERM_FONT_SIZES, DEFAULT_TERM_FONT_SIZE, normalizeFontSize,
} from './term-font.js';
import {
  wtSlug, truncate, esc, tildify, timeAgo, throbDelayStyle, pad2,
  repoRoot, branchBadge, mostCommonCwd as mostCommonCwdPure,

} from './util.js';
import { STATUS_WORDS, linkChipsHtml, tileHtml, ghostHtml, visibleSubAgents, subagentRowHtml, subagentDividerHtml } from './cards.js';
import { readTerminalTheme, setCustomStyles, onThemeChange, initStyles, renderThemeRows, selectStyle } from './theme.js';
import { toast } from './toast.js';
import { showSystemBanner, hideSystemBanner } from './system-banner.js';
import { openFork, openCustomSnooze, onResumable, openMemory, onMemory, onMemoryChanged } from './modals.js';
import { openFilePreview } from './file-preview.js';
import { createMarkdownLinkProvider } from './term-links.js';
import { createPrLinkProvider } from './pr-links.js';
import { renderHistory, resetHistorySearch, requestHistorySearchFocus } from './history.js';
import { openDiffPanel, toggleDiffPanel, closeDiffPanel, isDiffPanelOpen, diffPanelSessionId, onDiff, onDiffCommentsResult, setDiffFullscreen } from './diff-view.js';
import { openUsagePanel, onUsage } from './usage.js';
import { initSettings, getSetting } from './settings.js';

let currentView = 'grid';

// Mac-style glyphs for the board's Ctrl+Cmd+<key> shortcut family (see the
// window keydown listener near moveSessionFocus) — shown as trailing hints in
// the Actions dropdown and button tooltips, so each binding's letter lives in
// one place instead of being duplicated across every place it's displayed.
const kbd = (glyph) => `<span class="kbd-hint">${glyph}</span>`;
const KBD_TERMINAL = kbd('⌃⌘T');
const KBD_FORK = kbd('⌃⌘B'); // "Branch" — Ctrl+Cmd+F collides with macOS/Chrome's own Enter Full Screen
const KBD_RESTART = kbd('⌃⌘R');
const KBD_PEER_REVIEW = kbd('⌃⌘P'); // freed R for Restart; peer review moved here
const KBD_MAXIMIZE = '⌃⌘M'; // plain text: used inside a button `title` tooltip, not menu HTML
const KBD_SNOOZE = kbd('⌃⌘S');
const KBD_DIFF = kbd('⌃⌘G');
// Keys recognized by the Ctrl+Cmd board-shortcut family below — one list so
// the key filter and the swallow-inside-xterm list (attachCustomKeyEventHandler)
// can't drift apart silently.
const CTRL_CMD_KEYS = new Set(['n', 'delete', 'backspace', 't', 'b', 'r', 'p', 'm', 's', 'g']);

const MIN_KEY = 'aw.minimisedTaskIds';
const LEGACY_FOCUS_KEY = 'aw.focusedTaskId';
// The set of minimised tile ids (task ids or ADHOC_ID). Focus is not a separate
// state: a "focused" task is simply the only one NOT in this set. Persisted as a
// JSON array; a legacy single-value focus is migrated on the first render that
// knows the task list (see renderGrid).
let minimisedIds = readMinimised();
let legacyFocusedId = minimisedIds ? null : (localStorage.getItem(LEGACY_FOCUS_KEY) || null);
if (!minimisedIds) minimisedIds = new Set();

function readMinimised() {
  try {
    const raw = localStorage.getItem(MIN_KEY);
    if (raw == null) return null; // signal "no new-format value yet" for migration
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr : []);
  } catch { return new Set(); }
}

function persistMinimised() {
  localStorage.setItem(MIN_KEY, JSON.stringify([...minimisedIds]));
}

// Minimise one tile into the tray. Guarded so the board never empties: if this id
// is the last visible tile, it's a no-op (see visibleTileIds' own fallback too).
function minimise(id) {
  if (visibleTileIds(currentOrder(), minimisedIds).filter((x) => x !== id).length === 0) return;
  minimisedIds.add(id);
  persistMinimised();
  renderGrid();
}

function focusOnly(id) {
  minimisedIds = new Set(currentOrder().filter((x) => x !== id));
  persistMinimised();
  renderGrid();
}

function unminimise(id) {
  minimisedIds.delete(id);
  persistMinimised();
  renderGrid();
}

function restoreAll() {
  minimisedIds = new Set();
  persistMinimised();
  renderGrid();
}

export let latestSessions = [];
export let latestHistory = [];
export let latestTasks = { tasks: [], assignments: {} };
let taskMemoryEnabled = true; // server config flag, carried on every graph push
let subagentsExpandedByDefault = false; // server config flag, carried on every graph push
let sessionsDir = '';
let homeDir = ''; // server's home dir, so scratch paths display ~-collapsed
let proposedCwd = ''; // absolute scratch path shown (~-collapsed) for the open dialog

let dispatchMode = 'standard'; // 'standard' | 'workflow' — the dispatch modal's selected mode card
let modalMode = 'launch';  // 'launch' | 'schedule-create' | 'schedule-edit' | 'subagent' — #modal is reused for all
let editingScheduleId = null; // the schedule being edited in 'schedule-edit' mode
let subagentModalReq = null; // { sessionId, subagentId } — the in-flight fetch, to correlate its async reply
let scheduleAction = 'dispatch'; // 'dispatch' | 'session' — a schedule's action kind
let latestSchedules = { schedules: [] };
let wtBranchEdited = false;
let wtFolderEdited = false;
let modelEdited = false;   // user explicitly picked a model — don't clobber it on repopulate
let effortEdited = false;  // user explicitly picked an effort — preserve across repopulate if still offered
let reviewMode = false;    // true while the dispatch dialog is open as a review session (peerReviewSession())
// The source session id when the dispatch dialog was opened via "Review session"
// (or any future opener passing opts.parentSession) — implicit context from how
// the dialog opened, not a user-facing toggle. Reset alongside reviewMode.
let parentSessionId = null;
let wtValidation = null;   // last {ok, repoName, repoRoot, reason} for wtLastCwd
let wtLastCwd = null;      // cwd wtValidation belongs to (stale once cwd changes)
let wtPending = false;     // a worktree dispatch is awaiting ack
let pendingTodoConsume = null; // {taskId, todoId, key} — set by spawnTodo, consumed on 'dispatched'

// Available agents + their models, replaced by the server's `agents` message.
// Seeded with the Claude default so the dropdown is correct before that arrives.
let availableAgents = [{ id: 'claude', label: 'Claude', models: [
  { value: 'fable', label: 'Fable 5 · 1M context' },
  { value: 'opus', label: 'Opus 5 · 1M context', default: true },
  { value: 'opusplan', label: 'Opus plan · Sonnet execution' },
  { value: 'sonnet', label: 'Sonnet 5 · 200K context' },
  { value: 'sonnet[1m]', label: 'Sonnet 5 · 1M context' },
  { value: 'haiku', label: 'Haiku 4.5 · 200K context' },
], efforts: [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'Extra high' },
  { value: 'max', label: 'Max' },
] }];

function populateModelSelect() {
  const sel = document.getElementById('m-model');
  if (!sel) return;
  const prev = sel.value;
  sel.innerHTML = '';
  const single = availableAgents.length === 1;
  for (const a of availableAgents) {
    const parent = single ? sel : document.createElement('optgroup');
    if (!single) { parent.label = a.label; sel.appendChild(parent); }
    for (const m of a.models) {
      const opt = document.createElement('option');
      opt.value = m.value;
      opt.textContent = m.label;
      opt.dataset.agent = a.id;
      if (m.default && a.id === 'claude') opt.selected = true;
      parent.appendChild(opt);
    }
  }
  // Preserve only a user's explicit choice across a repopulate; otherwise let the
  // server-marked default win (the seed's default must not clobber it on first load).
  if (modelEdited && prev) sel.value = prev;
  syncQuickLaunch();
  populateEffortSelect();
}

// The effort levels depend on the agent that owns the selected model (agent is
// folded into the model optgroups), so this repopulates whenever the model changes.
// A leading blank option means "pass nothing" → the agent's own default effort.
function populateEffortSelect() {
  const eff = document.getElementById('m-effort');
  const modelSel = document.getElementById('m-model');
  if (!eff || !modelSel) return;
  const prev = eff.value;
  const agentId = modelSel.options[modelSel.selectedIndex]?.dataset.agent || 'claude';
  const agent = availableAgents.find((a) => a.id === agentId) || availableAgents[0];
  const efforts = agent?.efforts || [];
  eff.innerHTML = '';
  const def = document.createElement('option');
  def.value = '';
  def.textContent = 'Default';
  eff.appendChild(def);
  for (const e of efforts) {
    const opt = document.createElement('option');
    opt.value = e.value;
    opt.textContent = e.label;
    eff.appendChild(opt);
  }
  // Keep an explicit pick only if the (possibly new) agent still offers it; else
  // fall back to Default rather than stranding a level the agent can't take.
  if (effortEdited && prev && efforts.some((e) => e.value === prev)) eff.value = prev;
  else eff.value = '';
}

// The two models offered as one-click "Launch with X" shortcuts (⌘1/⌘2). Derived
// from the user's own history: every session persists the model it launched with
// (carried onto board + history nodes), so we rank by how often each was chosen.
// Opus/Sonnet backfill any empty slot so a fresh install still shows two buttons.
const QUICK_LAUNCH_FALLBACK = ['opus', 'sonnet'];
let quickLaunchModels = [...QUICK_LAUNCH_FALLBACK];
// Recompute the top-2 most-used models from live + archived sessions. Only models
// still offered in the current list count (a retired model can't be a launch target).
function computeQuickLaunchModels() {
  const offered = new Set(availableAgents.flatMap((a) => a.models.map((m) => m.value)));
  const counts = new Map();
  for (const s of [...latestSessions, ...latestHistory]) {
    const m = s.model;
    if (m && offered.has(m)) counts.set(m, (counts.get(m) || 0) + 1);
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([m]) => m);
  const picks = [];
  for (const m of [...ranked, ...QUICK_LAUNCH_FALLBACK]) {
    if (offered.has(m) && !picks.includes(m)) picks.push(m);
    if (picks.length === 2) break;
  }
  quickLaunchModels = picks;
}
// The bare model name for a value, drawn from the live model list so it tracks the
// server's labels; strips the " · <context>" suffix and falls back to the raw value.
function modelShortLabel(value) {
  for (const a of availableAgents) {
    const m = a.models.find((x) => x.value === value);
    if (m) return (m.label.split('·')[0] || '').trim() || value;
  }
  return value;
}
// Label the two quick-launch buttons from the current model list, and hide the whole
// group outside launch mode (schedule mode reuses #modal but has no "launch now").
function syncQuickLaunch() {
  const wrap = document.getElementById('m-quick-launch');
  if (!wrap) return;
  wrap.classList.toggle('hidden', scheduleMode());
  computeQuickLaunchModels();
  quickLaunchModels.forEach((value, i) => {
    const btn = document.getElementById(`m-quick-${i + 1}`);
    if (!btn) return;
    btn.innerHTML = `Launch with ${esc(modelShortLabel(value))} <span class="kbd">⌘${i + 1}</span>`;
  });
}
// One-click launch on a specific model: point the select at it (marking it an
// explicit choice) and run the normal dispatch path so worktree/validation still apply.
function quickLaunch(value) {
  if (modal.classList.contains('hidden') || scheduleMode()) return;
  const sel = document.getElementById('m-model');
  const opt = [...sel.options].find((o) => o.value === value);
  if (!opt) return;
  sel.value = value;
  modelEdited = true;
  submitDispatch();
}

// The bar word for the left status bar, mirroring the displayed state. Dormant
// (no live tmux) wins regardless of the frozen `idle` the server reports for it.
function barWord(s) {
  // Every dormant card — suspended, crashed, or rebooted — needs the same action:
  // click to resume. So the bar word is the affordance ('resume'), not the cause.
  // A restarting card is only momentarily unmanaged (tmux down between kill and
  // relaunch); keep its normal word rather than flashing 'resume' for that window.
  if (!s.managed && !s.restarting) return 'resume';
  // An autopilot run shows its current phase in the bar, winning over every live
  // word (busy/idle/reply/unread/done) but not over the dormant resume affordance.
  const phase = workflowPhaseLabel(s.workflow);
  if (phase) return phase;
  // needs-you (red) outranks a manual unread bookmark — a live block beats a cue.
  if (s.status === 'needs-you') return STATUS_WORDS['needs-you'];
  if (unread.has(s.sessionId)) return 'unread';
  if (justFinished.has(s.sessionId)) return 'done';
  return STATUS_WORDS[s.status] || '?';
}


function applyGraph(graph) {
  latestSessions = graph.sessions || [];
  latestHistory = graph.history || [];
  latestTasks = graph.tasks || { tasks: [], assignments: {} };
  latestSchedules = graph.schedules || { schedules: [] };
  taskMemoryEnabled = graph.taskMemoryEnabled !== false;
  subagentsExpandedByDefault = graph.subagentsExpandedByDefault === true;
  trackJustFinished(latestSessions);
  detectNewTask();
  // The Schedules panel is data-driven off the live rebuild (no server timer) —
  // re-render it whenever it's open so toggles/edits/fires reflect at once.
  if (!document.getElementById('schedules-modal').classList.contains('hidden')) renderSchedules();

  // Skip the board while maximized OR diffing: both make #grid display:none, so
  // renderGrid would measure zero width/height and compute a collapsed layout — one
  // column, since columnsForWidth floors a zero width to 1 (setMaximized and
  // closeDiffPanel each re-render once #grid has real dimensions again).
  // Also skip while a card menu is open — replacing #grid's innerHTML resets any
  // scrolled task list's scrollTop to 0, and restoring it fires a real 'scroll'
  // event that would otherwise close the menu right back out from under the user
  // on every ~4s poll (closeCardMenu re-renders to catch up once it's dismissed).
  renderGridIfVisible();
  if (currentView === 'history') maybeRenderHistory();
  refreshFolderList();

  tryFulfillPending();

  const active = document.activeElement;
  const editing = active && active.id === 'rename-input';
  if (selectedSessionId && !editing) {
    renderPanel(selectedSessionId);
    const sel = latestSessions.find((x) => x.sessionId === selectedSessionId);
    if (sel && holdForRestart(sel)) {
      // spinner held — don't attach the dying pane
    } else if (sel && sel.managed && (!current || current.sessionId !== selectedSessionId)) {
      openTerminal(sel);
    }
  }
}

// A full renderHistory rebuilds every archived card — with hundreds of them the
// synchronous layout costs ~300ms. Status polls push a fresh graph constantly, so
// re-rendering on every push (even when nothing History shows changed) made the
// view janky. Skip the rebuild unless the signature changed. It covers BOTH the
// history list AND the task data History groups by (a rename/reassign/reorder
// changes tile placement with an unchanged history array). latestHistory is a new
// array each push, so this is a value signature, not a reference check.
let lastHistorySig = null;
function historyRenderSig() {
  const h = latestHistory
    .map((x) => `${x.sessionId}:${x.archivedAt || 0}:${x.label || ''}:${x.cwd || ''}:${x.model || ''}:${x.parentSession || ''}:${(x.workflow && x.workflow.issue) || ''}`)
    .join('|');
  const taskSig = (latestTasks.tasks || []).map((x) => `${x.id}=${x.name}`).join(',');
  const order = (latestTasks.order || []).join(',');
  const assign = Object.entries(latestTasks.assignments || {}).map(([k, v]) => `${k}>${v}`).join(',');
  return `${h}§${taskSig}§${order}§${assign}`;
}
function maybeRenderHistory() {
  const sig = historyRenderSig();
  if (sig === lastHistorySig) return;
  lastHistorySig = sig;
  renderHistory();
}

function setView(view) {
  const leavingHistory = currentView === 'history' && view !== 'history';
  currentView = view;
  // The diff panel overlays the board, so leaving grid must dismiss it.
  if (view !== 'grid' && isDiffPanelOpen()) closeDiffPanel();
  document.querySelectorAll('.layouts button').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  const gridEl = document.getElementById('grid');
  const histEl = document.getElementById('history');
  gridEl.classList.toggle('hidden', view !== 'grid');
  // #grid.focus-mode carries its own `display: flex`, which ties in CSS
  // specificity with #grid.hidden — leaving it set while grid is hidden lets
  // the focused tile win the tie and render alongside History. renderGrid()
  // re-adds it whenever focus mode is actually active.
  if (view !== 'grid') gridEl.classList.remove('focus-mode');
  histEl.classList.toggle('hidden', view !== 'history');
  const mid = document.querySelector('.rail-mid');
  if (mid) mid.classList.toggle('hidden', view !== 'grid');
  if (leavingHistory) resetHistorySearch();
  if (view === 'grid') renderGrid();
  else if (view === 'history') {
    // History is the no-session state: drop any open terminal/sidebar so it
    // doesn't dangle behind the list.
    if (selectedSessionId) deselectSession();
    // Switching in always renders (hist-grid may be stale/empty) and focuses the
    // filter; seed lastHistorySig so an immediately-following identical push skips.
    requestHistorySearchFocus();
    lastHistorySig = historyRenderSig();
    renderHistory();
  }
  // Mirror the view into the URL hash so a refresh re-lands here (History is a
  // deep link, like a selected session). syncHash prefers the view over selection.
  syncHash();
}
document.querySelectorAll('.layouts button').forEach((btn) => {
  btn.addEventListener('click', () => setView(btn.dataset.view));
});

// ── Task Grid view ─────────────────────────────────────────────────────────
// Grid geometry (constants + packing math) lives in ./layout.js; MAX_ONSCREEN_ROWS
// is imported back for the scrolling cellH below.
const ADHOC_ID = 'adhoc';   // reserved order id for the movable Ad-hoc tile (see TaskStore.ADHOC)
// Sessions that finished (working→idle) and want your eyes. A persisted set, not
// a transient timer: the cyan alarm holds until you click the card (acknowledge),
// surviving a refresh or server restart. Membership changes only on a working→idle
// transition (add), an acknowledgement (remove), or the session leaving idle
// (remove) — see trackJustFinished and acknowledge.
const JUST_FINISHED_KEY = 'wrangler.justFinished';
const justFinished = (() => {
  try { return new Set(JSON.parse(localStorage.getItem(JUST_FINISHED_KEY)) || []); } catch { return new Set(); }
})();
function persistJustFinished() {
  try { localStorage.setItem(JUST_FINISHED_KEY, JSON.stringify([...justFinished])); } catch {}
}
// "Unread" is a manual, sticky twin of justFinished: a user bookmark that reuses
// the cyan "done" alarm but, unlike justFinished, is set/cleared only by hand (the
// card menu) or by opening the session — never derived from status, so it survives
// re-renders and reloads. Per-browser, like justFinished — it's a personal "come
// back to this" cue, not shared session lifecycle (which would live server-side).
const UNREAD_KEY = 'wrangler.unread';
const unread = (() => {
  try { return new Set(JSON.parse(localStorage.getItem(UNREAD_KEY)) || []); } catch { return new Set(); }
})();
function persistUnread() {
  try { localStorage.setItem(UNREAD_KEY, JSON.stringify([...unread])); } catch {}
}
function setUnread(sessionId, on) {
  if (on === unread.has(sessionId)) return;
  if (on) unread.add(sessionId); else unread.delete(sessionId);
  persistUnread();
  if (currentView === 'grid') renderGrid();
}
// Sessions the user has acknowledged (clicked/focused) — consumed by the card
// render to suppress the needs-you flash. We store the session's `updatedAt` at
// acknowledgement time, not just its id: `updatedAt` is rewritten on every
// status change, so a *new* needs-you episode never matches a stale ack and
// the alarm correctly re-arms — even across a leave→re-enter cycle that happened
// while this tab was closed (when the prune below never ran). Persisted to
// localStorage so a plain refresh, which isn't a new transition, stays quiet.
const ACK_KEY = 'wrangler.acknowledged';
const acknowledgedAt = (() => {
  try { return new Map(Object.entries(JSON.parse(localStorage.getItem(ACK_KEY)) || {})); } catch { return new Map(); }
})();
function persistAcknowledged() {
  try { localStorage.setItem(ACK_KEY, JSON.stringify(Object.fromEntries(acknowledgedAt))); } catch {}
}
function acknowledge(sessionId) {
  const s = latestSessions.find((x) => x.sessionId === sessionId);
  acknowledgedAt.set(sessionId, s?.updatedAt ?? null);
  persistAcknowledged();
  // A click is also what clears a just-finished alarm — drop it from the set so
  // the card settles all the way to idle (no lingering stripe, unlike needs-you).
  if (justFinished.delete(sessionId)) persistJustFinished();
}
// Acknowledged only if it's the *same* episode we acknowledged (updatedAt match).
function isAcknowledged(s) {
  return acknowledgedAt.has(s.sessionId) && acknowledgedAt.get(s.sessionId) === s.updatedAt;
}

// Task creation: after asking the server to make a task, focus its title for
// editing as soon as the new tile arrives in the graph.
let prevTaskIds = new Set();
let awaitingNewTask = false;
let autoEditTaskId = null;

// Session reorder drag-and-drop: the dragged card is hidden and a single
// dashed placeholder (`placeholderEl`) slides through the list to show where it
// will land; `dragActive` keeps background re-renders from rebuilding the grid
// mid-drag and stranding these transient nodes.
let dragActive = false;
let draggedCard = null;
let placeholderEl = null;

// Task reorder drag-and-drop: tiles are column-packed in a 2-D grid, so dropping
// one tile onto another SWAPS them (a linear insert would drag a tile across
// columns and unbalance them). While dragging, `taskSwapTargetId` is the tile
// under the cursor; the grid re-renders to preview the swap — the dragged tile
// becomes a dashed placeholder in the target's slot and the target moves to the
// dragged tile's origin. `taskDragActive` guards background re-renders, like
// `dragActive` does for sessions.
let taskDragActive = false;
let draggedTaskId = null;
let taskSwapTargetId = null;
// The canonical (pre-swap) tile geometry, snapshotted once at drag-start — see
// taskTargetAt for why hit-testing needs a fixed reference instead of the live,
// preview-swapped DOM.
let taskCellRects = null;

// One reusable placeholder, moved (never duplicated) during a reorder drag.
function ensurePlaceholder() {
  if (!placeholderEl) {
    placeholderEl = document.createElement('div');
    placeholderEl.className = 'session-placeholder';
  }
  return placeholderEl;
}
function removePlaceholder() {
  if (placeholderEl && placeholderEl.parentNode) placeholderEl.parentNode.removeChild(placeholderEl);
}

// The card the placeholder should sit *before* for a given cursor Y — the first
// card whose midpoint is below the cursor; null means past the last card (append
// to the end). Continuous across cards and the gaps between them, so the
// placeholder tracks the cursor smoothly. The hidden source card is excluded.
function dragAfterElement(body, y) {
  // A workflow box, or a .child-group wrapping a parent-with-children, is one
  // reorderable unit standing in for its top-level session, so each counts here
  // while the (non-draggable) card/box nested inside does not. `:scope >` keeps
  // this to body's direct children only — without it, querySelectorAll also
  // matches a still-draggable card/box buried inside another bucket's DOM subtree
  // (there is none here, but nesting one level deep is exactly what .child-group
  // does), and body.insertBefore(placeholder, after) requires `after` to be a
  // direct child of body or it throws.
  const cards = [...body.querySelectorAll(':scope > .session-card[draggable="true"]:not(.dragging-hidden), :scope > .workflow-box[draggable="true"]:not(.dragging-hidden), :scope > .child-group[draggable="true"]:not(.dragging-hidden)')];
  for (const card of cards) {
    const rect = card.getBoundingClientRect();
    if (y < rect.top + rect.height / 2) return card;
  }
  return null;
}

// True while the diff panel has #grid hidden (`main.diffing #grid { display: none }`).
// Read off the DOM class, NOT isDiffPanelOpen(): closeDiffPanel clears its own state
// immediately but keeps the class for the ~220ms slide-out, so only the class tracks
// whether #grid is actually measurable.
function gridHidden() {
  return document.querySelector('main').classList.contains('diffing');
}

// True while a task name is being edited inline or a session is being dragged,
// so background re-renders (the ~4s poll, the just-finished timer) don't rebuild
// the grid and steal focus / abort the drag.
function gridEditing() {
  if (dragActive || taskDragActive) return true;
  const a = document.activeElement;
  if (!a || !a.classList) return false;
  return a.classList.contains('task-name-input')
    || a.classList.contains('todo-add-input')
    || a.classList.contains('todo-text-input');
}

// Per-session scratch dirs (sessionsDir/<timestamp>, minted for folderless
// dispatches and never reused) are throwaway — never suggest one as a folder to
// start a new session in.
function isScratchDir(cwd) { return !!sessionsDir && (cwd === sessionsDir || cwd.startsWith(`${sessionsDir}/`)); }
// Collapse a leading home dir to `~` for display (scratch dirs live under
// ~/.agent-wrangler/sessions, so the proposed path reads honestly as its real
// location rather than a repo-relative ./sessions/… that no longer exists).
function tildeCollapse(p) {
  return homeDir && (p === homeDir || p.startsWith(`${homeDir}/`)) ? `~${p.slice(homeDir.length)}` : p;
}

// Themed replacement for the native confirm(): an in-app modal matching the
// other dialogs. Resolves 'ok' on OK / Enter, 'cancel' on Cancel / Escape /
// backdrop click, or 'extra' on the optional third button (only shown when
// `extraLabel` is given — a middle choice alongside OK/Cancel, e.g. archive's
// "Kill jobs & archive" vs "Archive anyway" vs "Cancel"). Listeners are torn
// down on close so repeated opens don't leak.
function confirmDialog({ title = 'Confirm', body = '', okLabel = 'OK', danger = false, extraLabel = null, extraDanger = false } = {}) {
  const modal = document.getElementById('confirm-modal');
  document.getElementById('confirm-title').textContent = title;
  document.getElementById('confirm-body').textContent = body;
  const ok = document.getElementById('confirm-ok');
  const cancel = document.getElementById('confirm-cancel');
  const extra = document.getElementById('confirm-extra');
  ok.textContent = okLabel;
  // A destructive confirm (e.g. Stop & archive) paints the OK button filled-red
  // rather than the default accent; toggle per call so a reused modal resets.
  ok.classList.toggle('danger-strong', danger);
  extra.classList.toggle('hidden', !extraLabel);
  if (extraLabel) {
    extra.textContent = extraLabel;
    extra.classList.toggle('danger-strong', extraDanger);
  } else {
    // Reset so a later dialog that omits extraLabel can't inherit stale text/
    // styling left over from an earlier call that used the third button.
    extra.textContent = '';
    extra.classList.remove('danger-strong');
  }
  modal.classList.remove('hidden');
  ok.focus();
  return new Promise((resolve) => {
    const done = (val) => {
      modal.classList.add('hidden');
      ok.removeEventListener('click', onOk);
      cancel.removeEventListener('click', onCancel);
      extra.removeEventListener('click', onExtra);
      modal.removeEventListener('keydown', onKey);
      modal.removeEventListener('mousedown', onBackdrop);
      resolve(val);
    };
    const onOk = () => done('ok');
    const onCancel = () => done('cancel');
    const onExtra = () => done('extra');
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); done('cancel'); }
      else if (e.key === 'Enter') { e.preventDefault(); done('ok'); }
    };
    const onBackdrop = (e) => { if (e.target === modal) done('cancel'); };
    ok.addEventListener('click', onOk);
    cancel.addEventListener('click', onCancel);
    extra.addEventListener('click', onExtra);
    modal.addEventListener('keydown', onKey);
    modal.addEventListener('mousedown', onBackdrop);
  });
}
// The session's snooze phase (null | 'asleep' | 'awake'), via the pure module.
function phaseOf(s) { return snoozePhase(s.snooze, Date.now()); }
// "Currently snoozed and hidden" — the question every Snooze/Unsnooze toggle asks.
// A *fired* snooze still carries its object (awake phase, driving the alarm), so a
// raw Boolean(s.snooze) wrongly reads it as asleep — always route toggles here.
function isAsleep(s) { return phaseOf(s) === 'asleep'; }

// View-state class for a card. 'just-finished' is layered on by Task 10.
// An acknowledged needs-you card keeps the steady-red 'focused' modifier so the
// alarm (flash + ring) is suppressed while the red state stripe stays (see
// acknowledgedAt).
function cardState(s) {
  let base = justFinished.has(s.sessionId)
    ? 'just-finished'
    : (s.status === 'needs-you' && isAcknowledged(s) ? 'needs-you focused' : s.status);
  // A manual unread bookmark reuses the cyan just-finished alarm (no new CSS) and
  // persists until the card is opened — but a live needs-you (red) outranks it.
  if (unread.has(s.sessionId) && base !== 'needs-you' && base !== 'needs-you focused') base = 'just-finished';
  // A fired snooze adds the amber alarm; the status class above still drives the
  // stripe, snooze-flash wins the animation (see styles.css).
  return phaseOf(s) === 'awake' ? `${base} snooze-alarm` : base;
}

// Which (still-existing) task a session belongs to, or null for No-task.
function assignedTaskId(sessionId) {
  const id = latestTasks.assignments[sessionId];
  return id && latestTasks.tasks.some((t) => t.id === id && !t.archivedAt) ? id : null;
}

// Read-only link chips for a task tile / session card / panel: jira (key, links
// to the issue) and pr (#number, links to the PR, with a CI status dot the
// server polls). All mutation is via MCP — there's deliberately no add/remove
// affordance here.
// PR urls whose dot is mid one-shot failure flash. Module-scope like
// justFinished so linkChipsHtml reads it on every render — the flash survives
// re-renders and we re-render again when the window closes (flashPr).
const flashingPr = new Set();

// The task tile to halo right after a task-unarchive lands us back on the
// board (see the 'task-unarchived' WS handler) — a one-shot pulse so the
// restore is visually obvious, same re-render-driven flash pattern as flashPr.
let restoredTaskId = null;
function flashRestoredTask(taskId) {
  restoredTaskId = taskId;
  renderGrid();
  setTimeout(() => { restoredTaskId = null; renderGrid(); }, 1800);
}

// Workflow boxes the user has collapsed (hiding their worker spine), keyed on the
// orchestrator card id. Client-only view state — like unread, it's a personal
// "fold this away" cue, persisted to localStorage so it survives a refresh.
const COLLAPSED_WF_KEY = 'wrangler.collapsedWorkflows';
const collapsedWorkflows = (() => {
  try { return new Set(JSON.parse(localStorage.getItem(COLLAPSED_WF_KEY)) || []); } catch { return new Set(); }
})();
function toggleWorkflowCollapse(sessionId) {
  if (collapsedWorkflows.has(sessionId)) collapsedWorkflows.delete(sessionId);
  else collapsedWorkflows.add(sessionId);
  try { localStorage.setItem(COLLAPSED_WF_KEY, JSON.stringify([...collapsedWorkflows])); } catch {}
  if (currentView === 'grid') renderGrid();
}

// The set of buckets (task ids, or ADHOC_ID) sorted by last activity rather than the
// stored drag order — a client-only view preference like collapsedWorkflows, persisted
// so it survives a refresh. While a bucket is in here, intra-task reorder is suppressed.
const ACTIVITY_SORT_KEY = 'wrangler.activitySortedTasks';
const activitySortedTasks = (() => {
  try { return new Set(JSON.parse(localStorage.getItem(ACTIVITY_SORT_KEY)) || []); } catch { return new Set(); }
})();
function toggleActivitySort(bucketId) {
  if (activitySortedTasks.has(bucketId)) activitySortedTasks.delete(bucketId);
  else activitySortedTasks.add(bucketId);
  try { localStorage.setItem(ACTIVITY_SORT_KEY, JSON.stringify([...activitySortedTasks])); } catch {}
  if (currentView === 'grid') renderGrid();
}
// A bucket's sessions in display order: last-activity sort when toggled on, else the
// stored drag order. The single chooser behind every board/focused/nav ordering site.
function sortBucketSessions(sessions, bucketId) {
  return activitySortedTasks.has(bucketId)
    ? sortByLastActivity(sessions)
    : orderSessions(sessions, (latestTasks.sessionOrder || {})[bucketId]);
}

// Feeds tileSpan (layout.js) the two child-row counts it needs, both derived from
// exactly what renderTileCards (cards.js) draws: computeAbsorption decides which
// sessions fold into a parent's spine (an orphan, or a chained grandchild whose
// parent is itself absorbed, renders as its own top-level card instead and must
// NOT be counted in either number). Takes the same non-asleep subset tileHtml
// uses (an asleep session is shown as its own flat snoozed row, never nested,
// regardless of parentSession).
//
// `absorbed` is the STRUCTURAL count — every session folded into some spine,
// full stop, regardless of whether that spine is currently shown. `visible` is
// how many of those rows are actually drawn right now — 0 for a collapsed
// workflow box's workers. The two must stay distinct: a collapsed session is
// still absorbed (it never becomes its own full card just because its spine is
// hidden), so tileSpan uses `absorbed` to pull it out of the full-weight active
// count, and only uses `visible` for the light weight actually being rendered.
// Collapsing conflated into one number used to re-inflate the tile on collapse
// instead of shrinking it (verified against a live board) — keep them separate.
//
// `workflowBoxCount` counts top-level (non-absorbed) sessions that isWorkflowRun
// — every one of them renders wrapped in its own `.workflow-box` (cards.js),
// solo or with workers, collapsed or not, so this is independent of collapse
// state (unlike `visible`).
function childRowCounts(activeSessions) {
  const { absorbed, childrenByParent } = computeAbsorption(activeSessions);
  let visible = 0;
  for (const [parentId, children] of childrenByParent) {
    const parent = activeSessions.find((s) => s.sessionId === parentId);
    if (isWorkflowRun(parent) && collapsedWorkflows.has(parentId)) continue;
    visible += children.length;
  }
  // Live team-member rows are always-drawn secondary rows on a top-level lead's
  // spine (never collapsed). Count them for the tile weight, but only for a lead
  // that actually renders — an absorbed session draws no spine. They are not
  // sessions, so `absorbed` is unchanged.
  for (const s of activeSessions) {
    if (!absorbed.has(s.sessionId)) visible += (s.teammates?.length || 0);
  }
  const workflowBoxCount = activeSessions.filter((s) => !absorbed.has(s.sessionId) && isWorkflowRun(s)).length;
  return { visible, absorbed: absorbed.size, workflowBoxCount };
}

// Per-card sub-agent zone visibility: which card ids currently show their zone at
// all (the card has no Active/Show-finished filter of its own — that lives on the
// panel, see renderPanel — just on/off). Client-only, localStorage-persisted, keyed
// on card id — exactly like collapsedWorkflows. Stored as an id → bool map of
// EXPLICIT overrides (not a plain "shown" Set) so a card the user has toggled by
// hand keeps its own choice no matter how the subagentsExpandedByDefault setting
// moves later; a card never explicitly touched just follows the current default.
// Legacy shape was a bare array of "shown" ids (back when the default was always
// collapsed) — read as explicit `true` overrides so old choices still mean "shown".
const SUBAGENT_SHOWN_KEY = 'wrangler.subagentShown';
const subagentShownOverrides = (() => {
  try {
    const parsed = JSON.parse(localStorage.getItem(SUBAGENT_SHOWN_KEY));
    if (Array.isArray(parsed)) return new Map(parsed.map((id) => [id, true]));
    if (parsed && typeof parsed === 'object') return new Map(Object.entries(parsed));
  } catch { /* fall through to empty */ }
  return new Map();
})();
function persistSubagentShownOverrides() {
  try { localStorage.setItem(SUBAGENT_SHOWN_KEY, JSON.stringify(Object.fromEntries(subagentShownOverrides))); } catch {}
}
function isSubagentShown(sessionId) {
  return subagentShownOverrides.has(sessionId) ? subagentShownOverrides.get(sessionId) : subagentsExpandedByDefault;
}
function toggleSubagentShown(sessionId) {
  subagentShownOverrides.set(sessionId, !isSubagentShown(sessionId));
  persistSubagentShownOverrides();
  if (currentView === 'grid') renderGrid();
}

function flashPr(url) {
  flashingPr.add(url);
  renderGrid(); // re-render so the alert class lands now
  setTimeout(() => { flashingPr.delete(url); renderGrid(); }, 4000);
}

// The view-state bundle the pure card/tile builders in ./cards.js read. app.js
// owns these singletons (selection, flash sets, collapse set) and the derived-
// status helpers; cardCtx() snapshots them for a render pass.
function cardCtx() {
  return {
    selectedSessionId, selectedNewSlot, flashingPr, collapsedWorkflows, activitySortedTasks, restoredTaskId,
    justFinished, cardState, barWord, phaseOf, todosFor, ADHOC_ID,
    // Duck-types the old Set-based ctx.subagentShown (cards.js only ever calls
    // .has(id)) while actually resolving the default-vs-explicit-override split.
    subagentShown: { has: isSubagentShown }, taskMemoryEnabled, now: Date.now(),
  };
}

function todosFor(bucketId) {
  return (latestTasks.todos || {})[bucketId] || [];
}

// The combined display order (task ids + the Ad-hoc sentinel). Falls back to
// tasks-then-Ad-hoc and tolerates a stale order missing freshly added ids.
function currentOrder() {
  // Archived tasks (taskStore.archiveTask) stay in latestTasks.tasks forever —
  // filtering them out here is what actually drops them off the live board;
  // they still resolve fine anywhere a lookup is scoped to an already-visible id.
  const ids = latestTasks.tasks.filter((t) => !t.archivedAt).map((t) => t.id);
  const valid = new Set([...ids, ADHOC_ID]);
  const order = [...new Set((Array.isArray(latestTasks.order) ? latestTasks.order : []).filter((id) => valid.has(id)))];
  for (const id of ids) if (!order.includes(id)) order.push(id);
  if (!order.includes(ADHOC_ID)) order.push(ADHOC_ID);
  return order;
}

let snoozeWakeTimer = null;
// Re-render when the soonest asleep session is due to wake, so its amber alarm
// appears on time without a server round-trip. Phase is a pure until-vs-now
// comparison, so a plain re-render flips asleep -> awake.
function scheduleSnoozeWake() {
  clearTimeout(snoozeWakeTimer);
  const now = Date.now();
  const dues = latestSessions
    .filter((s) => phaseOf(s) === 'asleep')
    .map((s) => s.snooze.until);
  if (!dues.length) return;
  const next = Math.min(...dues);
  // +250ms so now >= until holds when we re-render; cap so setTimeout stays sane.
  const delay = Math.min(Math.max(next - now + 250, 0), 21474836);
  snoozeWakeTimer = setTimeout(() => { if (currentView === 'grid') renderGrid(); }, delay);
}

function captureScrollState(el) {
  const bodies = new Map();
  for (const body of el.querySelectorAll('.task-body')) {
    const taskId = body.closest('[data-taskid]')?.dataset.taskid;
    if (taskId) bodies.set(taskId, body.scrollTop);
  }
  const tray = el.querySelector('.tray-pills');
  return { grid: el.scrollTop, bodies, tray: tray ? tray.scrollTop : 0 };
}

function restoreScrollState(el, { grid, bodies, tray }) {
  el.scrollTop = grid;
  for (const body of el.querySelectorAll('.task-body')) {
    const taskId = body.closest('[data-taskid]')?.dataset.taskid;
    if (taskId && bodies.has(taskId)) body.scrollTop = bodies.get(taskId);
  }
  const trayPills = el.querySelector('.tray-pills');
  if (trayPills) trayPills.scrollTop = tray;
}

function renderGrid() {
  const el = document.getElementById('grid');
  // Migrate a legacy single-value focus once the task list is known, then prune
  // stale ids. minimisedIds drives everything below: the board shows every tile
  // NOT in the set; the tray (trayHtml) shows those that are.
  const orderIds = currentOrder();
  const validIds = new Set(orderIds);
  if (legacyFocusedId != null) {
    minimisedIds = expandFocusToMinimised(orderIds, legacyFocusedId);
    legacyFocusedId = null;
    localStorage.removeItem(LEGACY_FOCUS_KEY);
    persistMinimised();
  }
  const pruned = pruneMinimised(minimisedIds, validIds);
  if (pruned.size !== minimisedIds.size) { minimisedIds = pruned; persistMinimised(); }

  const visible = visibleTileIds(orderIds, minimisedIds);
  // Exactly one visible tile → the big expanded focus view (unchanged look). More
  // than one → the normal packed grid. The tray is appended by both paths.
  if (visible.length === 1) { renderFocusedTile(el, visible[0]); return; }
  el.classList.remove('focus-mode');
  const perRow = sessionsPerRow(el);
  const byTask = new Map(latestTasks.tasks.map((t) => [t.id, []]));
  const noTask = [];
  for (const s of latestSessions) {
    const tid = assignedTaskId(s.sessionId);
    if (tid) byTask.get(tid).push(s);
    else noTask.push(s);
  }
  // One tile per id in the stored display order; the Ad-hoc tile is an ordinary,
  // movable member of that order (no longer pinned).
  const tileById = new Map(
    latestTasks.tasks.map((task) => {
      const ordered = sortBucketSessions(byTask.get(task.id) || [], task.id);
      const sessions = sortAsleepLast(ordered, phaseOf);
      const todoCount = ((latestTasks.todos || {})[task.id] || []).length;
      const { visible: childRowCount, absorbed: absorbedChildCount, workflowBoxCount } = childRowCounts(sessions.filter((s) => phaseOf(s) !== 'asleep'));
      return [task.id, { kind: 'task', id: task.id, task, sessions, span: tileSpan(sessions, perRow, todoCount, phaseOf, childRowCount, absorbedChildCount, workflowBoxCount) }];
    })
  );
  const adhocOrdered = sortBucketSessions(noTask, ADHOC_ID);
  const adhocSessions = sortAsleepLast(adhocOrdered, phaseOf);
  const adhocTodoCount = ((latestTasks.todos || {})[ADHOC_ID] || []).length;
  const { visible: adhocChildRowCount, absorbed: adhocAbsorbedChildCount, workflowBoxCount: adhocWorkflowBoxCount } = childRowCounts(adhocSessions.filter((s) => phaseOf(s) !== 'asleep'));
  tileById.set(ADHOC_ID, { kind: 'notask', id: ADHOC_ID, sessions: adhocSessions, span: tileSpan(adhocSessions, perRow, adhocTodoCount, phaseOf, adhocChildRowCount, adhocAbsorbedChildCount, adhocWorkflowBoxCount) });
  const tiles = visible.map((id) => tileById.get(id)).filter(Boolean);
  const canonical = computeLayout(tiles, columnsForWidth(el));
  let { placed, cols, rows, scroll } = canonical;
  // Mid-drag preview: swap the dragged tile and the hovered target WITHOUT
  // re-running computeLayout on the whole board — see localSwapPlacement for
  // why a full repack can strand the preview in a column neither tile was ever
  // in. Only the tile(s) in the two affected columns move; everything else
  // keeps its canonical position untouched. (The COMMIT still does a plain
  // order-swap, not this — see commitTaskSwap for why that mismatch is a known,
  // separate limitation rather than something fixed here.)
  if (taskDragActive && draggedTaskId && taskSwapTargetId && taskSwapTargetId !== draggedTaskId) {
    const swapped = localSwapPlacement(canonical.placed, draggedTaskId, taskSwapTargetId);
    if (swapped) { placed = swapped.placed; rows = swapped.rows; scroll = swapped.scroll; }
  }

  // The tray (if any minimised tiles) rides one extra full-width row below the
  // tiles — a content-sized `auto` track so it never steals height from the tiles.
  // Without its own track it would auto-place into a tile cell, cramped to one
  // column (the bug this fixes).
  const hasTray = minimisedIds.size > 0;
  const trayRow = hasTray ? ' auto' : '';
  el.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
  if (scroll) {
    // Past 3×3: lock cell height to the 3-row size and let the board scroll.
    el.classList.add('scrolling');
    const cellH = Math.max(90, Math.floor(el.clientHeight / MAX_ONSCREEN_ROWS) - 12);
    el.style.gridTemplateRows = '';
    el.style.gridAutoRows = `${cellH}px`;
  } else {
    el.classList.remove('scrolling');
    el.style.gridAutoRows = '';
    el.style.gridTemplateRows = `repeat(${rows}, 1fr)${trayRow}`;
  }
  // Ghost "＋ new task" drop targets for every empty cell — invisible until a
  // session drag arms the grid (see armNewTask). Dropping one creates a task.
  const occupied = new Set();
  for (const p of placed) for (let r = p.rowStart; r < p.rowStart + p.span; r++) occupied.add(`${p.col}:${r}`);
  const ghosts = [];
  for (let c = 0; c < cols; c++) for (let r = 0; r < rows; r++) if (!occupied.has(`${c}:${r}`)) ghosts.push({ col: c, row: r });

  const scrollState = captureScrollState(el);
  const ctx = cardCtx();
  el.innerHTML = placed.map((t) => tileHtml(t, ctx)).join('') + ghosts.map(ghostHtml).join('') + trayHtml(visible);
  // Pin the tray to its own row spanning every column (grid-column via CSS). In the
  // scrolling layout there's no explicit track for it, so place it just past the
  // last tile row; the implicit gridAutoRows track sizes it (capped by CSS).
  const tray = el.querySelector(':scope > .focus-switcher');
  if (tray) tray.style.gridRow = scroll ? `${rows + 1}` : '';
  restoreScrollState(el, scrollState);
  wireGridEvents(el);
  wireTray(el);

  // Freshly created task → drop straight into naming it.
  if (autoEditTaskId) {
    const cell = el.querySelector(`.task-cell[data-taskid="${CSS.escape(autoEditTaskId)}"]`);
    autoEditTaskId = null;
    if (cell) beginTaskRename(cell);
  }
  scheduleSnoozeWake();
}

function renderFocusedTile(el, id) {
  const isAdhoc = id === ADHOC_ID;
  const sessions = sortAsleepLast(
    sortBucketSessions(
      latestSessions.filter((s) => isAdhoc ? !assignedTaskId(s.sessionId) : assignedTaskId(s.sessionId) === id),
      id
    ),
    phaseOf
  );
  const tile = isAdhoc
    ? { kind: 'notask', id: ADHOC_ID, sessions, span: 1 }
    : { kind: 'task', id, task: latestTasks.tasks.find((t) => t.id === id), sessions, span: 1 };
  el.classList.add('focus-mode');
  el.classList.remove('scrolling');
  el.style.gridTemplateColumns = '';
  el.style.gridTemplateRows = '';
  el.style.gridAutoRows = '';
  const scrollState = captureScrollState(el);
  el.innerHTML = tileHtml(tile, cardCtx(), { focusMode: true }) + trayHtml([id]);
  restoreScrollState(el, scrollState);
  wireGridEvents(el);
  wireTray(el);
}

// Status class for a single session's switcher dot — same hue vocabulary as the
// card stripe but static (no animation).
function sessionDotStatus(s) {
  if (!s.managed) return 'idle';
  if (s.status === 'needs-you') return 'needs-you';
  if (justFinished.has(s.sessionId)) return 'just-finished';
  return s.status || 'idle';
}

// The bottom tray: the tiles NOT in `visible` (so grid and tray can never show the
// same tile), one pill each. Reuses the .focus-switcher strip styling.
function trayHtml(visible) {
  const visibleSet = new Set(visible);
  const mins = currentOrder()
    .filter((id) => !visibleSet.has(id))
    .map((id) => (id === ADHOC_ID ? { id: ADHOC_ID, name: 'Unassigned' } : latestTasks.tasks.find((t) => t.id === id)))
    .filter(Boolean);
  if (!mins.length) return '';
  const pills = mins.map((t) => {
    const sessions = latestSessions.filter((s) => {
      const tid = assignedTaskId(s.sessionId);
      return (t.id === ADHOC_ID ? !tid : tid === t.id) && !isAsleep(s);
    });
    const dots = sessions.map((s) => `<span class="switcher-dot ${esc(sessionDotStatus(s))}"></span>`).join('');
    return `<button class="switcher-pill" data-taskid="${esc(t.id)}" title="Restore ${esc(t.name)}">
      <span class="switcher-name">${esc(t.name)}</span><span class="switcher-dots">${dots}</span>
    </button>`;
  }).join('');
  // Restore-all sits first among the pills, wrapping and scrolling with them.
  return `<div class="focus-switcher"><div class="tray-pills"><button class="tray-restore-all" title="Restore all minimised tasks">Restore all</button>${pills}</div></div>`;
}

function wireTray(el) {
  // Shift+click a pill to focus on just that task (everything else minimises),
  // same as the kebab menu's Focus action — a plain click only restores this one
  // alongside whatever's already visible.
  el.querySelectorAll('.switcher-pill').forEach((b) =>
    b.addEventListener('click', (e) => e.shiftKey ? focusOnly(b.dataset.taskid) : unminimise(b.dataset.taskid)));
  const restore = el.querySelector('.tray-restore-all');
  if (restore) restore.addEventListener('click', restoreAll);
}

// Same select-or-resume behavior a plain click on a card triggers — shared
// with the disabled sub-agent pill, which falls through to this instead of
// toggling (see wireGridEvents).
function focusSession(sid) {
  const s = latestSessions.find((x) => x.sessionId === sid);
  if (s && !s.managed) resumeDormant(sid);
  else selectSession(sid);
}

function wireGridEvents(el) {
  // A worker spine row opens/menus exactly like a card (same data-sid contract), so
  // it shares this binding rather than a parallel one. A sub-agent row is included
  // here (not just via the panel's own binding) so the board's flat zone rows open
  // the detail modal too.
  el.querySelectorAll('.session-card, .worker-row, .subagent-row, .team-row').forEach((card) => {
    // A sub-agent row now nests INSIDE its owning .session-card (not a sibling
    // after it), so a click on the row bubbles up into the card's own listener
    // too. `rowAncestor !== card` catches exactly that bubbled case (the row's
    // OWN listener has rowAncestor === card, so it's unaffected) and bails before
    // the card acts on a click that its nested row already handled.
    const bubbledFromRow = (e) => {
      const rowAncestor = e.target.closest('.subagent-row');
      return rowAncestor != null && rowAncestor !== card;
    };
    const activate = (e) => {
      if (e.target.closest('button') || e.target.closest('.link-chip') || bubbledFromRow(e)) return;
      // A sub-agent row is a read-only artifact, not a session: open its detail
      // modal rather than selecting/resuming (it carries no data-sid).
      if (card.classList.contains('subagent-row')) {
        openSubagentModal(card.dataset.ownerSid, card.dataset.subagentId);
        return;
      }
      // A team-member row is not a session (it shares the lead's tmux, has no
      // card id): focus the lead so its shared session attaches.
      if (card.classList.contains('team-row')) {
        focusSession(card.dataset.leadSid);
        return;
      }
      focusSession(card.dataset.sid);
    };
    card.addEventListener('click', activate);
    // Keyboard activation for the role="button"/tabindex on the row (and for
    // Vimium, which focuses a hint then activates it). Only act when the row
    // itself is focused — Enter inside a nested control is that control's.
    card.addEventListener('keydown', (e) => {
      if (e.target !== card) return;
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(e); }
    });
    card.addEventListener('contextmenu', (e) => {
      if (card.classList.contains('subagent-row') || card.classList.contains('team-row') || bubbledFromRow(e)) return; // not a session — no card menu
      e.preventDefault();
      openCardMenu(card.dataset.sid, e.clientX, e.clientY);
    });
    // Middle-click stops & archives in one gesture (same handler as the menu's
    // Stop & archive, no confirm — the post-archive toast offers immediate Resume).
    // The action runs on auxclick (button release); the mousedown preventDefault
    // only suppresses the browser's middle-button autoscroll cursor.
    card.addEventListener('mousedown', (e) => {
      if (e.button === 1) e.preventDefault();
    });
    card.addEventListener('auxclick', (e) => {
      if (e.button !== 1) return;
      if (card.classList.contains('subagent-row') || card.classList.contains('team-row') || bubbledFromRow(e)) return; // not a session — nothing to archive
      if (e.target.closest('button') || e.target.closest('.link-chip')) return;
      e.preventDefault();
      archiveSession(card.dataset.sid);
    });
  });
  // The show/hide pill on a card toggles that card's sub-agent zone visibility.
  // When disabled (no recent sub-agents — see subagentPillHtml), it's not a
  // native `disabled` button, so the click still fires here; fall through to
  // the same focus behavior clicking anywhere else on the card would trigger,
  // rather than swallowing it.
  el.querySelectorAll('.subagent-pill').forEach((pill) => {
    pill.addEventListener('click', (e) => {
      if (pill.getAttribute('aria-disabled') === 'true') {
        focusSession(pill.dataset.sid);
        return;
      }
      e.stopPropagation();
      toggleSubagentShown(pill.dataset.sid);
    });
  });
  // Clicking a workflow header folds its worker spine away (and back). Keyboard-
  // reachable since the head carries role="button"/tabindex when it has workers.
  el.querySelectorAll('.workflow-head[role="button"]').forEach((head) => {
    const sid = head.closest('.workflow-box')?.dataset.sid;
    if (!sid) return;
    head.addEventListener('click', () => toggleWorkflowCollapse(sid));
    head.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleWorkflowCollapse(sid); }
    });
  });
  el.querySelectorAll('.snoozed-row').forEach((row) => {
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openCardMenu(row.dataset.sid, e.clientX, e.clientY);
    });
  });
  // The wake-now sun on a snoozed row: the only way to unsnooze without right-clicking.
  // A snoozed session is often also suspended (≥1h snooze tore its tmux down), so
  // waking it must resume — not just select it onto the dead "Resume a copy" panel.
  el.querySelectorAll('.snooze-wake').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      wakeSession(btn.dataset.sid);
    });
  });
  // Right-click anywhere on a task tile (but not on a card/row/button, which carry
  // their own menus) opens the task menu — a discoverable superset of the header
  // icon buttons, plus the genuinely new "New TODO".
  el.querySelectorAll('.task-cell').forEach((cell) => {
    cell.addEventListener('contextmenu', (e) => {
      if (e.target.closest('.session-card, .worker-row, .subagent-row, .snoozed-row, .todo-row, .workflow-head, button, input, .link-chip')) return;
      e.preventDefault();
      openTaskMenu(cell, e.clientX, e.clientY);
    });
  });
  wireGridDnd(el);
  wireTaskControls(el);
}

// Right-click menu on a session card: the same per-session actions as the detail
// panel's header, calling the same handlers so there's no second code path to
// keep in sync. One menu lives on <body> at a time; any dismissal (outside
// mousedown, Escape, scroll, resize) tears it down along with its listeners.
let overflowMenuEl = null;
function closeOverflowMenu() {
  if (!overflowMenuEl) return;
  overflowMenuEl.remove();
  overflowMenuEl = null;
  document.removeEventListener('mousedown', onOverflowMenuDismiss, true);
}
function onOverflowMenuDismiss(e) {
  if (overflowMenuEl && !overflowMenuEl.contains(e.target)) closeOverflowMenu();
}

let cardMenuEl = null;
// A flyout opened off a row with `submenu` (e.g. "Attach to…") — a second,
// independent floating element anchored beside its trigger row rather than a
// replacement for cardMenuEl, so the root menu stays open behind it (mirrors
// a native OS context menu's child menu). Only one deep — no submenu opens a
// further submenu of its own today.
let subMenuEl = null;
function closeSubMenu() {
  if (!subMenuEl) return;
  subMenuEl.remove();
  subMenuEl = null;
}
function closeCardMenu() {
  if (!cardMenuEl) return;
  closeSubMenu();
  cardMenuEl.remove();
  cardMenuEl = null;
  document.removeEventListener('mousedown', onCardMenuDismiss, true);
  document.removeEventListener('keydown', onCardMenuKey, true);
  window.removeEventListener('scroll', closeCardMenu, true);
  window.removeEventListener('resize', closeCardMenu);
  // applyGraph skips renderGrid while cardMenuEl is set (see there) so the poll
  // can't yank the menu closed mid-display; catch up once things settle. Deferred
  // to a microtask because mountMenu calls closeCardMenu() BEFORE it.run() — an
  // item's own handler runs right after this returns and may still need the
  // pre-close DOM (New TODO/Rename capture their tile's todoZone/cell and focus a
  // fresh input into it) or may open a new menu itself (Snooze…). Rendering here
  // synchronously would yank that DOM out from under it; by the time this
  // microtask runs, gridEditing()/cardMenuEl reflect whatever run() just did.
  queueMicrotask(() => {
    if (currentView === 'grid' && !gridEditing() && !cardMenuEl) renderGrid();
  });
}
function onCardMenuDismiss(e) {
  if (subMenuEl?.contains(e.target)) return;
  if (cardMenuEl?.contains(e.target)) return;
  closeCardMenu();
}
// Move focus among the CURRENT front menu's real rows (the submenu if one is
// open, else the root — buttons only, since separators/headers are plain divs
// and querySelectorAll('.context-menu-item') already skips them for free).
// Wraps at the ends; starts from the first row if focus isn't currently on
// one of them (e.g. it landed elsewhere via Tab).
function focusMenuItem(dir) {
  const menu = subMenuEl || cardMenuEl;
  if (!menu) return;
  const items = Array.from(menu.querySelectorAll('.context-menu-item'));
  if (!items.length) return;
  const i = items.indexOf(document.activeElement);
  const next = i < 0 ? (dir > 0 ? 0 : items.length - 1) : (i + dir + items.length) % items.length;
  items[next].focus();
}
function onCardMenuKey(e) {
  // Escape closes one level at a time, like a native menu: the submenu first
  // (if open), then the root — never both in one press.
  if (e.key === 'Escape') {
    e.preventDefault();
    if (subMenuEl) { closeSubMenu(); cardMenuEl?.querySelector('.context-menu-item')?.focus(); }
    else closeCardMenu();
    return;
  }
  if (e.key === 'ArrowDown') { e.preventDefault(); focusMenuItem(1); return; }
  if (e.key === 'ArrowUp') { e.preventDefault(); focusMenuItem(-1); return; }
  // ArrowRight opens the focused row's submenu (if it has one); ArrowLeft
  // backs out of an open submenu to its trigger row — the standard nested
  // context-menu keyboard model.
  if (e.key === 'ArrowRight' && !subMenuEl) {
    const el = document.activeElement;
    if (el?.dataset.hasSubmenu) { e.preventDefault(); el.click(); }
    return;
  }
  if (e.key === 'ArrowLeft' && subMenuEl) {
    e.preventDefault();
    closeSubMenu();
    cardMenuEl?.querySelector('.context-menu-item')?.focus();
    return;
  }
  // Enter/Space activate the focused row via the browser's own native button
  // behavior — nothing to wire up here as long as a row actually has focus.
}
// Build a context-menu <div> from an items array ({label, icon?, trailing?,
// keepOpen?, run, submenu?, danger?, sep?, header?}) — shared by the root menu
// (mountMenu) and a flyout (openSubMenu). `trailing` is an optional
// right-aligned glyph (e.g. a tick marking an on/off toggle's state) —
// present-but-empty still reserves the slot so a toggle can fill it in place.
// `keepOpen` leaves the menu open after a click (for in-place toggles). `run`
// receives the click event. `submenu` (an items array, built eagerly like any
// other item) makes the row open a flyout instead of running an action — it
// takes over the trailing slot with a disclosure arrow.
function buildMenuEl(items) {
  const menu = document.createElement('div');
  menu.className = 'context-menu';
  for (const it of items) {
    if (it.sep) {
      const d = document.createElement('div');
      d.className = 'context-menu-sep';
      menu.appendChild(d);
      continue;
    }
    if (it.header) {
      const h = document.createElement('div');
      h.className = 'context-menu-header';
      h.textContent = it.header;
      menu.appendChild(h);
      continue;
    }
    const b = document.createElement('button');
    b.className = `context-menu-item${it.danger ? ' danger' : ''}`;
    const trailing = it.submenu
      ? `<span class="context-menu-trailing">${CHEVRON_RIGHT_ICON}</span>`
      : ('trailing' in it ? `<span class="context-menu-trailing">${it.trailing || ''}</span>` : '');
    b.innerHTML = `${it.icon || ''}<span>${esc(it.label)}</span>${trailing}`;
    if (it.title) b.title = it.title;
    if (it.submenu) {
      b.dataset.hasSubmenu = '1';
      b.setAttribute('aria-haspopup', 'true');
      // Own click, not the plain-item listener below: opens a flyout beside
      // this row and leaves the root menu (and any other open submenu) alone
      // rather than dismissing anything.
      b.addEventListener('click', (e) => { e.stopPropagation(); openSubMenu(it.submenu, b); });
    } else {
      // Pass the click event through so an item can react to modifier keys.
      // Other items ignore it. keepOpen items (in-place toggles) leave the
      // menu mounted; the rest dismiss the whole stack (root + any submenu).
      b.addEventListener('click', (e) => { if (!it.keepOpen) closeCardMenu(); it.run(e); });
    }
    menu.appendChild(b);
  }
  return menu;
}
// Open (or replace) the flyout beside `anchorEl` — a row inside cardMenuEl
// that declared `submenu`. Positioned to the anchor row's right by default,
// flipped to its left if it would overflow the viewport; vertically clamped
// like the root menu. Only one submenu is ever open at a time.
function openSubMenu(items, anchorEl) {
  closeSubMenu();
  const menu = buildMenuEl(items);
  menu.style.visibility = 'hidden';
  document.body.appendChild(menu);
  const anchor = anchorEl.getBoundingClientRect();
  const { width, height } = menu.getBoundingClientRect();
  const left = anchor.right + width > window.innerWidth - 4
    ? Math.max(4, anchor.left - width)
    : anchor.right;
  menu.style.left = `${left}px`;
  menu.style.top = `${Math.max(4, Math.min(anchor.top, window.innerHeight - height - 4))}px`;
  menu.style.visibility = '';
  subMenuEl = menu;
  menu.querySelector('.context-menu-item')?.focus();
}
// Build + mount a context menu from an items array at (x,y), clamped into the
// viewport — see buildMenuEl for the item shape. Returns nothing; sets
// cardMenuEl.
function mountMenu(items, x, y) {
  closeCardMenu();
  const menu = buildMenuEl(items);
  // Mount hidden to measure, then clamp inside the viewport so a card near the
  // right/bottom edge flips the menu back rather than spilling off-screen.
  menu.style.visibility = 'hidden';
  document.body.appendChild(menu);
  const { width, height } = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - width - 4))}px`;
  menu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - height - 4))}px`;
  menu.style.visibility = '';
  cardMenuEl = menu;
  document.addEventListener('mousedown', onCardMenuDismiss, true);
  document.addEventListener('keydown', onCardMenuKey, true);
  window.addEventListener('scroll', closeCardMenu, true);
  window.addEventListener('resize', closeCardMenu);
  // Land focus on the first row immediately so a keyboard-opened menu (e.g.
  // Ctrl+Cmd+S) is navigable right away — arrow keys move focus (see
  // onCardMenuKey), Enter/Space activate the focused row natively.
  menu.querySelector('.context-menu-item')?.focus();
}

// Shared "Auto-fix PR checks" toggle row for the card + Actions menus. keepOpen
// so a click flips it in place (the tick updates optimistically off a local
// `on`) rather than dismissing the menu; the server round-trip + next graph poll
// reconcile the persisted state. run gets the click event — its currentTarget is
// the row button, whose trailing slot holds the tick.
function autoFixMenuItem(s) {
  let on = Boolean(s.autoFixPrChecks);
  return {
    label: 'Auto-fix PR checks',
    icon: GITHUB_ICON,
    trailing: on ? CHECK_ICON : '',
    keepOpen: true,
    run: (e) => {
      on = !on;
      send({ type: 'auto-fix-pr-checks', sessionId: s.sessionId, enabled: on });
      const t = e.currentTarget.querySelector('.context-menu-trailing');
      if (t) t.innerHTML = on ? CHECK_ICON : '';
    },
  };
}

// Shared "Auto-merge when checks pass" toggle, sibling to autoFixMenuItem. When
// on, the server merges this session's PR on the passing transition. Defaults
// OFF (merging is consequential), so the optimistic tick starts blank.
function autoMergeMenuItem(s) {
  let on = Boolean(s.autoMergeOnPass);
  return {
    label: 'Auto-merge when checks pass',
    icon: GITHUB_ICON,
    trailing: on ? CHECK_ICON : '',
    keepOpen: true,
    run: (e) => {
      on = !on;
      send({ type: 'auto-merge-on-pass', sessionId: s.sessionId, enabled: on });
      const t = e.currentTarget.querySelector('.context-menu-trailing');
      if (t) t.innerHTML = on ? CHECK_ICON : '';
    },
  };
}

// "Peer review session": open the dispatch dialog pre-filled to launch a fresh
// session that reviews this one's work — same folder (so it sees the live,
// uncommitted WIP), the complementary agent (Claude↔Codex), and a seeded review
// prompt. Shares the dir without owning a worktree — see the review-session design.
function peerReviewSession(sessionId) {
  const s = latestSessions.find((sess) => sess.sessionId === sessionId);
  if (!s) return;
  openDispatch(assignedTaskId(sessionId), reviewDispatchOpts(sessionId, s));
}

// Promote ("Detach"): clear parentSession, moving a nested child (and any of
// its OWN children, untouched) to the top level. Quiet — no confirm dialog
// (reversible: Attach undoes it) and no success toast; the board re-renders
// off the next graph push. Failure (e.g. a workflow-worker guard) surfaces
// via the generic {type:'error'} handler's toast.
function promoteSession(sessionId) {
  send({ type: 'detach', sessionId });
}

// Attach: nest `sessionId` under `parentSessionId`. Same quiet, no-toast
// pattern as promoteSession.
function attachSession(sessionId, parentSessionId) {
  send({ type: 'attach', sessionId, parentSessionId });
}

// "Attach to…" flyout items (opened via buildMenuEl's `submenu` support, a
// true child menu beside its trigger row — see openSubMenu): every other
// session on this one's task/bucket, excluding itself, its current parent,
// and its own current descendants (attachCandidates), the recorded spawner
// pinned first (orderAttachCandidates) and tagged, each label indented by its
// CURRENT nesting depth so the picker shows the tree shape being chosen into.
function attachMenuItems(sessionId) {
  const s = latestSessions.find((sess) => sess.sessionId === sessionId);
  if (!s) return [];
  const byId = new Map(latestSessions.map((sess) => [sess.sessionId, sess]));
  const candidates = orderAttachCandidates(attachCandidates(sessionId, latestSessions, assignedTaskId), s.spawnedBy);
  return candidates.map((c) => {
    const depth = nestingDepth(c, byId);
    const prefix = depth ? '— '.repeat(depth) : '';
    const spawnerTag = c.sessionId === s.spawnedBy ? ' (spawner)' : '';
    return { label: `${prefix}${c.label}${spawnerTag}`, icon: ATTACH_ICON, run: () => attachSession(sessionId, c.sessionId) };
  });
}

function openCardMenu(sessionId, x, y) {
  const s = latestSessions.find((sess) => sess.sessionId === sessionId);
  if (!s) return;
  const snoozed = isAsleep(s);
  const byId = new Map(latestSessions.map((sess) => [sess.sessionId, sess]));
  // Rename edits the panel title, so select first to open the panel — exactly
  // what the pencil button assumes. Fork/Archive act on the id directly.
  const items = [
    { label: 'Rename', icon: PENCIL_ICON, run: () => { selectSession(sessionId); beginRename(sessionId); } },
    ...(!snoozed ? [{ label: 'Fork', icon: FORK_ICON, run: () => openFork(sessionId) }] : []),
    ...(!snoozed ? [{ label: 'Peer review session…', icon: PLUS_ICON, run: () => peerReviewSession(sessionId) }] : []),
    { label: 'View diff', icon: DIFF_ICON, trailing: KBD_DIFF, run: () => openDiffPanel(sessionId) },
    ...(s.exitOutput ? [{ label: 'Show last output', icon: ROBOT_ICON, run: () => selectSession(sessionId) }] : []),
    { sep: true },
    ...(snoozed ? [
      { label: 'Unsnooze', icon: CLOCK_ICON, run: () => wakeSession(sessionId) },
      { label: 'Extend snooze…', icon: CLOCK_ICON, run: () => openSnoozeMenu(sessionId, x, y) },
    ] : [
      { label: 'Snooze…', icon: CLOCK_ICON, run: () => openSnoozeMenu(sessionId, x, y) },
      unread.has(sessionId)
        ? { label: 'Mark read', icon: BELL_ICON, run: () => setUnread(sessionId, false) }
        : { label: 'Mark unread', icon: BELL_ICON, run: () => setUnread(sessionId, true) },
    ]),
    // The PR-check toggles are per-session settings, not actions — set them off behind
    // their own divider, just above Archive, rather than mixed in with the actions.
    ...(!snoozed ? [{ sep: true }, autoFixMenuItem(s), autoMergeMenuItem(s)] : []),
    { sep: true },
    // Restart (kill tmux + relaunch with --resume) only makes sense while the
    // session is live; a dormant/snoozed card already offers Resume elsewhere.
    ...(s.managed ? [{ label: 'Restart', icon: RESTART_ICON, run: () => restartSession(sessionId) }] : []),
    // Promote is offered only for a nested session, and never for a workflow
    // worker (its orchestrator's autopilot run tracks it — promoting would
    // desync that). Attach is offered whenever there's at least one valid
    // same-task target to attach under.
    ...(s.parentSession && !isWorkflowWorker(s, byId) ? [{ label: 'Promote to full session', icon: PROMOTE_ICON, run: () => promoteSession(sessionId) }] : []),
    ...(attachCandidates(sessionId, latestSessions, assignedTaskId).length ? [{ label: 'Attach to…', icon: ATTACH_ICON, submenu: attachMenuItems(sessionId) }] : []),
    { label: 'Archive', icon: ARCHIVE_ICON, danger: true, run: () => archiveSession(sessionId) },
  ];
  mountMenu(items, x, y);
}

// The session pane header's "Actions" overflow menu — the inline icon row
// collapsed into one menu. Anchored under the Actions button; reuses the same
// mountMenu primitive as the card right-click menu. Mirrors that menu's
// fork/snooze entries but drops Rename (the title double-click owns it).
function openActionsMenu(sessionId, x, y) {
  const s = latestSessions.find((sess) => sess.sessionId === sessionId);
  if (!s) return;
  const byId = new Map(latestSessions.map((sess) => [sess.sessionId, sess]));
  const items = [
    { label: 'Fork session', icon: FORK_ICON, trailing: KBD_FORK, run: () => openFork(sessionId) },
    { label: 'Peer review session…', icon: PLUS_ICON, trailing: KBD_PEER_REVIEW, run: () => peerReviewSession(sessionId) },
    { label: 'View diff', icon: DIFF_ICON, trailing: KBD_DIFF, run: () => openDiffPanel(sessionId) },
    ...(s.managed ? [{ label: 'Open terminal', icon: TERMINAL_ICON, trailing: KBD_TERMINAL, run: () => send({ type: 'open-terminal-for-session', sessionId }) }] : []),
    isAsleep(s)
      ? { label: 'Unsnooze', icon: CLOCK_ICON, trailing: KBD_SNOOZE, run: () => wakeSession(sessionId) }
      : { label: 'Snooze…', icon: CLOCK_ICON, trailing: KBD_SNOOZE, run: () => openSnoozeMenu(sessionId, x, y) },
    autoFixMenuItem(s),
    autoMergeMenuItem(s),
    { sep: true },
    ...(s.managed ? [{ label: 'Restart', icon: RESTART_ICON, trailing: KBD_RESTART, run: () => restartSession(sessionId) }] : []),
    ...(s.parentSession && !isWorkflowWorker(s, byId) ? [{ label: 'Promote to full session', icon: PROMOTE_ICON, run: () => promoteSession(sessionId) }] : []),
    ...(attachCandidates(sessionId, latestSessions, assignedTaskId).length ? [{ label: 'Attach to…', icon: ATTACH_ICON, submenu: attachMenuItems(sessionId) }] : []),
    { label: 'Stop & archive', icon: ARCHIVE_ICON, danger: true, run: () => archiveSession(sessionId) },
  ];
  mountMenu(items, x, y);
}

// The task tile's kebab menu — the header's action buttons collapsed into one menu,
// reusing the same mountMenu primitive as the card/pane menus. `taskId` is the bucket
// id (a real task id or ADHOC_ID). Distinct from openTaskMenu (the cell right-click
// menu with New session/New TODO/Rename): this is the header kebab, view actions plus
// memory/delete. The adhoc tile can't be renamed/deleted and has no memory, so it gets
// only the view actions (Focus/Minimise/Sort). Sort is a keepOpen toggle with a tick,
// like autoFixMenuItem.
function openTaskActionsMenu(taskId, x, y) {
  const isAdhoc = taskId === ADHOC_ID;
  const task = isAdhoc ? null : latestTasks.tasks.find((t) => t.id === taskId);
  if (!isAdhoc && !task) return;
  const sortOn = activitySortedTasks.has(taskId);
  const items = [
    { label: 'Focus', icon: FOCUS_ICON, run: () => focusOnly(taskId) },
    { label: 'Minimise', icon: MINIMISE_ICON, run: () => minimise(taskId) },
    { label: 'Sort by activity', icon: SORT_ICON, keepOpen: true, trailing: sortOn ? CHECK_ICON : '',
      run: (e) => {
        toggleActivitySort(taskId);
        const now = activitySortedTasks.has(taskId);
        const slot = e.currentTarget.querySelector('.context-menu-trailing');
        if (slot) slot.innerHTML = now ? CHECK_ICON : '';
      } },
    ...(isAdhoc ? [] : [
      { sep: true },
      ...(taskMemoryEnabled ? [{ label: 'Task memory', icon: MEMORY_ICON, run: () => openMemory(taskId) }] : []),
      { label: 'Archive task', icon: ARCHIVE_ICON, danger: true, run: () => archiveTask(taskId, task.name) },
    ]),
  ];
  mountMenu(items, x, y);
}

// Second-level menu: pick a snooze duration. Each preset resolves to an absolute
// `until` via the pure module. (A custom date/time picker is a day-2 follow-up.)
function openSnoozeMenu(sessionId, x, y) {
  const now = Date.now();
  const setUntil = (until) => {
    if (!until) return;
    // Presets are instant and comment-less — the note field lives only on the
    // Custom modal (snoozeSetMessage carries no comment when none is given).
    send(snoozeSetMessage(sessionId, until));
    // Snoozing sets a session aside — if it's the one open, close its view (and
    // clear the #session deep link, so a refresh doesn't reopen it). Detaches the
    // terminal only; the tmux session keeps running.
    if (sessionId === selectedSessionId) deselectSession();
  };
  const items = [
    { label: '1 hour', icon: CLOCK_ICON, run: () => setUntil(resolveUntil('1h', now)) },
    { label: '4 hours', icon: CLOCK_ICON, run: () => setUntil(resolveUntil('4h', now)) },
    { label: 'Until tomorrow (8am)', icon: CLOCK_ICON, run: () => setUntil(resolveUntil('tomorrow', now)) },
    { label: 'Next week (Mon 8am)', icon: CLOCK_ICON, run: () => setUntil(resolveUntil('next-week', now)) },
    { sep: true },
    { label: 'Custom…', icon: CLOCK_ICON, run: () => openCustomSnooze(sessionId) },
  ];
  mountMenu(items, x, y);
}

function archiveTaskFromCell(cell) {
  archiveTask(cell.dataset.taskid, cell.querySelector('.task-name').textContent);
}

// Archive a task: sets it aside (durably — see taskStore.archiveTask) rather
// than deleting it, and cascade-archives any of its currently-live sessions the
// same way "Archive all" does for a session's descendant tree. Only that live
// cascade is consequential enough to confirm; an empty task archives instantly
// with the same delete-style Restore-toast UX. The final toast waits for the
// server's task-archived reply (not fired optimistically here) since the
// cascade's kill-jobs-first wait can take several seconds per session.
async function archiveTask(taskId, name) {
  const liveCount = latestSessions.filter((s) => assignedTaskId(s.sessionId) === taskId).length;
  if (liveCount > 0) {
    const result = await confirmDialog({
      title: 'Archive this task?',
      body: `"${name}" has ${liveCount} running session${liveCount > 1 ? 's' : ''}. Archiving the task archives ${liveCount > 1 ? 'them' : 'it'} too — stopped and moved into History, individually resumable later. The task itself can be restored from History at any time, exactly as it is now.`,
      okLabel: 'Archive task',
      danger: true,
    });
    if (result !== 'ok') return;
    toast('Archiving task…');
  }
  send({ type: 'task-archive', taskId });
}

// Restore a task from History (a later, deliberate action — unlike the toast's
// immediate force-restore right after archiving). Counts sessions still
// cascade-archived with this task (viaTaskArchive) fresh at click time, so a
// session already resumed individually since the archive isn't double-counted
// or double-resumed. Zero cascaded sessions skips the dialog entirely — there's
// nothing to choose between.
export async function restoreTaskWithPrompt(taskId, name) {
  const cascadeCount = latestHistory.filter((h) => h.viaTaskArchive === taskId).length;
  if (!cascadeCount) {
    send({ type: 'task-unarchive', taskId, restoreSessions: false });
    toast('Task restored');
    return;
  }
  const result = await confirmDialog({
    title: `Restore "${name}"?`,
    body: `This task has ${cascadeCount} session${cascadeCount > 1 ? 's' : ''} that ${cascadeCount > 1 ? 'were' : 'was'} archived along with it. Restore ${cascadeCount > 1 ? 'them' : 'it'} too?`,
    okLabel: 'Restore task + sessions',
    extraLabel: 'Task only',
  });
  if (result === 'cancel') return;
  send({ type: 'task-unarchive', taskId, restoreSessions: result === 'ok' });
  toast(result === 'ok' ? 'Task and sessions restored' : 'Task restored');
}

function openTaskMenu(cell, x, y) {
  const isNoTask = cell.dataset.entity === 'no-task';
  const taskId = isNoTask ? null : cell.dataset.taskid;
  const todoZone = cell.querySelector('.todo-zone');
  const items = [
    { label: 'New session', icon: TERMINAL_ICON, run: () => openDispatch(taskId) },
    { label: 'New TODO', icon: CHECK_ICON, run: () => { if (todoZone) beginTodoAdd(todoZone.dataset.todoKey, todoZone); } },
    ...(!isNoTask ? [
      ...(taskMemoryEnabled ? [{ label: 'Open memory', icon: MEMORY_ICON, run: () => openMemory(taskId) }] : []),
      { label: 'Rename', icon: PENCIL_ICON, run: () => beginTaskRename(cell) },
      { sep: true },
      { label: 'Archive task', icon: ARCHIVE_ICON, danger: true, run: () => archiveTaskFromCell(cell) },
    ] : []),
  ];
  mountMenu(items, x, y);
}

// HTML5 drag-and-drop. Sessions carry {kind:'session', sessionId}; task headers
// carry {kind:'task', taskId} for reordering; todo rows carry {kind:'todo',
// todoId, fromTaskId} to move across tiles.
function wireGridDnd(el) {
  // Task reordering is handled on the persistent #grid element, not per-cell:
  // each dragover re-renders the packed board (the swap preview reflows columns),
  // which would destroy a cell's own listeners mid-drag and can slide the
  // placeholder or a ghost cell under the cursor. Listening on #grid (wired once)
  // means moves and drops register anywhere on the board, and the swap target is
  // derived from tile geometry rather than whatever element is under the cursor.
  if (!el._taskDndWired) {
    el._taskDndWired = true;
    el.addEventListener('dragover', (e) => {
      if (!taskDragActive) return;
      e.preventDefault();
      const t = taskTargetAt(e.clientX, e.clientY);
      // Over a gap/placeholder → keep the current target so the preview is steady.
      if (t === draggedTaskId) {
        // Back over the tile's OWN origin (its slot in the snapshot taken at
        // drag-start) → clear the preview so a drop here is a genuine no-op.
        // Without this, hovering back over your own start left the LAST real
        // target sticky: commitTaskSwap swaps with whatever you hovered over
        // last, not with "nowhere," so dropping back "where it was" silently
        // performed the earlier swap anyway — there was no way to cancel a
        // preview short of aborting the whole drag (Escape / drop off-board).
        if (taskSwapTargetId !== null) { taskSwapTargetId = null; renderGrid(); }
      } else if (t && t !== taskSwapTargetId) {
        taskSwapTargetId = t;
        renderGrid();
      }
    });
    el.addEventListener('drop', (e) => {
      if (!taskDragActive) return;
      e.preventDefault();
      commitTaskSwap();
    });
  }

  // A workflow box drags as one unit (its data-sid is the orchestrator's); the
  // orchestrator card nested inside is draggable="false" so it never starts its own
  // drag — only the box does. A plain parent-with-children (or a workflow box that
  // also has a live team) is wrapped one level further in a .child-group (cards.js
  // childGroupHtml/renderTileCards), which is what carries data-sid + draggable
  // there — the card/box nested inside is rendered non-draggable (`nested`) for the
  // same reason the orchestrator card is. Without this, the card nested inside a
  // .child-group would still be independently draggable, but sitting one DOM level
  // too deep: the placeholder would land inside the wrapper instead of .task-body,
  // and the wrapper itself (having no data-sid) would silently drop out of the
  // reordered array the drop handler below reconstructs — the parent then ranks
  // Infinity (orderSessions) and keeps sinking to the bottom on every unrelated
  // drag in that task. A snoozed row carries the same data-sid + draggable
  // contract, so it gets identical wiring — its drop reassigns via task-assign and
  // the card stays snoozed (snooze lives on the mapping entry, untouched by assign).
  el.querySelectorAll('.session-card[draggable="true"], .workflow-box[draggable="true"], .child-group[draggable="true"], .snoozed-row[draggable="true"]').forEach((card) => {
    card.addEventListener('dragstart', (e) => {
      if (e.target.closest('.link-chip')) { e.preventDefault(); return; }
      e.stopPropagation();
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', JSON.stringify({ kind: 'session', sessionId: card.dataset.sid }));
      draggedCard = card;
      dragActive = true;
      armNewTask(true); // reveal the "drop to create" landing area immediately
      // Defer one tick: the native drag image (the floating card) is
      // snapshotted synchronously now, so the card must still look intact. Then
      // hide the source and drop a single placeholder into its slot.
      setTimeout(() => {
        if (draggedCard !== card || !card.parentNode) return;
        const ph = ensurePlaceholder();
        ph.style.height = `${card.offsetHeight}px`;
        card.parentNode.insertBefore(ph, card);
        card.classList.add('dragging-hidden');
      }, 0);
    });
    card.addEventListener('dragend', () => {
      card.classList.remove('dragging-hidden');
      removePlaceholder();
      draggedCard = null;
      dragActive = false;
      armNewTask(false);
      // The hidden source + placeholder only ever touched this client's DOM;
      // rebuild from canonical order (a committed drop updated it optimistically).
      if (currentView === 'grid') renderGrid();
    });
    // Placeholder positioning lives entirely in the cell dragover handler below,
    // which computes the slot from the cursor Y against the card midpoints.
  });
  // A TODO row drags across tiles to reassign (→ todo-move). It carries its own
  // key so the drop handler can build the wire payload without touching session DnD.
  el.querySelectorAll('.todo-row[draggable="true"]').forEach((row) => {
    row.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', JSON.stringify({
        kind: 'todo', todoId: row.dataset.todoid, fromTaskId: row.dataset.todoKey,
      }));
      setTimeout(() => { if (row.parentNode) row.classList.add('dragging-hidden'); }, 0);
    });
    row.addEventListener('dragend', () => {
      row.classList.remove('dragging-hidden');
      if (currentView === 'grid') renderGrid();
    });
  });
  el.querySelectorAll('.task-head[draggable="true"]').forEach((head) => {
    const cell = head.closest('.task-cell');
    const id = cell.dataset.entity === 'no-task' ? ADHOC_ID : cell.dataset.taskid;
    head.addEventListener('dragstart', (e) => {
      if (e.target.closest('.link-chip')) { e.preventDefault(); return; }
      e.stopPropagation();
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', JSON.stringify({ kind: 'task', taskId: id }));
      draggedTaskId = id;
      taskDragActive = true;
      taskSwapTargetId = null; // no swap previewed until the cursor reaches a tile
      taskCellRects = snapshotTaskCellRects(); // see taskTargetAt
    });
    head.addEventListener('dragend', () => {
      taskDragActive = false;
      draggedTaskId = null;
      taskSwapTargetId = null;
      taskCellRects = null;
      // Rebuild from canonical order (a committed drop updated it optimistically).
      if (currentView === 'grid') renderGrid();
    });
  });

  el.querySelectorAll('.new-task-drop').forEach((g) => {
    g.addEventListener('dragover', (e) => { e.preventDefault(); g.classList.add('drop'); });
    g.addEventListener('dragleave', () => g.classList.remove('drop'));
    g.addEventListener('drop', (e) => {
      e.preventDefault();
      g.classList.remove('drop');
      let p;
      try { p = JSON.parse(e.dataTransfer.getData('text/plain')); } catch { return; }
      if (p.kind === 'session') createTask(p.sessionId);
    });
  });

  el.querySelectorAll('.task-cell').forEach((cell) => {
    cell.addEventListener('dragover', (e) => {
      e.preventDefault();
      // A task reorder is driven by the #grid handler above; the cell just stays
      // out of the way (no drop-target highlight) and lets the event bubble.
      if (taskDragActive) return;
      // Same-task reorder in progress (the hidden source lives in this cell):
      // the placeholder is the only affordance, so skip the cell highlight and
      // slide it to the slot the cursor points at. An activity-sorted bucket owns
      // its own order, so the placeholder stays put — no reorder preview.
      if (placeholderEl && cell.contains(draggedCard)) {
        const bucket = cell.dataset.entity === 'no-task' ? ADHOC_ID : cell.dataset.taskid;
        if (activitySortedTasks.has(bucket)) return;
        const body = cell.querySelector('.task-body');
        if (body) {
          const after = dragAfterElement(body, e.clientY);
          if (after) body.insertBefore(placeholderEl, after);
          else body.appendChild(placeholderEl);
        }
        return;
      }
      cell.classList.add('drop-target');
    });
    cell.addEventListener('dragleave', (e) => { if (!cell.contains(e.relatedTarget)) cell.classList.remove('drop-target'); });
    cell.addEventListener('drop', (e) => {
      e.preventDefault();
      cell.classList.remove('drop-target');
      let p;
      try { p = JSON.parse(e.dataTransfer.getData('text/plain')); } catch { return; }
      const isNoTask = cell.dataset.entity === 'no-task';
      const taskId = cell.dataset.taskid;
      if (p.kind === 'session') {
        // Same bucket (a task, or Ad-hoc for unassigned sessions) → reorder: build
        // the new order by walking the DOM, dropping the dragged session in at the
        // placeholder's slot and skipping its hidden source. Otherwise (re)assign
        // to this cell's task, or to Ad hoc when dropped on the unassigned tile.
        const bucket = isNoTask ? ADHOC_ID : taskId;
        const sameBucket = isNoTask ? !assignedTaskId(p.sessionId) : assignedTaskId(p.sessionId) === taskId;
        // An activity-sorted bucket has no manual order to write — a same-bucket drop
        // is a no-op (dragend rebuilds from canonical order). Cross-bucket still reassigns.
        if (bucket && sameBucket && activitySortedTasks.has(bucket)) return;
        if (bucket && sameBucket && placeholderEl) {
          const body = cell.querySelector('.task-body');
          const order = [];
          for (const node of body.children) {
            if (node === placeholderEl) order.push(p.sessionId);
            // A workflow box, or a .child-group wrapping a parent-with-children, is
            // a direct child standing in for its top-level session; its
            // workers/child-spine live nested inside and are never separate order
            // entries. Without the .child-group branch, a parent-with-children has
            // no data-sid at this level and silently drops out of `order` on every
            // drag in its task — it then ranks Infinity (orderSessions) and sinks to
            // the bottom regardless of where it's actually dropped.
            else if (node !== draggedCard && (node.classList.contains('session-card') || node.classList.contains('workflow-box') || node.classList.contains('child-group'))) order.push(node.dataset.sid);
          }
          latestTasks.sessionOrder = latestTasks.sessionOrder || {};
          latestTasks.sessionOrder[bucket] = order; // optimistic; server confirms on next graph
          send({ type: 'task-reorder-sessions', taskId: bucket, order });
        } else send({ type: 'task-assign', sessionId: p.sessionId, taskId: isNoTask ? null : taskId });
      } else if (p.kind === 'todo') {
        const toTaskId = todoKeyToTaskId(isNoTask ? ADHOC_ID : taskId);
        const from = todoKeyToTaskId(p.fromTaskId);
        if ((from || ADHOC_ID) !== ((toTaskId || ADHOC_ID))) {
          send({ type: 'todo-move', todoId: p.todoId, fromTaskId: from, toTaskId });
          // Optimistic update: splice client-side state and re-render immediately.
          const todos = latestTasks.todos || (latestTasks.todos = {});
          const fromKey = p.fromTaskId || ADHOC_ID;
          const toKey = toTaskId || ADHOC_ID;
          const fromList = todos[fromKey] || [];
          const i = fromList.findIndex((td) => td.id === p.todoId);
          if (i >= 0) {
            const [td] = fromList.splice(i, 1);
            (todos[toKey] || (todos[toKey] = [])).push(td);
            renderGrid();
          }
        }
      }
      // Task drops are handled by the #grid drop handler (commits at the
      // current slot wherever the cursor lands).
    });
  });
}

// Snapshot of every task-cell's id + rect, taken once at drag-start (before any
// swap preview has ever applied) — the canonical, un-swapped geometry.
function snapshotTaskCellRects() {
  return [...document.getElementById('grid').querySelectorAll('.task-cell')].map((c) => ({
    id: c.dataset.entity === 'no-task' ? ADHOC_ID : c.dataset.taskid,
    rect: c.getBoundingClientRect(),
  }));
}

// The tile id under the cursor at (x, y), or null over a gap/ghost/placeholder.
// Hit-tests the geometry CACHED at drag-start (taskCellRects), never the live
// DOM. The live DOM reflects whatever swap the cursor last previewed, and that's
// self-referential: swapping tile A out from under the cursor can put tile B
// there; B's own hit-test then flips the preview back to A, which puts A back
// under the cursor — an infinite flicker between the two states every dragover,
// even with the cursor perfectly still. Confirmed with both the old and new
// packing algorithm, so it's the live-DOM hit-test that's at fault, not either
// packer. A fixed pre-drag snapshot breaks the loop: the target only changes
// when the cursor actually moves to a different cell in the ORIGINAL layout.
function taskTargetAt(x, y) {
  const rects = taskCellRects || snapshotTaskCellRects();
  for (const { id, rect: r } of rects) {
    if (x >= r.left && x < r.right && y >= r.top && y < r.bottom) return id;
  }
  return null;
}

// Swap the dragged tile with the hovered target in the order. Optimistic —
// server confirms on the next graph push.
//
// Deliberately NOT sending the full localSwapPlacement-derived order here: a
// mixed-span, cross-column swap's local restack can leave one column past the
// board's total/cols "fair share" target, and computeLayout's fresh recompute
// on ANY resulting order (this plain swap or a column-serialized one — tried
// both) then reshuffles tiles that were never part of the drag to force
// everything back near-equal — so the committed layout can differ from the
// live preview regardless of which order we send. Fixing that needs the
// server to persist an explicit 2-D position, not infer one from a 1-D order;
// out of scope here. This plain swap is the smallest correct thing: it's
// exactly what full order-serialization reduces to for same-span and
// same-column swaps (the cases that DO commit consistently today).
function commitTaskSwap() {
  if (!draggedTaskId || !taskSwapTargetId || taskSwapTargetId === draggedTaskId) return;
  const order = currentOrder();
  const i = order.indexOf(draggedTaskId);
  const j = order.indexOf(taskSwapTargetId);
  if (i < 0 || j < 0) return;
  [order[i], order[j]] = [order[j], order[i]];
  latestTasks.order = order;
  send({ type: 'task-reorder', taskId: draggedTaskId, targetId: taskSwapTargetId });
}

// Swap a task's name span for an inline input. Enter/blur commits, Escape cancels.
function beginTaskRename(cell) {
  const taskId = cell.dataset.taskid;
  if (!taskId) return;
  const nameEl = cell.querySelector('.task-name');
  if (!nameEl || nameEl.querySelector('input')) return;
  const current = nameEl.textContent;
  nameEl.innerHTML = `<input class="task-name-input" value="${esc(current)}">`;
  const input = nameEl.querySelector('input');
  input.focus();
  input.select();
  let settled = false;
  const finish = (save) => {
    if (settled) return;
    settled = true;
    const name = input.value.trim();
    if (save && name && name !== current) {
      send({ type: 'task-rename', taskId, name });
      const t = latestTasks.tasks.find((x) => x.id === taskId);
      if (t) t.name = name; // optimistic; server confirms on next graph
    }
    renderGrid();
  };
  input.addEventListener('keydown', (e) => {
    // stopPropagation: finish() synchronously re-renders this input away, so a
    // bubbling Enter would reach the window handler with the input already gone —
    // the isTypingTarget guard would miss it and a selected "new session" slot
    // would wrongly open the dispatch modal.
    if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
  input.addEventListener('click', (e) => e.stopPropagation());
}

function wireTaskControls(el) {
  el.querySelectorAll('.link-overflow').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeOverflowMenu();
      let links;
      try { links = JSON.parse(btn.dataset.overflowLinks || '[]'); } catch { return; }
      const r = btn.getBoundingClientRect();
      const menu = document.createElement('div');
      menu.className = 'link-overflow-menu';
      menu.innerHTML = linkChipsHtml(links, cardCtx());
      menu.style.visibility = 'hidden';
      document.body.appendChild(menu);
      const mw = menu.offsetWidth, mh = menu.offsetHeight;
      const left = Math.max(4, Math.min(r.right - mw, window.innerWidth - mw - 4));
      const top = r.bottom + 5 + mh > window.innerHeight ? r.top - mh - 5 : r.bottom + 5;
      menu.style.top = `${top}px`;
      menu.style.left = `${left}px`;
      menu.style.visibility = '';
      overflowMenuEl = menu;
      document.addEventListener('mousedown', onOverflowMenuDismiss, true);
    });
  });

  el.querySelectorAll('.task-new-sess, .empty-new-sess, .new-sess-row').forEach((b) =>
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      const cell = b.closest('.task-cell');
      openDispatch(cell.dataset.entity === 'no-task' ? null : cell.dataset.taskid);
    })
  );
  el.querySelectorAll('.task-actions-btn').forEach((b) =>
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      const cell = b.closest('.task-cell');
      const id = cell.dataset.entity === 'no-task' ? ADHOC_ID : cell.dataset.taskid;
      const r = b.getBoundingClientRect();
      openTaskActionsMenu(id, r.left, r.bottom + 4);
    })
  );
  el.querySelectorAll('.task-cell:not(.no-task) .task-name').forEach((n) =>
    n.addEventListener('dblclick', (e) => { e.stopPropagation(); beginTaskRename(n.closest('.task-cell')); })
  );
  el.querySelectorAll('.todo-text').forEach((n) => {
    n.addEventListener('click', (e) => { e.stopPropagation(); beginTodoEdit(n); });
    n.addEventListener('mouseenter', () => showTodoTooltip(n));
    n.addEventListener('mouseleave', hideTodoTooltip);
  });
  el.querySelectorAll('.todo-spawn').forEach((b) =>
    b.addEventListener('click', (e) => { e.stopPropagation(); spawnTodo(b); })
  );
  el.querySelectorAll('.todo-del').forEach((b) =>
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      const row = b.closest('.todo-row');
      const key = row.dataset.todoKey, todoId = row.dataset.todoid;
      send({ type: 'todo-delete', taskId: todoKeyToTaskId(key), todoId });
      const arr = (latestTasks.todos || {})[key];
      if (arr) {
        latestTasks.todos[key] = arr.filter((x) => x.id !== todoId);
        renderGrid();
      }
    })
  );
}

// Inject an inline input into the todo zone. Enter/blur commits, Escape cancels.
function beginTodoAdd(key, zone) {
  if (!zone) return;
  // Force the zone visible before injecting — it may be display:none when empty.
  zone.style.display = 'flex';
  zone.innerHTML = `<input class="todo-add-input" placeholder="New TODO…">`;
  const input = zone.querySelector('.todo-add-input');
  input.focus();
  let settled = false;
  const finish = (save) => {
    if (settled) return;
    settled = true;
    const text = input.value.trim();
    if (save && text) {
      send({ type: 'todo-add', taskId: todoKeyToTaskId(key), text });
      latestTasks.todos = latestTasks.todos || {};
      (latestTasks.todos[key] || (latestTasks.todos[key] = [])).push({ id: `tmp_${Date.now()}`, text, createdAt: Date.now() });
    }
    renderGrid();
  };
  input.addEventListener('keydown', (e) => {
    // stopPropagation: finish() synchronously re-renders this input away, so a
    // bubbling Enter would reach the window handler with the input already gone —
    // the isTypingTarget guard would miss it and a selected "new session" slot
    // would wrongly open the dispatch modal.
    if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
  input.addEventListener('click', (e) => e.stopPropagation());
}

let todoTooltipEl = null;
function todoTooltip() {
  if (!todoTooltipEl) {
    todoTooltipEl = document.createElement('div');
    todoTooltipEl.className = 'todo-tooltip';
    document.body.appendChild(todoTooltipEl);
  }
  return todoTooltipEl;
}
function showTodoTooltip(span) {
  if (span.scrollWidth <= span.clientWidth) return;
  const tip = todoTooltip();
  tip.textContent = span.textContent;
  const r = span.getBoundingClientRect();
  tip.style.left = `${Math.round(r.left)}px`;
  tip.style.maxWidth = `${Math.max(160, Math.min(Math.round(r.width * 1.6), window.innerWidth - 2 * TOOLTIP_MARGIN_PX))}px`;
  tip.classList.add('show');
  const t = tip.getBoundingClientRect();
  const { left, top } = tooltipPosition(r, t, { width: window.innerWidth, height: window.innerHeight });
  tip.style.left = `${left}px`;
  tip.style.top = `${top}px`;
}
function hideTodoTooltip() {
  if (todoTooltipEl) todoTooltipEl.classList.remove('show');
}

// Click-to-edit a todo row's text. Swap span -> input; Enter/blur commits, Escape cancels.
function beginTodoEdit(span) {
  const row = span.closest('.todo-row');
  if (!row) return;
  hideTodoTooltip();
  const key = row.dataset.todoKey, todoId = row.dataset.todoid;
  const current = span.textContent;
  span.innerHTML = `<input class="todo-text-input" value="${esc(current)}">`;
  const input = span.querySelector('.todo-text-input');
  input.focus();
  input.select();
  let settled = false;
  const finish = (save) => {
    if (settled) return;
    settled = true;
    const text = input.value.trim();
    if (save && text && text !== current) {
      send({ type: 'todo-edit', taskId: todoKeyToTaskId(key), todoId, text });
      const td = ((latestTasks.todos || {})[key] || []).find((x) => x.id === todoId);
      if (td) td.text = text;
    }
    renderGrid();
  };
  input.addEventListener('keydown', (e) => {
    // stopPropagation: finish() synchronously re-renders this input away, so a
    // bubbling Enter would reach the window handler with the input already gone —
    // the isTypingTarget guard would miss it and a selected "new session" slot
    // would wrongly open the dispatch modal.
    if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
  input.addEventListener('click', (e) => e.stopPropagation());
}

// Spawn a session from a TODO: open the dispatch modal pre-filled with the todo
// text, task locked to the todo's own bucket. The todo is consumed (deleted) on
// the 'dispatched' ack — pendingTodoConsume carries it there.
function spawnTodo(btn) {
  const row = btn.closest('.todo-row');
  if (!row) return;
  const key = row.dataset.todoKey, todoId = row.dataset.todoid;
  const td = todosFor(key).find((x) => x.id === todoId);
  if (!td) return;
  const taskId = todoKeyToTaskId(key);
  openDispatch(taskId, { intent: td.text, lockTask: true });
  pendingTodoConsume = { taskId, todoId, key };
}

// Ask the server to create a task; awaitingNewTask makes the new tile open in
// rename mode when it arrives. Optionally seed it with a session.
function createTask(sessionId) {
  awaitingNewTask = true;
  send({ type: 'task-create', sessionId });
}

function detectNewTask() {
  const ids = latestTasks.tasks.map((t) => t.id);
  if (awaitingNewTask) {
    const fresh = ids.find((id) => !prevTaskIds.has(id));
    if (fresh) { autoEditTaskId = fresh; awaitingNewTask = false; }
  }
  prevTaskIds = new Set(ids);
}

// Turn the "＋ New task" button into (armed) / out of a drop landing area.
// Armed the moment a session drag begins; hover adds the stronger "drop" state.
function armNewTask(on) {
  const btn = document.getElementById('new-task');
  if (btn) {
    btn.classList.toggle('armed', on);
    if (!on) btn.classList.remove('drop');
  }
  // Reveal the in-grid ghost drop targets too.
  const grid = document.getElementById('grid');
  if (grid) grid.classList.toggle('arming', on);
}

// Rail "＋ New task" button: click to create, or drop a session on it to
// create a task seeded with that session.
(function initNewTask() {
  const btn = document.getElementById('new-task');
  if (!btn) return;
  btn.addEventListener('click', () => createTask());
  btn.addEventListener('dragover', (e) => { e.preventDefault(); btn.classList.add('drop'); });
  btn.addEventListener('dragleave', () => btn.classList.remove('drop'));
  btn.addEventListener('drop', (e) => {
    e.preventDefault();
    let p;
    try { p = JSON.parse(e.dataTransfer.getData('text/plain')); } catch { armNewTask(false); return; }
    armNewTask(false);
    if (p.kind === 'session') createTask(p.sessionId);
  });
})();
// Track working→idle transitions: a finished session enters the persisted
// just-finished set and alarms (cyan flash) until you click it. No timer — the
// set is the source of truth, so the alarm survives refresh/restart and clears
// only on a click (acknowledge) or the session leaving idle. Going back through
// `working` is what re-arms a later finish, so no per-episode key is needed.
//
// The set is driven by a session's *settled* status, not its raw per-poll one:
// a scrape-classified session (no hook file, so rawStatus is null) flips
// idle↔working on whether "esc to interrupt" is in the pane, so a single noisy
// poll would flash the cyan alarm then yank it a tick later — exactly the
// flash-then-vanish you'd see on a session you never touched. Such a status only
// settles once observed on two consecutive polls. Hook-driven sessions (rawStatus
// set) are authoritative and don't flap, so they settle instantly — no latency
// hit on the common case; only the flappy scrape/resume-fork sessions pay the
// extra poll.
let prevStatusById = new Map(); // last *settled* status — drives the transition
let lastRawById = new Map();    // last raw observation — confirms a status settling

function settledStatus(s, prevSettled) {
  if (s.rawStatus != null) return s.status;
  return s.status === lastRawById.get(s.sessionId) ? s.status : (prevSettled ?? s.status);
}

function trackJustFinished(sessions) {
  const nextRaw = new Map();
  const nextSettled = new Map();
  let jfChanged = false;
  for (const s of sessions) {
    const prev = prevStatusById.get(s.sessionId);
    const settled = settledStatus(s, prev);
    if (prev === 'working' && settled === 'idle') { justFinished.add(s.sessionId); jfChanged = true; }
    if (settled !== 'idle' && justFinished.delete(s.sessionId)) jfChanged = true;
    // The needs-you ack re-arm stays on the raw status: needs-you is hook-driven
    // (never scraped), so it doesn't flap, and clearing an ack only ever re-arms
    // the alarm — the safe direction for an attention signal.
    if (s.status !== 'needs-you') acknowledgedAt.delete(s.sessionId);
    nextRaw.set(s.sessionId, s.status);
    nextSettled.set(s.sessionId, settled);
  }
  for (const sid of [...justFinished]) if (!nextSettled.has(sid) && justFinished.delete(sid)) jfChanged = true;
  // Drop unread bookmarks for sessions that have left the board (archived/gone) —
  // they'd never match a rendered card again. setUnread persists; mirror that here.
  let unreadChanged = false;
  for (const sid of [...unread]) if (!nextSettled.has(sid) && unread.delete(sid)) unreadChanged = true;
  if (unreadChanged) persistUnread();
  for (const sid of [...acknowledgedAt.keys()]) if (!nextSettled.has(sid)) acknowledgedAt.delete(sid);
  persistAcknowledged();
  if (jfChanged) persistJustFinished();
  prevStatusById = nextSettled;
  lastRawById = nextRaw;
}

// Post-archive toast with an immediate Resume action; drops the selection if the
// archived session was open. Shared by the manual archive button and the
// server-driven auto-archive on exit. `archivedIds` (default: just this session)
// is threaded to worktreeCleanupAction for a cascade, where every archived
// descendant must be excluded from the "still in use" check too.
function archivedToast(sessionId, text, worktree, archivedIds = [sessionId]) {
  if (selectedSessionId === sessionId) selectAfterArchive(sessionId);
  const actions = [{ label: 'Resume', onClick: () => { pendingSelect = sessionId; send({ type: 'resume', sessionId }); } }];
  const cleanup = worktreeCleanupAction(sessionId, worktree, archivedIds);
  if (cleanup) actions.push(cleanup);
  const stopContainer = containerStopAction(sessionId, archivedIds);
  if (stopContainer) actions.push(stopContainer);
  // A worktree cleanup or a container-stop offer is worth acting on deliberately,
  // so give it the longer 15s window (and the bar lets the user see it); plain
  // archives keep 10s.
  toast(text, false, { actions, duration: (cleanup || stopContainer) ? 15000 : 10000 });
}

// The "Stop container" button for an archived devcontainer session: `devcontainer
// up` leaves its container running indefinitely, so offer to stop it and reclaim
// the RAM. Mirrors worktreeCleanupAction (offered on the toast, never automatic —
// leaving it up keeps resume fast, so stopping is the user's explicit choice), and
// like it is WITHHELD while another tracked devcontainer session still shares the
// same cwd/container (a dispatch/resume/fork against the same repo reuse one) — see
// containerStillInUse. Reads runtime/cwd off the still-present board node (archive
// is deferred server-side, so `latestSessions` still holds the target at toast
// time). `archivedIds` excludes the session(s) archived in this same operation.
function containerStopAction(sessionId, archivedIds = [sessionId]) {
  const s = latestSessions.find((x) => x.sessionId === sessionId);
  if (!s || s.runtime !== 'devcontainer' || !s.cwd) return null;
  if (containerStillInUse(s.cwd, latestSessions, archivedIds)) return null;
  return { label: 'Stop container', onClick: () => send({ type: 'stop-container', sessionId }) };
}

// Archiving the open session shouldn't fling the selection to some OTHER task:
// land on a same-task session card (the one above it, or else the next one down)
// if the tile still has one. If not — the archived session was the tile's last —
// don't light up its "new session" slot either; that reads as the board inviting
// you to start something, when really nothing is left to point at. Just deselect.
// A no-longer-present session (or an empty board) also just deselects.
function selectAfterArchive(sessionId) {
  const group = navTileGroups().find((g) => g.targets.some((t) => t.sid === sessionId));
  const i = group ? group.targets.findIndex((t) => t.sid === sessionId) : -1;
  const candidate = i < 0 ? null : (group.targets[i - 1] || group.targets[i + 1]);
  const neighbour = candidate?.sid != null ? candidate : null;
  // selectSession() re-renders the sidebar for a *live* session, which closes the
  // old terminal itself. deselectSession() closes it too, so either branch leaves
  // no stranded terminal behind (e.g. tmux's dead-pane "[exited]").
  if (neighbour) applyNavTarget(neighbour);
  else deselectSession();
}

// The cleanup button for an archived worktree session: delete the worktree dir
// while it exists, else offer its lingering branch, else nothing. The server is
// authoritative — these only pick which message to send. `worktree` is the
// node's `{ path, branch, dirExists, branchExists }` (or null). Refuses to offer
// deletion while some OTHER tracked session (any relationship) still points at
// that exact directory — e.g. a review sharing its reviewed session's cwd with
// no worktree of its own — since deleting it would pull the rug out from under
// it. `archivedIds` (default: just this session) excludes sessions already known
// to be archived in the SAME operation (a cascade's target + descendants),
// computed off the same descendant list the dialog used rather than a
// network round-trip — see worktreeStillInUse.
function worktreeCleanupAction(sessionId, worktree, archivedIds = [sessionId]) {
  if (!worktree) return null;
  if (worktreeStillInUse(worktree.path, latestSessions, archivedIds)) return null;
  if (worktree.dirExists) return { label: 'Delete worktree', onClick: () => send({ type: 'worktree-remove', sessionId }) };
  if (worktree.branchExists) return { label: 'Delete branch', onClick: () => send({ type: 'branch-delete', sessionId }) };
  return null;
}

// Archive a session: stop its process and move it to History. No confirm prompt —
// the toast offers an immediate Resume, and it's recoverable from History anyway.
// A worktree-backed session also gets a cleanup action on the toast.
// EXCEPT when it has a live background job: killing the pane kills that job
// outright, with no chance for the agent to wrap it up or report back — so this
// one case gets an upfront 3-way choice instead. (On Claude this is also what
// produces the "No completion record was found" noise on the next resume; Codex
// degrades more gracefully there, but the interrupted-job risk is the same for
// both, so the wording below stays agent-neutral rather than naming that one
// Claude-specific symptom.)
//
// A session with any not-yet-archived descendant (a workflow worker, a review,
// any nested child) gets a DIFFERENT upfront choice instead — archiving it alone
// would strand live/dormant children as orphan cards with no warning. See the
// child-sessions design §5.
async function archiveSession(sessionId) {
  const s = latestSessions.find((x) => x.sessionId === sessionId);
  const { count, descendants } = s ? cascadeSummary(s, latestSessions) : { count: 0 };

  if (count > 0) {
    const result = await confirmDialog({
      title: 'Archive connected sessions?',
      body: cascadeDialogBody(s, latestSessions),
      okLabel: 'Archive all',
      extraLabel: 'Archive only this one',
      danger: true,
    });
    if (result === 'cancel') return;
    if (result === 'ok') {
      const archivedIds = [sessionId, ...descendants.map((d) => d.sessionId)];
      send({ type: 'archive', sessionId, cascade: true, killJobsFirst: true });
      archivedToast(sessionId, 'Archiving connected sessions…', s.worktree, archivedIds);
      return;
    }
    // "Archive only this one" (no further prompt — the user already confirmed
    // intent via this dialog): archive just the target, still nudging its OWN
    // background shell if it has one (the existing solo safety net), leaving
    // every descendant running unchanged.
    if (s.hasBackgroundShell) {
      send({ type: 'archive', sessionId, killJobsFirst: true });
      archivedToast(sessionId, 'Stopping background jobs, then archiving…', s.worktree);
    } else {
      send({ type: 'archive', sessionId });
      archivedToast(sessionId, 'Session archived', s.worktree);
    }
    return;
  }

  // No descendants: the existing solo-archive path, unchanged.
  if (s?.hasBackgroundShell) {
    const result = await confirmDialog({
      title: 'Background job still running',
      body: `${s.label || 'This session'} still has a background job running. Archiving kills its terminal immediately, interrupting that job with no chance for it to finish or report back.\n\nAsk it to stop the job first, or archive immediately anyway?`,
      okLabel: 'Kill jobs & archive',
      extraLabel: 'Archive anyway',
      extraDanger: true,
    });
    if (result === 'cancel') return;
    if (result === 'ok') {
      send({ type: 'archive', sessionId, killJobsFirst: true });
      archivedToast(sessionId, 'Stopping background jobs, then archiving…', s.worktree);
      return;
    }
    // result === 'extra': archive immediately, same as the no-background-shell path.
  }
  send({ type: 'archive', sessionId });
  archivedToast(sessionId, 'Session archived', s?.worktree);
}

// Restart a live session: kill its tmux and relaunch with --resume, so the fresh
// process re-reads current MCP/env config while the conversation continues. It's
// the same server-side operation as the dormant-session Resume, so it rides the
// same `resume` message. Modeled on archiveSession's solo path, minus the
// cascade/descendants branch — restart is scoped to exactly one session and never
// touches its children (see the restart-session design). No archivedToast (the
// session never leaves the board, so there's no History/Resume action to offer);
// a live background job gets the same 3-way choice Archive uses, since killing the
// pane to relaunch interrupts that job just as archiving would.
async function restartSession(sessionId) {
  const s = latestSessions.find((x) => x.sessionId === sessionId);
  if (!s) return;
  if (s.hasBackgroundShell) {
    const result = await confirmDialog({
      title: 'Background job still running',
      body: `${s.label || 'This session'} still has a background job running. Restarting kills its terminal immediately, interrupting that job with no chance for it to finish or report back.\n\nAsk it to stop the job first, or restart immediately anyway?`,
      okLabel: 'Kill jobs & restart',
      extraLabel: 'Restart anyway',
      extraDanger: true,
    });
    if (result === 'cancel') return;
    if (result === 'ok') { beginRestart(sessionId, s, true); return; }
    // result === 'extra': restart immediately, same as the no-background-shell path.
  }
  beginRestart(sessionId, s, false);
}

// Sessions with a restart in flight → { tmux: pre-restart name, timer }. While an
// entry is here, the open terminal shows a "Restarting…" spinner instead of the
// dying tmux pane ("[exited]"): resume() kills the old pane (kept by remain-on-exit)
// and relaunches under a NEW tmux name, and the /pty stays bound to the dead pane
// until we deliberately re-attach. We hold the spinner until the graph reports a
// DIFFERENT tmux name (the fresh pane) and only then attach to it — see holdForRestart.
const restartingTerms = new Map();
function beginRestart(sessionId, s, killJobsFirst) {
  const prev = restartingTerms.get(sessionId);
  if (prev) clearTimeout(prev.timer);
  send(killJobsFirst ? { type: 'resume', sessionId, killJobsFirst: true } : { type: 'resume', sessionId });
  toast('Restarting…');
  // Fallback keyed PER SESSION (not one shared timer): two concurrent restarts must
  // not cancel each other's timeout, or a failed relaunch could strand a stuck
  // spinner. If the fresh tmux never shows, stop holding so the panel reverts to
  // whatever the session actually is now.
  const timer = setTimeout(() => restartingTerms.delete(sessionId), 20000);
  restartingTerms.set(sessionId, { tmux: s.tmux || '', timer });
  // Swap the open terminal for the spinner immediately, so the [exited] pane never
  // flashes; the graph handler keeps it until the relaunched pane attaches.
  if (selectedSessionId === sessionId) showRestartingPlaceholder();
}

// True while we're still waiting for a restart's relaunched pane — the caller must
// then NOT attach the old (dead) terminal. Clears the entry once the new tmux name
// appears (or the session is gone), so the next attach is the fresh pane.
function holdForRestart(s) {
  const entry = restartingTerms.get(s.sessionId);
  if (!entry) return false;
  if (s.managed && s.tmux && s.tmux !== entry.tmux) {
    clearTimeout(entry.timer);
    restartingTerms.delete(s.sessionId);
    return false;
  }
  showRestartingPlaceholder();
  return true;
}

function showRestartingPlaceholder() {
  if (current) closeTerminal();
  const term = document.getElementById('term');
  if (!term || term.dataset.restarting === '1') return; // idempotent across graph pushes
  term.dataset.restarting = '1';
  term.innerHTML = '<div class="term-note term-restarting"><span class="spinner"></span><p>Restarting…</p></div>';
}

// --- selection / panel ---

export let selectedSessionId = null;
// Keyboard nav can also land on a tile's "new session" slot rather than a session
// card: this holds that tile's id (a task id, or ADHOC_ID for Unassigned), and is
// mutually exclusive with selectedSessionId. Enter on it opens the dispatch dialog.
// Board-only — no panel/terminal/hash, just a highlight (re-derived each render).
let selectedNewSlot = null;
// A session we want to select as soon as the board contains it: set by a Resume
// click (jump to the restored session once it's back) and by the URL hash on
// load / back-forward. Fulfilled in applyGraph; survives until the session shows.
let pendingSelect = null;
// Setter so split-out views (history.js) can arm a post-resume jump without
// owning the binding (ES live bindings are read-only to importers).
export function setPendingSelect(id) { pendingSelect = id; }

// In-app "maximize the agent window" view state: a transient toggle (no
// persistence) that expands #sidebar to fill the content area, hiding the task
// board. The class lives on <main> so it survives panel re-renders; the #term
// ResizeObserver reflows the xterm + pty for free when the width changes.
let maximized = false;
export function setMaximized(on) {
  maximized = on;
  document.querySelector('main').classList.toggle('maximized', on);
  // The diff view's own fullscreen also hides #sidebar (mirroring this feature in
  // the other direction) — the two are mutually exclusive so neither state can
  // leave both #diff-panel and #sidebar hidden at once (a blank content area).
  if (on) setDiffFullscreen(false);
  // Restoring un-hides #grid: re-render now that it has real dimensions again so
  // the board reflects current data at the correct size immediately, rather than
  // showing a stale/collapsed layout until the next ~4s poll. Guarded, because
  // setDiffFullscreen(true) calls this with `false` while main.diffing is set — #grid
  // is hidden then, so measuring it would collapse the board to one column. This also
  // inherits renderGridIfVisible's !cardMenuEl check, which this path did not have
  // before; a menu can't survive into a restore anyway (closeCardMenu is bound to
  // `resize`, and entering maximize hides #grid), so the two agree in practice.
  if (!on) renderGridIfVisible();
}

// Every background re-render goes through here: the board's column count is now
// width-derived, so rendering while #grid is hidden collapses it to one column.
export function renderGridIfVisible() {
  if (currentView === 'grid' && !gridEditing() && !maximized && !gridHidden() && !cardMenuEl) renderGrid();
}

// Shared by the panel's Fullscreen/Restore button and the Ctrl+Cmd+M shortcut.
// Syncs the button's own glyph/title immediately — the render-time version only
// recomputes on the next ~4s poll, so without this the toggle looks stale for up
// to a poll interval.
function toggleMaximize() {
  setMaximized(!maximized);
  const maxBtn = document.getElementById('panel-maximize');
  if (maxBtn) {
    maxBtn.title = maximized ? `Restore (${KBD_MAXIMIZE})` : `Fullscreen (${KBD_MAXIMIZE})`;
    maxBtn.innerHTML = maximized ? MINIMIZE_ICON : MAXIMIZE_ICON;
    maxBtn.classList.toggle('active', maximized);
  }
}

// User picked a session: show details + open terminal. Clicking a card is an
// acknowledgement — persist it so the needs-you alarm stays quiet across a
// refresh, not just while this card happens to be the selected one.
function selectSession(sessionId) {
  // Moving the selection to a DIFFERENT session dismisses a diff panel still
  // showing the previous one — the diff is coupled to a single session's terminal,
  // so it shouldn't linger over another. Re-selecting the same session keeps it.
  if (isDiffPanelOpen() && diffPanelSessionId() !== sessionId) closeDiffPanel();
  selectedSessionId = sessionId;
  selectedNewSlot = null;
  acknowledge(sessionId);
  // Opening a session is "I've come back to it" — wake it for good. Harmless
  // (server no-ops) if it wasn't snoozed.
  const s = latestSessions.find((x) => x.sessionId === sessionId);
  if (s && s.snooze) send({ type: 'snooze-clear', sessionId });
  // Opening an unread card is "I've read it" — drop the manual bookmark.
  setUnread(sessionId, false);
  renderPanel(sessionId);
  if (s) renderSidebar(s);
  syncShellTerminal(sessionId);
  if (currentView === 'grid') renderGrid();
  syncHash();
}

// Clicking a dormant card resumes-and-attaches in one action (no "Resume" button
// step). pendingSelect makes the view jump to the terminal once the resumed tmux
// appears in the next graph. If the resume silently fails (still dormant after a
// grace period), surface the dead pane's last output so a failing resume isn't an
// invisible click-loop. The resume-needs-dir opt-in still interrupts server-side
// when the launch dir is gone. selectSession also clears any snooze (waking a
// card that was suspended by a >=1h snooze) — clicking it IS "wake now".
// Sessions with a resume in flight. While a sid is in here, renderSidebar shows a
// "Resuming…" placeholder instead of the dormant "Resume a copy" panel — otherwise
// that panel flashes for the ~1s between sending the resume and the resumed tmux
// appearing in the next graph (the session is still managed:false meanwhile).
const resuming = new Set();
let resumeFailTimer = null;
function resumeDormant(sessionId) {
  resuming.add(sessionId);
  pendingSelect = sessionId;
  send({ type: 'resume', sessionId });
  toast('Resuming…');
  selectSession(sessionId);
  // Re-arm a single timer so repeated clicks during the window don't stack
  // multiple failure toasts firing 8s apart.
  clearTimeout(resumeFailTimer);
  resumeFailTimer = setTimeout(() => {
    resumeFailTimer = null;
    resuming.delete(sessionId);
    const s = latestSessions.find((x) => x.sessionId === sessionId);
    if (s && !s.managed) toast(s.exitOutput ? 'Resume failed — see last output' : 'Resume failed');
  }, 8000);
}

// Wake a snoozed session (the sun button / "Unsnooze"). Clears the snooze, then —
// because a ≥1h snooze also suspends — resumes if it's dormant rather than dropping
// the user on the dead "Resume a copy" panel. A still-running snoozed session just
// re-opens. resumeDormant's own selectSession also clears the snooze, so the
// dormant branch doesn't need the explicit send.
function wakeSession(sessionId) {
  const s = latestSessions.find((x) => x.sessionId === sessionId);
  if (s && !s.managed) resumeDormant(sessionId);
  else { send({ type: 'snooze-clear', sessionId }); selectSession(sessionId); }
}

// Drop the current selection: close its terminal and hide the sidebar. Used by
// the History view (no-session state) and when the selected session is archived.
export function deselectSession() {
  selectedSessionId = null;
  selectedNewSlot = null;
  closeTerminal();
  // Hide (don't destroy) the shell terminal pane — it restores when reselected.
  if (currentShellTerm) {
    currentShellTerm.pane.style.display = 'none';
    if (currentShellTerm.handle) currentShellTerm.handle.style.display = 'none';
  }
  hideSidebar();
  if (currentView === 'grid') renderGrid();
  syncHash();
}

// The session id deep-linked in the URL hash (#session=<id>), or null.
function hashSessionId() {
  const m = (location.hash || '').match(/^#session=(.+)$/);
  return m ? decodeURIComponent(m[1]) : null;
}

// 'history' when the hash deep-links the History view, else null. Mutually
// exclusive with a #session link (History carries no selection).
function hashView() {
  return location.hash === '#view=history' ? 'history' : null;
}

// Mirror the current view/selection into the hash so a refresh re-lands here.
// History wins over a selection (they're mutually exclusive). Cleared via
// replaceState so no bare "#" lingers. Skip writes that already match to avoid a
// hashchange feedback loop.
function syncHash() {
  const target = currentView === 'history'
    ? '#view=history'
    : selectedSessionId ? `#session=${encodeURIComponent(selectedSessionId)}` : '';
  if (target) {
    if (location.hash !== target) location.hash = target;
  } else if (location.hash) {
    history.replaceState(null, '', location.pathname + location.search);
  }
}

// Select pendingSelect once the board actually contains it (a Resume needs a
// round-trip before the session reappears; a deep link needs the first graph).
function tryFulfillPending() {
  if (!pendingSelect) return;
  if (!latestSessions.some((x) => x.sessionId === pendingSelect)) return;
  if (currentView !== 'grid') setView('grid');
  const target = pendingSelect;
  pendingSelect = null;
  selectSession(target);
}

window.addEventListener('hashchange', () => {
  if (hashView() === 'history') { if (currentView !== 'history') setView('history'); return; }
  const id = hashSessionId();
  if (id === selectedSessionId) return;
  if (id) { pendingSelect = id; tryFulfillPending(); }
  else if (currentView === 'history') setView('grid');
  else deselectSession();
});

// True when the board is collapsed onto a single visible tile (renderGrid's same
// guard — everything else minimised). Drives the keyboard follow-along below.
function focusModeActive() {
  return visibleTileIds(currentOrder(), minimisedIds).length === 1;
}

// The flat keyboard-nav order: tiles in display order, each contributing its
// session cards (stored order, asleep excluded — they render as non-clickable
// greyed rows a click can't reach either) followed by a single virtual "new
// session" slot (`sid: null`). So an empty tile still offers one target (its
// slot), and arrowing past a tile's last card lands on its slot before crossing
// into the next tile. The Ad-hoc tile is included normally, in and out of focus
// mode alike — it's a focusable tile like any other.
function navTargets() {
  const byTask = new Map(latestTasks.tasks.map((t) => [t.id, []]));
  const noTask = [];
  for (const s of latestSessions) {
    const tid = assignedTaskId(s.sessionId);
    if (tid && byTask.has(tid)) byTask.get(tid).push(s);
    else noTask.push(s);
  }
  const targets = [];
  for (const id of currentOrder()) {
    const arr = id === ADHOC_ID ? noTask : (byTask.get(id) || []);
    const sids = sortBucketSessions(arr.filter((s) => phaseOf(s) !== 'asleep'), id).map((s) => s.sessionId);
    for (const sid of sids) targets.push({ tileId: id, sid });
    targets.push({ tileId: id, sid: null }); // the tile's "new session" slot
  }
  return targets;
}

// navTargets grouped into consecutive per-tile runs, for task-level nav. Every
// tile has ≥1 target (its slot at minimum), so empty tasks are reachable too.
function navTileGroups() {
  const groups = [];
  for (const t of navTargets()) {
    const last = groups[groups.length - 1];
    if (last && last.tileId === t.tileId) last.targets.push(t);
    else groups.push({ tileId: t.tileId, targets: [t] });
  }
  return groups;
}

// The key identifying the current selection within navTargets — a session id, or
// `new:<tileId>` for a slot. navTargetKey produces the same key for a target.
function navKey() { return selectedNewSlot != null ? `new:${selectedNewSlot}` : selectedSessionId; }
function navTargetKey(t) { return t.sid == null ? `new:${t.tileId}` : t.sid; }
// Move the selection onto a nav target: a session card opens (terminal/panel), a
// slot just highlights (Enter then dispatches into its tile).
function applyNavTarget(t) { if (t.sid == null) selectNewSlot(t.tileId); else selectSession(t.sid); }

// Shift+Cmd+Left / Shift+Cmd+Right: move the selection to the previous / next
// task (reverse / forward reading order), landing on that task's first
// target — its top session, or its "new session" slot when the task is empty.
// Wraps at the ends. In focus mode the board follows along (focusOnly on the
// new task).
function moveTaskFocus(dir) {
  const groups = navTileGroups();
  if (!groups.length) return;
  const key = navKey();
  const ti = groups.findIndex((g) => g.targets.some((t) => navTargetKey(t) === key));
  const next = ti < 0 ? (dir > 0 ? 0 : groups.length - 1)
    : (ti + dir + groups.length) % groups.length;
  const group = groups[next];
  if (focusModeActive()) focusOnly(group.tileId);
  applyNavTarget(group.targets[0]);
}

// Shift+Cmd+Up / Shift+Cmd+Down: scroll the selection up / down through the
// flat target list — each task's sessions then its "new session" slot,
// crossing into the adjacent task at the bounds and wrapping around the whole
// board at the global ends. In focus mode the board follows a task crossing.
function moveSessionFocus(dir) {
  const flat = navTargets();
  if (!flat.length) return;
  const key = navKey();
  const i = flat.findIndex((t) => navTargetKey(t) === key);
  const target = i < 0 ? flat[0] : flat[(i + dir + flat.length) % flat.length];
  if (focusModeActive() && (i < 0 || flat[i].tileId !== target.tileId)) focusOnly(target.tileId);
  applyNavTarget(target);
}

// Keyboard nav landed on a tile's "new session" slot. It carries no session, so we
// just move the highlight there (renderGrid re-derives it) — crucially WITHOUT
// touching selectedSessionId, so an open chat/terminal stays put while you aim at
// the slot. Enter dispatches into the tile. Scroll the lit target into view: it's
// appended after the last card and can sit just below the tile's fold, which is
// what made it feel like an invisible element got selected "at the end".
function selectNewSlot(tileId) {
  selectedNewSlot = tileId;
  // Keep the terminal open but blur it: while focused, xterm would ALSO emit a stray
  // \r for the Enter that's meant to launch (the leak openTerminal documents), and
  // the keyboard cursor now lives on the board, not the agent's input. Arrowing back
  // to the session re-opens+focuses via renderSidebar, so this is free to undo.
  current?.term?.blur();
  if (currentView !== 'grid') return;
  renderGrid();
  document.querySelector('#grid .new-sess-row.selected, #grid .empty-new-sess.selected')
    ?.scrollIntoView({ block: 'nearest' });
}

// A typing target swallows the shortcut — but NOT the xterm helper textarea, so
// keyboard nav still chains after selecting a session focuses its terminal.
function isTypingTarget(el) {
  if (!el) return false;
  if (el.isContentEditable) return true;
  if (el.tagName === 'INPUT') return true;
  if (el.tagName === 'TEXTAREA') return !el.classList.contains('xterm-helper-textarea');
  return false;
}

// Shift+Cmd+arrows navigate the board's session selection (see moveTaskFocus /
// moveSessionFocus): Left/Right switches task, Up/Down switches session within
// it — matches how the board is laid out (tasks side by side, sessions stacked).
// The "Flip navigating task / session hotkeys" setting (Settings panel) swaps the
// axes for anyone who prefers the original Up/Down=task, Left/Right=session.
// Shift distinguishes these from the terminal's plain
// Cmd+←/→ word-jump (which the term handler ignores when Shift is held).
// Deliberately NOT aliased to Ctrl+Cmd+arrows like the letter family below
// (N/T/B/R/M/S/Delete) — Ctrl+Left/Right is macOS Mission Control's
// system-wide "move a space" shortcut, bound above the browser, so it can't be
// preventDefault'd from JS; confirmed empirically (an audible "no more spaces
// that way" beep on every press). That's an OS-level collision specific to
// Ctrl+Arrow, not to Ctrl+Cmd+<letter> generally, so only an arrow alias would
// have been affected — there just isn't one. Grid view only, and inert while a
// modal, context menu, or a real text input is in play. preventDefault stops
// the browser's own shift+cmd+←/→ text-selection/scroll.
window.addEventListener('keydown', (e) => {
  if (!e.metaKey || !e.shiftKey || e.ctrlKey || e.altKey) return;
  // The "Flip navigating task / session hotkeys" setting swaps the axes; read live.
  const dirs = getSetting('flipNavHotkeys')
    ? { ArrowUp: 'taskPrev', ArrowDown: 'taskNext', ArrowLeft: 'sessPrev', ArrowRight: 'sessNext' }
    : { ArrowLeft: 'taskPrev', ArrowRight: 'taskNext', ArrowUp: 'sessPrev', ArrowDown: 'sessNext' };
  const action = dirs[e.key];
  if (!action) return;
  if (currentView !== 'grid' || cardMenuEl || isTypingTarget(document.activeElement)) return;
  if (document.querySelector('#modal:not(.hidden), [id$="-modal"]:not(.hidden)')) return;
  e.preventDefault();
  if (action === 'taskPrev') moveTaskFocus(-1);
  else if (action === 'taskNext') moveTaskFocus(1);
  else if (action === 'sessPrev') moveSessionFocus(-1);
  else moveSessionFocus(1);
});

// Enter while the keyboard selection sits on a "new session" slot opens the
// dispatch dialog for that tile (Unassigned → no preset task). Same gating as the
// nav shortcut; a no-op when a real session (or nothing) is selected, so it never
// shadows the input-scoped Enter handlers (modal/rename/todo — all excluded here).
window.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
  if (selectedNewSlot == null) return;
  if (currentView !== 'grid' || cardMenuEl || isTypingTarget(document.activeElement)) return;
  if (document.querySelector('#modal:not(.hidden), [id$="-modal"]:not(.hidden)')) return;
  e.preventDefault();
  openDispatch(selectedNewSlot === ADHOC_ID ? null : selectedNewSlot);
});

// Ctrl+Cmd family: board actions that must fire even while the terminal holds
// focus. Ctrl+Cmd+N opens the new-session dialog; Ctrl+Cmd+Delete (or
// Ctrl+Cmd+Backspace — the default Mac keyboard has no forward-delete key, so
// Backspace is the only way to reach this chord on it) stops + archives the
// selected session, or — with the new-session slot selected on an otherwise
// empty task — deletes that task; Ctrl+Cmd+T is a toggle for a plain shell
// terminal in the selected session's cwd. Opening it is the same "Open
// terminal" action as the Actions menu (`open-terminal-for-session`) — so you
// can drop a shell alongside the agent's terminal without reaching for the
// mouse mid-conversation — gated on `current.sessionId === selectedSessionId`
// (the agent terminal for this session is actually open, i.e. it's a
// live/managed session) rather than just `selectedSessionId`, so it's a no-op
// on a dormant/no selection instead of erroring server-side. But if a shell
// terminal for this session is ALREADY open, the same chord closes it instead
// (closeShellTerminal() — a pure client-side teardown, so it's allowed even if
// the agent session has since gone dormant) rather than replacing it with a
// fresh one, mirroring how M is a single toggle for maximize/restore.
//
// Ctrl+Cmd+B forks the selected session ("Branch" — Ctrl+Cmd+F was the natural
// letter but collides with macOS/Chrome's own Enter Full Screen chord).
// Ctrl+Cmd+R opens a review session. Ctrl+Cmd+M toggles the panel's
// maximize/restore (mirrors the Fullscreen/Restore button — one key, both
// directions, via the shared toggleMaximize()). Ctrl+Cmd+S mirrors the Actions
// menu's Snooze…/Unsnooze row; a keyboard shortcut has no click position to
// anchor a picker menu at, so it anchors under the panel's #actions-btn instead
// (snoozeSelected()). Ctrl+Cmd+D toggles the working-tree diff panel for the
// selected session (open, or close if already showing it). All are no-ops without
// a selected session, and (per the Actions menu they mirror) work on a
// dormant/unmanaged session too — unlike T, they don't require a live terminal.
//
// A separate family from Shift+Cmd nav — Ctrl+Cmd+<key> is essentially never
// browser-reserved (unlike Cmd+N / Shift+Cmd+N) and emits no terminal bytes, so
// it survives both. The terminal's Cmd+⌫ clear-line chord requires no Ctrl, so
// it's swallowed separately below before it can fire for this Ctrl+Cmd+Backspace
// chord. Same gating as nav: grid view only, inert while a modal, context menu,
// or real text input is in play (the xterm helper textarea is NOT a typing
// target, so these chain straight off an attached terminal).
//
// CAPTURE PHASE, deliberately (third arg true). This is the real fix for the
// long-broken Ctrl+Cmd+D "open diff from a focused terminal": Ctrl+Cmd+D is
// macOS's system "Look Up" chord, and with the xterm helper textarea focused the
// focused-text-field's default/OS handling consumes that keystroke *before* it
// reaches a window BUBBLE listener — so a bubble-phase handler here simply never
// fired (verified live: injecting anything that stops propagation before the
// window-bubble hop reproduces the exact "diff won't open" symptom). Both prior
// fixes only moved/scoped preventDefault *inside* the bubble-phase listener, which
// can't help when the listener never runs. Listening in the CAPTURE phase runs us
// at the very first dispatch step — ahead of the textarea and its default action —
// so the page wins the race for every chord in the family, terminal-focused or not.
window.addEventListener('keydown', (e) => {
  if (!e.metaKey || !e.ctrlKey || e.shiftKey || e.altKey) return;
  const key = e.key.toLowerCase();
  if (!CTRL_CMD_KEYS.has(key)) return;
  // Pre-gate preventDefault is scoped to 'g' ONLY (the diff chord): kept from when
  // this was Ctrl+Cmd+D — macOS's "Look Up" chord that the OS consumed before the
  // browser ever saw the keydown, so no web handler could open the diff. Ctrl+Cmd+G
  // is NOT OS-reserved, but we keep the early swallow for consistency so the diff
  // opens even in History view / a modal / while typing. The REST of the family
  // (n/t/b/r/m/s/delete/backspace) keep their original POST-gate preventDefault below,
  // so in those contexts they don't over-suppress the browser/OS shortcuts on those
  // same chords (they fall through the gate untouched).
  if (key === 'g') e.preventDefault();
  if (currentView !== 'grid' || cardMenuEl || isTypingTarget(document.activeElement)) return;
  if (document.querySelector('#modal:not(.hidden), [id$="-modal"]:not(.hidden)')) return;
  // Past the gate the chord is definitely ours — suppress the browser/OS default for
  // the whole family (this is the original, pre-diff-feature behaviour for the rest;
  // 'g' was already prevented above and re-preventing is a no-op).
  e.preventDefault();
  if (key === 'n') { openDispatch(currentTaskSelection()); return; }
  if (key === 't') {
    if (!selectedSessionId) return;
    if (currentShellTerm && currentShellTerm.sessionId === selectedSessionId) { closeShellTerminal(); return; }
    if (current && current.sessionId === selectedSessionId) send({ type: 'open-terminal-for-session', sessionId: selectedSessionId });
    return;
  }
  if (key === 'b') { if (selectedSessionId) openFork(selectedSessionId); return; }
  // Restart matches its menu gate — only a live (managed) session, since a dormant
  // one already offers Resume. Peer review works on any session, like its menu row.
  if (key === 'r') {
    const rs = selectedSessionId && latestSessions.find((x) => x.sessionId === selectedSessionId);
    if (rs?.managed) restartSession(selectedSessionId);
    return;
  }
  if (key === 'p') { if (selectedSessionId) peerReviewSession(selectedSessionId); return; }
  if (key === 'm') { if (selectedSessionId) toggleMaximize(); return; }
  if (key === 's') { if (selectedSessionId) snoozeSelected(selectedSessionId); return; }
  if (key === 'g') { if (selectedSessionId) toggleDiffPanel(selectedSessionId); return; }
  if (selectedSessionId) archiveSession(selectedSessionId);
}, true);

// Ctrl+Cmd+S: same Snooze…/Unsnooze branch as the Actions menu's row, but a
// keyboard shortcut has no click position to anchor the duration picker at —
// anchor it under the panel's Actions button instead (present whenever a
// session is selected, regardless of managed state — see renderPanel).
function snoozeSelected(sessionId) {
  const s = latestSessions.find((x) => x.sessionId === sessionId);
  if (!s) return;
  if (isAsleep(s)) { wakeSession(sessionId); return; }
  const btn = document.getElementById('actions-btn');
  const r = btn ? btn.getBoundingClientRect() : { left: 20, bottom: 20 };
  openSnoozeMenu(sessionId, r.left, r.bottom + 4);
}

// The task the keyboard selection currently sits in, for pre-selecting the
// new-session dialog: the highlighted new-session slot's task, else the selected
// session's assigned task. Returns null (no preset) for the Ad-hoc tile or no
// selection — same shape openDispatch expects.
function currentTaskSelection() {
  if (selectedNewSlot != null) return selectedNewSlot === ADHOC_ID ? null : selectedNewSlot;
  if (selectedSessionId) return assignedTaskId(selectedSessionId);
  return null;
}

// Sessions-per-row is viewport-derived, so re-pack the board when the window
// resizes. Debounced to skip the intermediate sizes during a drag-resize, and
// guarded like the graph re-render so it never steals focus mid-edit/drag.
let gridResizeTimer = null;
window.addEventListener('resize', () => {
  if (currentView !== 'grid') return;
  clearTimeout(gridResizeTimer);
  gridResizeTimer = setTimeout(() => {
    renderGridIfVisible();
  }, 150);
});

function showSidebar() {
  document.getElementById('sidebar').classList.remove('collapsed');
  document.getElementById('drag-handle').classList.remove('hidden');
}
function hideSidebar() {
  document.getElementById('sidebar').classList.add('collapsed');
  document.getElementById('drag-handle').classList.add('hidden');
  // Single chokepoint for closePanel() and deselectSession() (the latter fires on
  // the History switch), so dropping maximize here means we never land on an empty
  // maximized sidebar.
  setMaximized(false);
  // The diff is a supporting view of the session's terminal, so hiding the session
  // panel (close / deselect / History switch) closes the diff too — it must never
  // outlive the session it belongs to. No-op when the diff is already closed.
  closeDiffPanel();
}

// Drag-to-resize the sidebar (stretch the terminal wider than the grid).
(function initSidebarResize() {
  const handle = document.getElementById('drag-handle');
  const sidebar = document.getElementById('sidebar');
  const saved = localStorage.getItem('cm-sidebar-w');
  if (saved) sidebar.style.width = saved;
  let dragging = false;
  handle.addEventListener('mousedown', (e) => {
    dragging = true;
    handle.classList.add('dragging');
    document.body.classList.add('dragging');
    e.preventDefault();
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const w = Math.min(window.innerWidth - 200, Math.max(280, window.innerWidth - e.clientX));
    sidebar.style.width = `${w}px`;
  });
  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove('dragging');
    document.body.classList.remove('dragging');
    localStorage.setItem('cm-sidebar-w', sidebar.style.width);
    // On mouseup, not mousemove: a full re-render per mouse event would rebuild every
    // tile mid-drag.
    renderGridIfVisible();
  });
})();

// Managed sessions get a live terminal; others get an explanation + Resume.
function renderSidebar(s) {
  showSidebar();
  if (s.managed) {
    if (holdForRestart(s)) return; // restart in flight — hold the spinner, not the dead pane
    resuming.delete(s.sessionId); // resumed — drop the in-flight placeholder
    openTerminal(s);
    return;
  }
  closeTerminal();
  const term = document.getElementById('term');
  // A resume we just kicked off: show a placeholder, not the dormant panel, so the
  // "Resume a copy" page doesn't flash before the live terminal attaches.
  if (resuming.has(s.sessionId)) {
    term.innerHTML = '<div class="term-note"><p>Resuming…</p></div>';
    return;
  }
  const where = s.exitOutput
    ? `its previous terminal exited`
    : s.tty && s.tty !== '??'
    ? `it's running in another terminal (<code>${esc(s.tty)}</code>)`
    : `it has no controlling terminal (detached/background)`;
  const exitBlock = s.exitOutput
    ? `<p class="muted">Last output from the exited terminal:</p><pre class="term-exit">${esc(s.exitOutput)}</pre>`
    : '';
  term.innerHTML = `<div class="term-note">
    <p>This session isn't running in tmux, so its live terminal can't be attached — ${where}.</p>
    ${exitBlock}
    <button id="resume-btn">▶ Resume a copy in a new terminal</button>
    <p class="muted">Runs <code>claude --resume --fork-session</code> to branch a copy of this conversation into a fresh tmux session you can attach to here. The original process keeps running independently.</p>
  </div>`;
  term.querySelector('#resume-btn').addEventListener('click', () => {
    send({ type: 'resume', sessionId: s.sessionId });
    toast('Resuming…');
  });
}

// Swap the panel title for an input to rename the session. Enter/blur commits,
// Escape cancels. An empty value clears the custom name (reverts to default).
function beginRename(sessionId) {
  const titleEl = document.getElementById('session-name');
  if (!titleEl || titleEl.querySelector('input')) return;
  const s = latestSessions.find((x) => x.sessionId === sessionId);
  // The "[FORK] " marker is added server-side (withForkMark) for un-renamed forks;
  // strip it when seeding so the edit field is just the name. Renaming makes the
  // name user-chosen, which drops the marker server-side.
  const seed = s ? s.label.replace(/^\[FORK\] /, '') : '';
  titleEl.innerHTML = `<input id="rename-input" class="rename-input" value="${esc(seed)}">`;
  const input = titleEl.querySelector('#rename-input');
  input.focus();
  input.select();
  let settled = false;
  const finish = (save) => {
    if (settled) return;
    settled = true;
    if (save) {
      const name = input.value.trim();
      send({ type: 'rename', sessionId, name });
      if (s && name) s.label = name; // optimistic (rename drops the marker); server confirms on next graph
      toast(name ? 'Renamed' : 'Name reset');
    }
    renderPanel(sessionId);
  };
  input.addEventListener('keydown', (e) => {
    // stopPropagation: finish() synchronously re-renders this input away, so a
    // bubbling Enter would reach the window handler with the input already gone —
    // the isTypingTarget guard would miss it and a selected "new session" slot
    // would wrongly open the dispatch modal.
    if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
}

// The panel's own sub-agent state is independent of the board card's (a card
// disables its pill at 0 active — fine there, since the card only ever shows the
// Active filter; the panel's own "All" filter is the one place finished sub-agents
// are reachable at all, so the panel's collapse toggle must stay enabled and
// separately tracked). Both the collapse state and the Recent/All filter are
// persisted per card id — same override-map pattern as the board card's own
// subagentShownOverrides (see toggleSubagentShown), but its own key/Map so
// toggling one never toggles the other or the card's. Both the collapse state
// and the Recent/All filter default to their "off" state (absent from the map):
// the collapse state falls back to subagentsExpandedByDefault, the filter
// always falls back to Recent. Being keyed per session rather than an in-memory
// flag, both survive a hard refresh instead of resetting to a hardcoded default
// on every fresh page load — there's no session-switch reset to write here at
// all (contrast the old code, which had to remember to reset a transient flag);
// each session's own state is just looked up fresh from its Map/Set.
const PANEL_SA_SHOWN_KEY = 'wrangler.panelSubagentShown';
const panelSubagentShownOverrides = (() => {
  try {
    const parsed = JSON.parse(localStorage.getItem(PANEL_SA_SHOWN_KEY));
    if (Array.isArray(parsed)) return new Map(parsed.map((id) => [id, true]));
    if (parsed && typeof parsed === 'object') return new Map(Object.entries(parsed));
  } catch { /* fall through to empty */ }
  return new Map();
})();
function isPanelSubagentShown(sessionId) {
  return panelSubagentShownOverrides.has(sessionId) ? panelSubagentShownOverrides.get(sessionId) : subagentsExpandedByDefault;
}
function togglePanelSubagentShown(sessionId) {
  panelSubagentShownOverrides.set(sessionId, !isPanelSubagentShown(sessionId));
  try { localStorage.setItem(PANEL_SA_SHOWN_KEY, JSON.stringify(Object.fromEntries(panelSubagentShownOverrides))); } catch {}
}
const PANEL_SA_FILTER_KEY = 'wrangler.panelSubagentShowFinished';
const panelSubagentShowFinishedIds = (() => {
  try { return new Set(JSON.parse(localStorage.getItem(PANEL_SA_FILTER_KEY)) || []); } catch { return new Set(); }
})();
function togglePanelSubagentShowFinished(sessionId) {
  if (panelSubagentShowFinishedIds.has(sessionId)) panelSubagentShowFinishedIds.delete(sessionId);
  else panelSubagentShowFinishedIds.add(sessionId);
  try { localStorage.setItem(PANEL_SA_FILTER_KEY, JSON.stringify([...panelSubagentShowFinishedIds])); } catch {}
}

// Build the detail panel (no terminal side-effects, so it's safe to re-render
// on live updates). The header structurally replicates a board card: a
// .card-bar-alike vertical status strip on the left (status word, no waitingFor —
// the live terminal already shows what's happening) and .card-tag pill chips for
// every meta segment, plus the sub-agent zone — collapsible via its own pill,
// styled and labelled (active/total) like the board card's, but never disabled
// and never sharing the card's state (see comment above).
function renderPanel(sessionId) {
  const s = latestSessions.find((x) => x.sessionId === sessionId);
  if (!s) return;
  // Both persisted per session id (see the two maps above) — looked up fresh
  // on every render, no reset-on-session-switch bookkeeping needed.
  const panelSubagentShown = isPanelSubagentShown(sessionId);
  const panelSubagentShowFinished = panelSubagentShowFinishedIds.has(sessionId);
  // Mirror the card's transient cyan "just-finished" edge in the header.
  const stateClass = justFinished.has(s.sessionId) ? 'just-finished' : s.status;
  const barWordPanel = barWord(s); // same vocabulary as the card bar; no waitingFor
  // Meta as .card-tag chips (full parity with the board card), each omitted when empty.
  const chips = [];
  const active = timeAgo(s.lastActivity);
  if (active) chips.push(`<span class="card-tag">${CLOCK_ICON}${esc(active)}</span>`);
  if (typeof s.usd === 'number') chips.push(`<span class="card-tag" title="cost so far">${DOLLAR_ICON}${s.usd.toFixed(2)}</span>`);
  if (s.tokens) chips.push(`<span class="card-tag" title="tokens — output / input">${(s.tokens.output / 1000).toFixed(1)}k out · ${(s.tokens.input / 1000).toFixed(1)}k in</span>`);
  if (s.tasks?.running) chips.push(`<span class="card-tag">${esc(s.tasks.running)} running${s.tasks.kinds?.length ? ` (${s.tasks.kinds.map(esc).join(', ')})` : ''}</span>`);
  if (s.tasks?.queued) chips.push(`<span class="card-tag">${esc(s.tasks.queued)} queued</span>`);
  const saList = Array.isArray(s.subAgents) ? s.subAgents : [];
  const saRecentCount = visibleSubAgents(saList, { showFinished: false, now: Date.now() }).length;
  if (saList.length) {
    // Same +/- toggle icon as the card's own pill (subagentPillHtml).
    const saToggleIcon = `<span class="subagent-toggle-icon">${panelSubagentShown ? MINUS_ICON : PLUS_ICON}</span>`;
    chips.push(`<button class="card-tag subagent-pill${panelSubagentShown ? ' showing' : ''}" id="panel-sa-toggle" title="${panelSubagentShown ? 'Hide' : 'Show'} sub-agents">${ROBOT_ICON}${saRecentCount}/${saList.length}${saToggleIcon}</button>`);
  }
  const pathTitle = esc([s.cwd, ...(s.addDirs || [])].filter(Boolean).join('\n'));
  // The sub-agent zone: rendered only once shown (the pill above), with its own
  // Active/All filter pill in the divider. Reuses subagentRowHtml; rows open the
  // same modal (§4).
  const saRows = visibleSubAgents(saList, { showFinished: panelSubagentShowFinished, now: Date.now() });
  // "Recent", not "Active" — the filter includes sub-agents that already finished
  // (within SUBAGENT_RECENT_MS), so "Active" would overclaim what's actually shown.
  const saPillHtml = `<button class="card-tag subagent-pill${panelSubagentShowFinished ? ' showing' : ''}" id="panel-sa-pill" title="${panelSubagentShowFinished ? 'Show recent only' : 'Show all'}">${FILTER_ICON}${panelSubagentShowFinished ? 'All' : 'Recent'}</button>`;
  const saDisclosure = (saList.length && panelSubagentShown)
    ? `<div class="sess-subagents">${subagentDividerHtml(saPillHtml)}${saRows.length ? saRows.map((sa) => subagentRowHtml(sa, s.sessionId)).join('') : `<div class="sess-subagents-empty">${ROBOT_ICON}No matching sub-agents</div>`}</div>`
    : '';
  const body = `
        <div class="sess-row1">
          <span class="sess-name" id="session-name" title="Double-click to rename">${esc(s.label)}</span>
          <span class="sess-acts">
            <button id="actions-btn" class="sess-actions-btn" title="Session actions">${KEBAB_ICON}Actions</button>
            <span class="sess-acts-divider"></span>
            <button id="panel-maximize" class="icon-ghost${maximized ? ' active' : ''}" title="${maximized ? 'Restore' : 'Fullscreen'} (${KBD_MAXIMIZE})">${maximized ? MINIMIZE_ICON : MAXIMIZE_ICON}</button>
            <button id="panel-close" class="icon-ghost" title="Close">${X_ICON}</button>
          </span>
        </div>
        <div class="sess-path">
          <span class="sess-loc" title="${pathTitle}">📁 ${s.cwd ? esc(tildify(s.cwd)) : '—'}</span>
          ${branchBadge(s.branch)}
          ${s.addDirs?.length ? `<span class="sess-more">+${s.addDirs.length}</span>` : ''}
        </div>
        <div class="sess-meta">${chips.join('')}${s.links?.length ? `<span class="sess-meta-links">${linkChipsHtml(s.links, cardCtx())}</span>` : ''}</div>
        ${saDisclosure}`;
  const panel = document.getElementById('panel');
  // Keep the status bar a persistent element: the ~4s graph poll re-renders the
  // panel, and reassigning innerHTML would recreate the bar and restart its CSS
  // throb mid-cycle (a visible "jump"). So on the same session, refresh the state
  // class + bar word + body and leave the bar element itself be.
  const hdr = panel.querySelector('.sess-hdr');
  if (hdr && hdr.dataset.sid === sessionId) {
    hdr.className = `sess-hdr ${esc(stateClass)}`;
    const barSpan = hdr.querySelector('.sess-bar > span');
    if (barSpan) barSpan.textContent = barWordPanel;
    // Reassigning innerHTML recreates .sess-subagents from scratch, so its own
    // scroll position (independent of the panel's) would silently reset to the
    // top on every ~4s graph poll while scrolled into a long list. Carry it over.
    const prevScroll = hdr.querySelector('.sess-subagents')?.scrollTop;
    hdr.querySelector('.sess-body').innerHTML = body;
    if (prevScroll) {
      const newZone = hdr.querySelector('.sess-subagents');
      if (newZone) newZone.scrollTop = prevScroll;
    }
  } else {
    panel.innerHTML = `<div class="sess-hdr ${esc(stateClass)}" data-sid="${esc(sessionId)}"${throbDelayStyle(stateClass)}><span class="sess-bar"><span>${esc(barWordPanel)}</span></span><div class="sess-body">${body}</div></div>`;
  }
  const closeBtn = panel.querySelector('#panel-close');
  if (closeBtn) closeBtn.addEventListener('click', closePanel);
  const maxBtn = panel.querySelector('#panel-maximize');
  if (maxBtn) maxBtn.addEventListener('click', toggleMaximize);
  const nameEl = panel.querySelector('#session-name');
  if (nameEl) nameEl.addEventListener('dblclick', () => beginRename(sessionId));
  const saPill = panel.querySelector('#panel-sa-pill');
  if (saPill) saPill.addEventListener('click', (e) => { e.stopPropagation(); togglePanelSubagentShowFinished(sessionId); renderPanel(sessionId); });
  const saToggle = panel.querySelector('#panel-sa-toggle');
  if (saToggle) saToggle.addEventListener('click', (e) => { e.stopPropagation(); togglePanelSubagentShown(sessionId); renderPanel(sessionId); });
  panel.querySelectorAll('.subagent-row').forEach((row) => {
    row.addEventListener('click', () => openSubagentModal(row.dataset.ownerSid, row.dataset.subagentId));
  });
  // The eight inline icons collapsed into one "Actions" overflow menu, anchored
  // directly beneath the button (left edge, just below it). Fork/snooze/
  // archive all live inside it now; rename moved to the title double-click.
  const actionsBtn = panel.querySelector('#actions-btn');
  if (actionsBtn) actionsBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const r = actionsBtn.getBoundingClientRect();
    openActionsMenu(sessionId, r.left, r.bottom + 4);
  });
}

// --- terminal ---
let current = null;
// Terminal font size is a single global preference — it applies to every
// terminal, the open one and any opened later — persisted like the other cm-*
// client settings. Read through the pure normalizer so a stale/garbage/legacy
// value can never break the terminal.
const TERM_FONT_KEY = 'cm-term-fontsize';
function termFontSize() {
  try { return normalizeFontSize(localStorage.getItem(TERM_FONT_KEY)); } catch { return DEFAULT_TERM_FONT_SIZE; }
}
function setTermFontSize(size) {
  const n = normalizeFontSize(size);
  try { localStorage.setItem(TERM_FONT_KEY, String(n)); } catch {}
  // Apply live: xterm doesn't reflow on a fontSize change, so refit recalculates
  // cols/rows off the new metrics; the ResizeObserver then syncs the pty resize.
  if (current && current.term) {
    current.term.options.fontSize = n;
    try { current.fit.fit(); } catch {}
  }
}
// Rendered into the settings modal's Appearance section: one segmented button per
// preset size. Font size is a single global preference (every terminal), not
// per-session. Pure — no DOM writes; settings.js splices this into the modal body
// it re-renders on every open, and routes clicks back to setTermFontSize.
function fontSizeRowHtml() {
  const cur = termFontSize();
  return TERM_FONT_SIZES.map((size) =>
    `<button class="fontsize-opt${size === cur ? ' active' : ''}" data-size="${size}">${size} px</button>`).join('');
}
function closeTerminal() {
  if (!current) return;
  try { current.ws.close(); } catch {}
  try { current.term.dispose(); } catch {}
  document.getElementById('term').removeEventListener('click', current.clickHandler);
  current = null;
}

// --- shell terminal pane ---
let currentShellTerm = null; // { pane, term, ws }

function closeShellTerminal() {
  if (!currentShellTerm) return;
  try { currentShellTerm.ws.close(); } catch {}
  try { currentShellTerm.term.dispose(); } catch {}
  currentShellTerm.handle?.remove();
  currentShellTerm.pane.remove();
  currentShellTerm = null;
}

// Show or hide the shell terminal pane based on whether it belongs to sessionId.
function syncShellTerminal(sessionId) {
  if (!currentShellTerm) return;
  const visible = currentShellTerm.sessionId === sessionId;
  currentShellTerm.pane.style.display = visible ? '' : 'none';
  if (currentShellTerm.handle) currentShellTerm.handle.style.display = visible ? '' : 'none';
  if (visible) try { currentShellTerm.fit.fit(); } catch {}
}

// Open (or replace) the shell terminal pane below #term-wrap in the sidebar.
// `command` (if non-empty) is already pre-populated server-side; we show it
// in a DOM preview so it's immune to ANSI tricks inside the xterm canvas.
function openShellTerminal({ terminalId, command, sessionId }) {
  closeShellTerminal();
  showSidebar();

  const sidebar = document.getElementById('sidebar');

  // Drag handle between the agent terminal and the shell pane.
  const handle = document.createElement('div');
  handle.className = 'shell-term-drag-handle';
  sidebar.appendChild(handle);

  const pane = document.createElement('div');
  pane.className = 'shell-terminal-pane';

  const commandPreview = command
    ? `<div class="terminal-command-preview"><code>${esc(command)}</code></div>`
    : '';
  pane.innerHTML = `
    <div class="shell-terminal-header">
      <span class="shell-terminal-label">Terminal</span>
      <button class="shell-terminal-close" title="Close terminal">${X_ICON}</button>
    </div>
    ${commandPreview}
    <div class="shell-terminal-body"></div>`;
  sidebar.appendChild(pane);

  // Vertical drag-to-resize: drag handle adjusts the shell pane flex-basis.
  (function initShellResize() {
    let dragging = false;
    handle.addEventListener('mousedown', (e) => {
      dragging = true;
      handle.classList.add('dragging');
      document.body.classList.add('dragging');
      e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const sidebarRect = sidebar.getBoundingClientRect();
      const h = Math.min(sidebarRect.height - 100, Math.max(80, sidebarRect.bottom - e.clientY));
      pane.style.flexBasis = `${h}px`;
    });
    window.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      handle.classList.remove('dragging');
      document.body.classList.remove('dragging');
    });
  })();

  pane.querySelector('.shell-terminal-close').addEventListener('click', closeShellTerminal);

  const body = pane.querySelector('.shell-terminal-body');
  const term = new Terminal({
    fontSize: termFontSize(), fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    theme: readTerminalTheme(), cursorBlink: true,
    allowTransparency: true,
    // Unicode11Addon's activate() calls the proposed term.unicode API.
    allowProposedApi: true,
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  attachClipboard(term);
  attachUnicode11(term);
  term.open(body);
  fit.fit();
  term.focus();

  // Hide immediately if the terminal belongs to a session other than the currently selected one.
  const visible = !sessionId || sessionId === selectedSessionId;
  if (!visible) {
    pane.style.display = 'none';
    if (handle) handle.style.display = 'none';
  }

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/pty?terminalId=${encodeURIComponent(terminalId)}&cols=${term.cols}&rows=${term.rows}`);
  ws.binaryType = 'arraybuffer';
  ws.onmessage = (ev) => term.write(typeof ev.data === 'string' ? ev.data : new Uint8Array(ev.data));
  term.onData((d) => ws.readyState === 1 && ws.send(d));

  // Server-side kill on disconnect removes the registry entry; client-side close
  // removes the pane from DOM. No reconnect — shell terminals are one-shot.
  ws.onclose = () => {
    if (currentShellTerm && currentShellTerm.ws === ws) closeShellTerminal();
  };

  // Assert our true size once the socket is open so tmux's idea of our size can't
  // drift from what xterm renders (the source of redraw garble); the server
  // forces a repaint after the resize.
  const syncSize = () => {
    try {
      fit.fit();
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
    } catch { /* disposed */ }
  };
  ws.onopen = syncSize;
  const ro = new ResizeObserver(syncSize);
  ro.observe(body);

  currentShellTerm = { pane, handle, term, fit, ws, sessionId: sessionId || null };
}

// tmux runs with `mouse on` (so the wheel scrolls its copy-mode scrollback). In a
// pane whose app does NOT grab the mouse — Codex, a plain shell — a click-drag
// therefore lands in tmux copy-mode, not the app: a yellow selection that on
// release copies out via OSC 52 (the sessions force `set-clipboard on`) and
// vanishes. xterm.js drops OSC 52 unless a clipboard addon handles it, so that
// copy silently never reached the system clipboard — the reported "orange
// highlight, copy doesn't work". This write-only provider lands it in the browser
// clipboard and flashes a toast: the copy-mode highlight vanishes on release, so
// the toast is the only confirmation the copy actually happened. Reads are refused
// so a rogue pane can't exfiltrate the clipboard via OSC 52. (Claude grabs the
// mouse itself, so its drags never enter copy-mode — this only bites the
// non-capturing panes, but loading it everywhere is harmless.) Guard via globalThis
// so a bare `ClipboardAddon` — which is *undeclared*, not undefined, if the vendored
// script 404s — can't throw a ReferenceError and kill the terminal-open path.
function attachClipboard(term) {
  if (typeof globalThis.ClipboardAddon?.ClipboardAddon !== 'function') return;
  // The addon's constructor is (base64?, provider?) despite its typings claiming
  // (provider?) — verified against the shipped 0.1.0 bundle. Pass undefined to keep
  // the default base64 codec and supply the provider second, or the decode breaks
  // and the read-refusing provider is silently ignored.
  term.loadAddon(new globalThis.ClipboardAddon.ClipboardAddon(undefined, {
    readText: () => Promise.resolve(''),
    writeText: (_sel, text) => {
      const p = navigator.clipboard?.writeText(text);
      if (!p) return;
      return p.then(() => { if (text && text.trim()) toast('Copied to clipboard', false, { duration: 1500 }); }, () => {});
    },
  }));
}

// xterm.js 5.x defaults to its Unicode v6 width tables, which call emoji like ✅
// (U+2705) 1 column wide; tmux's own wcwidth (glibc) calls it 2. That one-column
// disagreement between tmux's cursor math and xterm's drawing spills the tail of
// any line containing one onto the next screen row. Unicode11Addon's tables agree
// with tmux. Guarded like attachClipboard — a missing/404'd vendored script must
// never throw and kill the terminal-open path.
function attachUnicode11(term) {
  if (typeof globalThis.Unicode11Addon?.Unicode11Addon !== 'function') return;
  term.loadAddon(new globalThis.Unicode11Addon.Unicode11Addon());
  term.unicode.activeVersion = '11';
}

function openTerminal(s) {
  closeTerminal();
  showSidebar();
  const term = new Terminal({
    fontSize: termFontSize(), fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    theme: readTerminalTheme(), cursorBlink: true,
    // Honor an rgba --term-bg so a style's wallpaper can show through the canvas;
    // opaque (dark/light) backgrounds render unchanged.
    allowTransparency: true,
    // xterm.js 5.x's default OSC 8 handler shows a confirm() before window.open(),
    // which is disruptive and can cause the popup blocker to suppress the open after
    // the dialog is dismissed. Open directly — the click is already a user gesture.
    linkHandler: { activate: (_ev, uri) => window.open(uri, '_blank', 'noopener') },
    // Unicode11Addon's activate() calls the proposed term.unicode API.
    allowProposedApi: true,
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  // Make URLs in the pane clickable (Cmd/Ctrl-click → new tab). The link layer fires
  // on the DOM click, so it works regardless of tmux mouse mode. Guarded: a missing
  // global must never throw here, or it kills the whole terminal open path.
  if (typeof WebLinksAddon?.WebLinksAddon === 'function') {
    term.loadAddon(new WebLinksAddon.WebLinksAddon((event, uri) => {
      window.open(uri, '_blank', 'noopener,noreferrer');
    }));
  }
  // A second link layer: filesystem paths to markdown files → open in the
  // preview modal. A raw link provider (not another WebLinksAddon) — the URL
  // addon's link computer rejects any match new URL() can't parse, which drops
  // every filesystem path. The URL addon above is unaffected: a .md path never
  // looks like an http(s) URL, and vice-versa. s.cwd is the base a relative
  // path (docs/x.md) resolves against.
  try {
    term.registerLinkProvider(createMarkdownLinkProvider(term, openFilePreview, s.cwd));
  } catch (err) {
    console.error('[term-links]', err);
  }
  // A third link layer: GitHub PR refs ("PR #1027") → open the PR in a new tab.
  // Only when the session's repo slug is known (derived server-side from the git
  // remote). Raw provider for the same reason as the .md provider above ("PR #N"
  // is not a valid new URL()). Guarded so a throw never kills the terminal open.
  if (s.repoSlug) {
    try {
      term.registerLinkProvider(createPrLinkProvider(term, s.repoSlug,
        (uri) => window.open(uri, '_blank', 'noopener')));
    } catch (err) {
      console.error('[pr-links]', err);
    }
  }
  attachClipboard(term);
  attachUnicode11(term);
  const el = document.getElementById('term');
  el.innerHTML = '';
  delete el.dataset.restarting; // leaving the spinner state — attaching a real pane
  term.open(el);
  fit.fit();
  // Clicking the terminal puts keyboard focus on the Claude input and marks the
  // session as user-attended so its card stops flashing needs-you.
  const clickHandler = () => { term.focus(); acknowledge(s.sessionId); };
  el.addEventListener('click', clickHandler);
  term.textarea?.addEventListener('focus', () => acknowledge(s.sessionId));
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/pty?sessionId=${encodeURIComponent(s.sessionId)}&cols=${term.cols}&rows=${term.rows}`);
  ws.binaryType = 'arraybuffer';
  ws.onmessage = (ev) => term.write(typeof ev.data === 'string' ? ev.data : new Uint8Array(ev.data));
  term.onData((d) => ws.readyState === 1 && ws.send(d));
  // The pty socket can drop without us asking — a server restart (launchd), the
  // server-side `tmux attach` exiting, or a network blip. Unlike the control
  // socket it has no re-poll, so a silent drop leaves the terminal dead: the
  // textarea keeps focus but keystrokes hit a closed socket and vanish, which
  // reads as "lost focus" until you reclick the card. Re-attach (tmux preserves
  // the pane, and openTerminal re-focuses), but only while this is still the live
  // terminal for the still-selected session: closeTerminal()/navigation null or
  // swap `current` synchronously, so an intentional close — whose onclose fires a
  // tick later — finds the guard false and stays closed. The `managed` recheck
  // stops a reconnect storm when the tmux is genuinely gone (the next graph poll
  // flips the panel to the Resume view).
  ws.onclose = () => {
    if (!current || current.ws !== ws || selectedSessionId !== s.sessionId) return;
    setTimeout(() => {
      if (!current || current.ws !== ws || selectedSessionId !== s.sessionId) return;
      const sel = latestSessions.find((x) => x.sessionId === s.sessionId);
      if (sel && sel.managed) openTerminal(sel);
    }, 1200);
  };
  // Custom keys, all on keydown only and returning false so xterm doesn't ALSO
  // emit its own bytes (a CR for Enter, cursor moves for arrows):
  //
  // Translate macOS editing chords into the bytes Claude's input understands.
  // CRUCIAL: we call e.preventDefault() ourselves. Returning false tells xterm to
  // skip the key, but xterm then does NOT preventDefault — so the browser still
  // delivers the keystroke to xterm's hidden textarea, and for Enter that leaks a
  // stray \r to the pty on top of ours, which submits. That leak (not the byte
  // choice) is why prior Shift+Enter attempts submitted: Option+Enter works
  // because xterm's native path preventDefaults; the Cmd+Arrow chords only seemed
  // fine because arrow keys insert no text to leak.
  //   Shift+Enter → \x1b\r  : Meta+Enter — Claude's native newline insert (same
  //                            bytes xterm emits for the working Option+Enter).
  //   Cmd+←/→     → \x1bb / \x1bf : readline backward/forward-word. (Shift+Cmd+←/→
  //                            is left for the board's session nav, so we skip it.)
  //   Cmd+⌫       → \x15   : Ctrl-U, delete from cursor to start of line.
  const sendKey = (bytes, e) => { if (ws.readyState === 1) ws.send(bytes); e.preventDefault(); return false; };
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true;
    // The board's whole Ctrl+Cmd+<key> shortcut family (CTRL_CMD_KEYS) —
    // swallow here so xterm doesn't emit a stray byte (e.g. forward-delete
    // \x1b[3~, or the Ctrl-U below) before the window handler acts. Checked
    // before the plain Cmd+⌫ clear-line chord since that one doesn't gate on Ctrl.
    if (e.metaKey && e.ctrlKey && CTRL_CMD_KEYS.has(e.key.toLowerCase())) { e.preventDefault(); return false; }
    if (e.key === 'Enter' && e.shiftKey) return sendKey('\x1b\r', e);
    if (e.metaKey && !e.shiftKey && e.key === 'ArrowLeft') return sendKey('\x1bb', e);
    if (e.metaKey && !e.shiftKey && e.key === 'ArrowRight') return sendKey('\x1bf', e);
    if (e.metaKey && e.key === 'Backspace') return sendKey('\x15', e);
    return true;
  });
  let lastCols = term.cols;
  let lastRows = term.rows;
  // Re-fit and push our size to the pty. `force` re-asserts even when the count is
  // unchanged: used on (re)attach so the open-time query-string size — computed
  // before layout/fonts fully settle, and never re-sent if the ResizeObserver's
  // initial fire beats the socket open — is corrected to the real terminal size.
  // Without force we skip no-op resizes, since a redundant tmux resize repaints.
  const syncSize = (force) => {
    try {
      fit.fit();
      if (force || term.cols !== lastCols || term.rows !== lastRows) {
        lastCols = term.cols;
        lastRows = term.rows;
        if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      }
    } catch {
      /* terminal disposed */
    }
  };
  // Assert our true size once the socket is open (so tmux's idea of our size
  // matches what xterm renders); the server forces a repaint after the resize.
  ws.onopen = () => syncSize(true);
  const ro = new ResizeObserver(() => syncSize(false));
  ro.observe(el);
  current = { term, ws, fit, ro, clickHandler, sessionId: s.sessionId };
  // Selecting a session lands keyboard focus on the Claude input so the user can
  // type immediately — without this they'd have to click the terminal a second
  // time. The textarea focus listener above marks the session user-attended.
  term.focus();
}

// Close the detail panel + terminal and clear the selection, so the periodic
// graph refresh doesn't silently re-open the sidebar for the still-selected card.
function closePanel() {
  selectedSessionId = null;
  closeTerminal();
  hideSidebar();
  if (currentView === 'grid') renderGrid();
}

// --- new session modal ---
const modal = document.getElementById('modal');
// Recency-ordered, de-duplicated recent folders for the dispatch dropdown. A
// custom dropdown (not <datalist>) so we can anchor it below the input and cap it.
let recentFolders = [];
let suggestIndex = -1;
function refreshFolderList() {
  // Live sessions and history both, so a folder survives the session ending;
  // newest activity first so the most relevant folders lead.
  const items = [
    ...latestSessions.flatMap((s) => [s.cwd, ...(s.addDirs || [])].map((c) => ({ cwd: c, at: s.lastActivity || 0 }))),
    ...latestHistory.map((h) => ({ cwd: h.cwd, at: h.archivedAt || 0 })),
  ].filter((x) => x.cwd && !isScratchDir(x.cwd)).map((x) => ({ cwd: repoRoot(x.cwd), at: x.at }));
  items.sort((a, b) => b.at - a.at);
  const seen = new Set();
  recentFolders = [];
  for (const { cwd } of items) if (!seen.has(cwd)) { seen.add(cwd); recentFolders.push(cwd); }
  if (!document.getElementById('folder-suggest')?.classList.contains('hidden')) renderFolderSuggest();
}
function renderFolderSuggest() {
  const box = document.getElementById('folder-suggest');
  const input = document.getElementById('m-cwd');
  if (!box || !input) return;
  const q = input.value.trim().toLowerCase();
  const matches = recentFolders.filter((p) => !q || p.toLowerCase().includes(q)).slice(0, 10);
  if (suggestIndex >= matches.length) suggestIndex = matches.length - 1;
  if (!matches.length) { hideFolderSuggest(); return; }
  box.innerHTML = matches
    .map((p, i) => `<div class="suggest-item${i === suggestIndex ? ' active' : ''}" data-path="${esc(p)}">${esc(p)}</div>`)
    .join('');
  box.classList.remove('hidden');
}
function hideFolderSuggest() {
  const box = document.getElementById('folder-suggest');
  if (box) { box.classList.add('hidden'); box.innerHTML = ''; }
  suggestIndex = -1;
}
// The most frequent cwd among a task's sessions (ties → most recently active),
// used to default the dialog's folder when targeting a task. '' if none.
// Collapse each cwd to its repo root first, so a task whose sessions ran in
// worktrees defaults to the repo (a valid dispatch target), never a worktree
// path — and worktrees of the same repo aggregate instead of splitting the vote.
function mostCommonCwd(sessions) { return mostCommonCwdPure(sessions, sessionsDir); }
function populateTaskSelect(selectedId) {
  const sel = document.getElementById('m-task');
  if (!sel) return;
  sel.innerHTML = ['<option value="">Unassigned (no task)</option>']
    .concat(latestTasks.tasks.filter((t) => !t.archivedAt).map((t) => `<option value="${esc(t.id)}">${esc(t.name)}</option>`))
    .join('');
  sel.value = selectedId && latestTasks.tasks.some((t) => t.id === selectedId) ? selectedId : '';
}
function setDispatchPending(p) { wtPending = p; renderWorktreeState(); }

// Message + Launch-gating for a classified worktree target (see classifyWorktreeTarget
// server-side). `warn` is informational (Launch stays enabled — reading it is the
// confirmation); `error` blocks Launch. `new`/unknown → no message.
function worktreeStatusMsg(v) {
  const b = document.getElementById('m-wt-branch').value.trim();
  switch (v.status) {
    case 'existing-branch':
      return { cls: 'warn', text: `Branch \`${b}\` already exists — it'll be checked out into a new worktree.` };
    case 'adopt':
      return { cls: 'warn', text: `A worktree for \`${b}\` already exists at ${v.conflictPath} — the session will start in it.` };
    case 'branch-in-use':
      return { cls: 'error', blocks: true, text: `Branch \`${b}\` is already checked out at ${v.conflictPath} — pick a different branch.` };
    case 'folder-blocked':
      return { cls: 'error', blocks: true, text: `${v.folderPath} already exists and isn't an adoptable worktree — pick a different branch or folder.` };
    default:
      return null;
  }
}

// Single source of truth for the worktree controls + Launch button, given the
// current cwd and the latest validation. States:
//  - scratch/blank cwd: worktree N/A → tickbox disabled+off, fields disabled,
//    accent hint. A normal session is fine here, so Launch stays enabled.
//  - real folder, not a git repo, toggle ON: can't make the worktree the user
//    asked for → fields disabled, red error, Launch DISABLED. Untick (tickbox
//    stays enabled) to launch a normal session, or pick a repo.
//  - real git repo: everything enabled.
function renderWorktreeState() {
  const box = document.getElementById('m-worktree');
  const cwd = document.getElementById('m-cwd').value.trim();
  const scratch = !cwd || isScratchDir(cwd);
  const nonGit = !scratch && box.checked && wtValidation && wtValidation.ok === false;

  // Scratch/blank: a worktree is impossible, so hide the checkbox entirely and
  // let the message carry the explanation under the "Worktree" title.
  document.getElementById('m-worktree-row').classList.toggle('hidden', scratch);
  box.disabled = scratch;
  if (scratch) box.checked = false;

  // Fields are shown (slide in) only when worktree mode is usable: ticked, real
  // git repo. Otherwise they slide away and the message explains why.
  const fieldsActive = box.checked && !scratch && !nonGit;
  document.getElementById('m-worktree-fields-wrap').classList.toggle('open', fieldsActive);
  document.getElementById('m-wt-branch').disabled = !fieldsActive;
  document.getElementById('m-wt-folder').disabled = !fieldsActive;

  const inWorktree = box.checked && wtValidation && wtValidation.ok && wtValidation.inWorktree;
  // The target branch (typed or auto-derived from intent) may already exist /
  // already have a worktree. The server classifies it; we surface it live —
  // including for the untouched auto-derived default, so reusing an existing
  // worktree by leaving the fields alone still warns instead of silently
  // bumping to a new one.
  const wt = (box.checked && !scratch && !nonGit && wtValidation && wtValidation.ok) ? worktreeStatusMsg(wtValidation) : null;
  const msgEl = document.getElementById('m-worktree-msg');
  if (scratch) {
    msgEl.textContent = 'Not available for scratch sessions — set a git project folder above to use a worktree.';
    msgEl.className = 'worktree-msg hint';
  } else if (nonGit) {
    msgEl.textContent = `${wtValidation.reason} — untick to launch here without a worktree, or pick a folder that's a git repo.`;
    msgEl.className = 'worktree-msg error';
  } else if (wt) {
    msgEl.textContent = wt.text;
    msgEl.className = `worktree-msg ${wt.cls}`;
  } else if (inWorktree) {
    // Legal, but the new worktree branches off the main checkout, not this one.
    msgEl.textContent = 'This folder is itself a worktree — the new one will branch from the main checkout, not this worktree.';
    msgEl.className = 'worktree-msg hint';
  } else {
    msgEl.className = 'worktree-msg hidden';
  }

  // Launch is blocked while a worktree is being created, when one is requested but
  // impossible (non-git), or when the target can't be made (branch busy elsewhere,
  // folder occupied) — i.e. the session can't be created as asked.
  const go = document.getElementById('m-go');
  // In schedule mode the worktree validation is advisory (the authoritative
  // create+classify happens at fire time), so Save is gated only by the picker.
  if (scheduleMode()) { syncScheduleGo(); return; }
  go.disabled = wtPending || nonGit || Boolean(wt && wt.blocks);
  go.textContent = wtPending ? 'Creating…' : 'Launch';
}

// Toggle/blank logic + kick a server validation when on with a real cwd.
function syncWorktreeFields() {
  const cwd = document.getElementById('m-cwd').value.trim();
  if (cwd !== wtLastCwd) { wtValidation = null; wtLastCwd = cwd; } // cwd changed → revalidate
  renderWorktreeState();
  refreshWorktreeDefaults();
  validateWorktree();
}

// Branch default from intent; folder default from branch — unless user-edited.
function refreshWorktreeDefaults() {
  const branchEl = document.getElementById('m-wt-branch');
  const folderEl = document.getElementById('m-wt-folder');
  if (!wtBranchEdited) branchEl.value = wtSlug(document.getElementById('m-intent').value);
  if (!wtFolderEdited) {
    const branch = branchEl.value || 'work';
    if (wtValidation && wtValidation.ok && wtValidation.repoRoot) {
      // Full path: a sibling of the repo by default, but the user can edit it to
      // place the worktree anywhere.
      const parent = wtValidation.repoRoot.replace(/\/[^/]*$/, '');
      folderEl.value = `${parent}/${wtValidation.repoName}-worktree-${branch}`;
    } else {
      // Before validation lands we don't know the repo root — show a bare name.
      const repo = (document.getElementById('m-cwd').value.trim() || proposedCwd || '').replace(/\/+$/, '').split('/').pop() || 'repo';
      folderEl.value = `${repo}-worktree-${branch}`;
    }
  }
}

function validateWorktree() {
  const cwd = document.getElementById('m-cwd').value.trim();
  const box = document.getElementById('m-worktree');
  if (!box.checked || !cwd || isScratchDir(cwd)) return; // only need git-ness when worktree is on for a real folder
  // Always classify the real target — refreshWorktreeDefaults() keeps the branch
  // field current with the auto-derived slug even when untouched, so this
  // catches existing-branch / adopt / blocked targets whether typed or auto-derived.
  const branch = document.getElementById('m-wt-branch').value.trim();
  send({ type: 'validate-worktree', cwd, branch });
}

function onWorktreeValidation(msg) {
  wtValidation = msg;
  renderWorktreeState();
  refreshWorktreeDefaults();
}

// Mode selection (Standard vs Workflow), driven by the two mode cards. In workflow
// mode the "intent" is really an issue, and the session always runs in an auto
// worktree created server-side — so relabel the field, swap the manual worktree
// controls for a one-line confirmation (they'd be a misleading no-op), and echo the
// mode on the Launch button. The worktree is sent directly from submitDispatch,
// never via the m-worktree checkbox. A review session (reviewMode) hides both the
// worktree box (it must share the source's dir to see uncommitted WIP, so a fresh
// worktree would defeat it) and the Standard/Workflow selector (a review is always
// Standard).
function syncWorkflow() {
  const on = dispatchMode === 'workflow';
  document.getElementById('m-mode-standard').classList.toggle('selected', !on);
  document.getElementById('m-mode-workflow').classList.toggle('selected', on);
  document.getElementById('m-intent-label').textContent = on
    ? 'Issue (Jira key, GitHub issue, or description)'
    : 'Intent / first prompt';
  document.getElementById('m-intent').placeholder = on
    ? 'ENT-1234, a GitHub issue URL or #number, or a free-text task'
    : 'What should the agent work on?';
  document.getElementById('m-mode-cards').classList.toggle('hidden', reviewMode);
  document.querySelector('.worktree-box').classList.toggle('hidden', on || reviewMode);
  document.getElementById('m-wf-worktree-note').classList.toggle('hidden', !on);
  document.getElementById('m-wf-auto-merge-row').classList.toggle('hidden', !on);
  const go = document.getElementById('m-go');
  // Schedule mode owns the Save label (see syncScheduleGo); only set the launch
  // labels here. The violet wf tint applies in both (a scheduled workflow run).
  if (!scheduleMode()) go.textContent = on ? 'Start workflow' : 'Launch';
  go.classList.toggle('wf', on);
  syncRuntimeToggle();
}
function setDispatchMode(mode) { dispatchMode = mode; syncWorkflow(); }

// The runtime picker defaults to Local (host). Every non-local runtime is currently
// Claude-only (devcontainer's status/cost hooks read Claude paths; codex-in-container
// isn't wired), so for a non-Claude agent disable each non-local <option> and snap
// the value back to local — a stale devcontainer selection must not survive an agent
// swap. Workflow runs ARE supported (the issue-to-pr skill dir is copied into the
// container). Extensible: a new runtime adds an <option> in index.html; the Claude-
// only gate here covers it, and any extra per-runtime constraints slot in alongside.
function syncRuntimeToggle() {
  const sel = document.getElementById('m-model');
  const agent = sel.options[sel.selectedIndex]?.dataset.agent || 'claude';
  const rt = document.getElementById('m-runtime');
  for (const opt of rt.options) {
    if (opt.value !== 'local') opt.disabled = agent !== 'claude';
  }
  const cur = rt.options[rt.selectedIndex];
  if (cur && cur.disabled) rt.value = 'local';
}

// #modal is reused for three jobs (modalMode): launching now, creating a schedule,
// editing one. scheduleMode() gates every divergence; the dispatch fields are read
// identically in all three so a scheduled dispatch is byte-for-byte a manual one.
function scheduleMode() { return modalMode === 'schedule-create' || modalMode === 'schedule-edit'; }

// Refresh the modal's chrome (title, When section, primary button) for modalMode.
function syncModalChrome() {
  // Sub-agent detail is a read-only reuse of #modal (a new modalMode): hide every
  // launch/schedule field + the primary action, show only the detail block.
  const isSub = modalMode === 'subagent';
  document.getElementById('m-subagent').classList.toggle('hidden', !isSub);
  document.getElementById('m-dispatch-fields').classList.toggle('hidden', isSub);
  document.getElementById('m-session-fields').classList.add('hidden');
  document.getElementById('m-go').classList.toggle('hidden', isSub);
  document.getElementById('m-quick-launch')?.classList.toggle('hidden', isSub);
  if (isSub) { document.getElementById('m-when').classList.add('hidden'); return; }
  const sched = scheduleMode();
  syncQuickLaunch();
  document.getElementById('m-when').classList.toggle('hidden', !sched);
  document.getElementById('m-title').textContent = modalMode === 'schedule-edit'
    ? 'Edit schedule' : modalMode === 'schedule-create' ? 'Schedule a session' : 'Dispatch a new session';
  // Launch mode is always a dispatch (no action selector, dispatch fields visible).
  if (!sched) {
    document.getElementById('m-dispatch-fields').classList.remove('hidden');
    document.getElementById('m-session-fields').classList.add('hidden');
    return;
  }
  syncWhenRows();
  syncScheduleAction();
}

// Show the dispatch fields or the existing-session fields for the selected action.
// The message is now always optional (one field, no per-kind relabelling — the
// server resumes-or-messages by liveness at fire time). Re-runs Save validity.
// Schedule mode only.
function syncScheduleAction() {
  const isDispatch = scheduleAction === 'dispatch';
  document.getElementById('m-dispatch-fields').classList.toggle('hidden', !isDispatch);
  document.getElementById('m-session-fields').classList.toggle('hidden', isDispatch);
  document.querySelectorAll('#m-sch-action .sched-action-btn').forEach((b) => {
    const on = b.dataset.action === scheduleAction;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
  syncScheduleGo();
}

function setScheduleAction(kind) {
  scheduleAction = kind;
  syncScheduleAction();
}

// Fill the target-session dropdown from the board, annotating each with its current
// state (running / dormant) so the picker is informative — the server branches by
// liveness at fire time (resume if dormant, message into the pane if live).
function populateTargetSelect(selectedId) {
  const sel = document.getElementById('m-sch-target');
  const sessions = [...latestSessions].sort((a, b) => (a.label || '').localeCompare(b.label || ''));
  sel.innerHTML = sessions.length
    ? sessions.map((s) => `<option value="${esc(s.sessionId)}">${esc(s.label || s.sessionId)} · ${s.managed ? 'running' : 'dormant'}</option>`).join('')
    : '<option value="">No sessions on the board</option>';
  if (selectedId && sessions.some((s) => s.sessionId === selectedId)) sel.value = selectedId;
}

// The friendly picker's three cadences swap which inputs show; Save is gated on
// whenValid. Re-rendered on every picker change.
function syncWhenRows() {
  const cadence = document.getElementById('m-sch-cadence').value;
  document.getElementById('m-sch-at-row').classList.toggle('hidden', cadence !== 'once');
  document.getElementById('m-sch-time-row').classList.toggle('hidden', cadence === 'once');
  document.getElementById('m-sch-weekdays-row').classList.toggle('hidden', cadence !== 'daily');
  document.getElementById('m-sch-days-row').classList.toggle('hidden', cadence !== 'weekly');
  syncScheduleGo();
}
function syncScheduleGo() {
  if (!scheduleMode()) return;
  const go = document.getElementById('m-go');
  go.textContent = 'Save schedule';
  go.disabled = !(whenValid(readPicker(), Date.now()) && scheduleActionValid());
}
// A dispatch needs only a valid `when` (intent can be empty, like a manual launch);
// a session action just needs a target — the message is always optional.
function scheduleActionValid() {
  if (scheduleAction === 'dispatch') return true;
  return Boolean(document.getElementById('m-sch-target').value);
}
// Build the schedule's action payload from the form for the selected kind. Dispatch
// reuses readDispatchFields verbatim (so a scheduled dispatch is byte-for-byte a
// manual one); the session action carries the target + optional message text.
function readScheduleAction() {
  if (scheduleAction === 'dispatch') return { kind: 'dispatch', dispatch: readDispatchFields() };
  return {
    kind: 'session',
    sessionId: document.getElementById('m-sch-target').value,
    message: document.getElementById('m-sch-message').value.trim(),
  };
}
function readPicker() {
  return {
    cadence: document.getElementById('m-sch-cadence').value,
    at: document.getElementById('m-sch-at').value,
    time: document.getElementById('m-sch-time').value,
    weekdaysOnly: document.getElementById('m-sch-weekdays').checked,
    days: [...document.querySelectorAll('#m-sch-days .day-toggle.on')].map((b) => Number(b.dataset.day)),
  };
}
function fillPicker(p) {
  document.getElementById('m-sch-cadence').value = p.cadence;
  document.getElementById('m-sch-at').value = p.at || '';
  document.getElementById('m-sch-time').value = p.time || '09:00';
  document.getElementById('m-sch-weekdays').checked = Boolean(p.weekdaysOnly);
  document.querySelectorAll('#m-sch-days .day-toggle').forEach((b) => {
    const on = p.days.includes(Number(b.dataset.day));
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
}

// The dispatch payload, read EXACTLY as submitDispatch reads it, so a scheduled
// dispatch and a manual one carry the same fields (runDispatch is the shared body).
function readDispatchFields() {
  const sel = document.getElementById('m-model');
  const model = sel.value.trim();
  const wfOn = dispatchMode === 'workflow';
  const agent = sel.options[sel.selectedIndex]?.dataset.agent || 'claude';
  // !reviewMode makes the "a review never creates a worktree" invariant explicit
  // (the box is also hidden+unchecked in review mode, but don't rely on that alone).
  const wtOn = !wfOn && !reviewMode && document.getElementById('m-worktree').checked && !document.getElementById('m-worktree').disabled;
  // Runtime picker; Local is the default and sent as undefined (the server stores
  // only non-local). Non-Claude agents are local-only (see syncRuntimeToggle), so
  // resolve to local for them regardless of a stale selection — a dispatch safety net.
  const runtime = agent === 'claude' ? document.getElementById('m-runtime').value : 'local';
  return {
    cwd: document.getElementById('m-cwd').value.trim() || proposedCwd,
    intent: document.getElementById('m-intent').value.trim(),
    model: model || undefined,
    effort: document.getElementById('m-effort').value || undefined,
    agent,
    taskId: document.getElementById('m-task').value || undefined,
    workflow: wfOn || undefined,
    autoMergeOnPass: wfOn && document.getElementById('m-wf-auto-merge').checked || undefined,
    worktree: (wfOn || wtOn) || undefined,
    worktreeBranch: wtOn ? document.getElementById('m-wt-branch').value.trim() : undefined,
    worktreeFolderName: wtOn && wtFolderEdited ? document.getElementById('m-wt-folder').value.trim() : undefined,
    // Standard mode never auto-bumps on collision — the classify-and-warn/block
    // flow above handles it, letting the user see and fix a conflict. Only
    // Workflow (fleet) mode forces auto, since each run needs a guaranteed-fresh,
    // isolated checkout.
    worktreeAuto: wfOn,
    parentSession: parentSessionId || undefined,
    runtime: runtime !== 'local' ? runtime : undefined,
  };
}

// One opener for all three modalModes. `schedule` (when editing) pre-fills every
// field from the saved dispatch + picker; otherwise the form defaults as for a
// launch, with the cwd defaulted from the target task's sessions.
function openModal({ mode, taskId = null, schedule = null }) {
  modalMode = mode;
  editingScheduleId = schedule?.id || null;
  // The action kind (and its dispatch bag) come off schedule.action; a launch is
  // always a dispatch. A legacy schedule with a bare top-level dispatch still works.
  const action = schedule?.action || (schedule?.dispatch ? { kind: 'dispatch', dispatch: schedule.dispatch } : null);
  scheduleAction = action?.kind || 'dispatch';
  const d = (action?.kind === 'dispatch' ? action.dispatch : null) || {};
  populateTargetSelect(action?.sessionId);
  document.getElementById('m-sch-message').value = action && action.kind !== 'dispatch' ? (action.message || '') : '';
  const wantTask = typeof taskId === 'string' ? taskId : (d.taskId || null);
  populateTaskSelect(wantTask);
  dispatchMode = d.workflow ? 'workflow' : 'standard'; // never sticky otherwise
  // Propose a fresh timestamped scratch folder; show it relative, send it absolute.
  const now = new Date();
  const stamp = `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}${pad2(now.getHours())}${pad2(now.getMinutes())}${pad2(now.getSeconds())}`;
  proposedCwd = sessionsDir ? `${sessionsDir}/${stamp}` : '';
  const cwdInput = document.getElementById('m-cwd');
  const selected = document.getElementById('m-task').value;
  // Default the repo to the task's dominant cwd. Live sessions win; if the task
  // has none left on the board (e.g. all archived) fall back to its history —
  // archived entries keep their task assignment + cwd — so the repo isn't lost.
  const cwdForTask = (sel) => {
    const pick = (list) => mostCommonCwd(list.filter((s) => assignedTaskId(s.sessionId) === sel));
    return pick(latestSessions) || pick(latestHistory);
  };
  cwdInput.value = schedule
    ? (d.cwd || '')
    : (selected ? cwdForTask(selected) : '');
  cwdInput.placeholder = proposedCwd ? tildeCollapse(proposedCwd) : '/Users/you/vcs/project';
  document.getElementById('m-intent').value = d.intent || '';
  if (d.model) { document.getElementById('m-model').value = d.model; modelEdited = true; }
  // A scheduled worktree restores the checkbox; workflow mode drives its own.
  document.getElementById('m-worktree').checked = Boolean(d.worktree) && !d.workflow;
  // Restore the saved runtime (Local default); syncWorkflow→syncRuntimeToggle re-gates by agent.
  document.getElementById('m-runtime').value = d.runtime || 'local';
  document.getElementById('m-wf-auto-merge').checked = Boolean(d.autoMergeOnPass);
  wtBranchEdited = false; wtFolderEdited = false; wtValidation = null; wtLastCwd = null; wtPending = false;
  reviewMode = false;
  parentSessionId = null;
  document.getElementById('m-sch-name').value = schedule?.name || '';
  fillPicker(schedule ? parseWhen(schedule.when) : defaultPicker());
  syncModalChrome();
  syncWorkflow();
  setDispatchPending(false);
  syncWorktreeFields();
  suggestIndex = -1;
  modal.classList.remove('hidden');
  (scheduleMode() ? document.getElementById('m-sch-name') : document.getElementById('m-intent')).focus();
}
// Default one-off ~1h out (rounded to the minute), 09:00 for recurring.
function defaultPicker() {
  return { cadence: 'once', at: toDatetimeLocalValue(Date.now() + 3600e3), time: '09:00', weekdaysOnly: false, days: [] };
}
function openDispatch(taskId = null, opts = {}) {
  pendingTodoConsume = null;
  const taskSel = document.getElementById('m-task');
  if (taskSel) taskSel.disabled = Boolean(opts.lockTask);
  openModal({ mode: 'launch', taskId });
  // The source session's exact folder must win over openModal's task-dominant cwd.
  if (opts.cwd) document.getElementById('m-cwd').value = opts.cwd;
  // Implicit nesting context (e.g. a review's source session) — not a user toggle,
  // so it isn't reflected in any dialog control; just carried through to dispatch.
  if (opts.parentSession) parentSessionId = opts.parentSession;
  // "Review session" passes the source agent → configure the dialog as a review:
  // flip the model to the complementary agent, seed the review prompt (only if the
  // field is empty, never clobbering typed text), and hide the worktree box (a review
  // must share the source's dir). reviewMode persists so a mode toggle keeps it hidden.
  if (opts.sourceAgent) {
    reviewMode = true;
    const m = complementaryModel(opts.sourceAgent, availableAgents);
    if (m) { document.getElementById('m-model').value = m; modelEdited = true; }
    const intent = document.getElementById('m-intent');
    if (!intent.value.trim()) intent.value = REVIEW_PROMPT;
    syncWorkflow(); // re-apply visibility now that reviewMode is set (hides the worktree box)
  }
  if (opts.intent) {
    document.getElementById('m-intent').value = opts.intent;
    refreshWorktreeDefaults();
  }
}
function openScheduleEditor(schedule = null) {
  openModal({ mode: schedule ? 'schedule-edit' : 'schedule-create', schedule });
}

// Open the read-only sub-agent detail modal (from either the card spine or the panel
// disclosure) and fire the on-demand fetch. Does NOT run openModal's launch/schedule
// field population — it's a distinct mode of the same #modal shell.
function openSubagentModal(sessionId, subagentId) {
  if (!sessionId || !subagentId) return;
  modalMode = 'subagent';
  subagentModalReq = { sessionId, subagentId };
  syncModalChrome();
  document.getElementById('m-title').textContent = 'Sub-agent';
  document.getElementById('m-sa-prompt').textContent = 'Loading…';
  document.getElementById('m-sa-tools').textContent = '';
  document.getElementById('m-sa-result').textContent = '';
  modal.classList.remove('hidden');
  // Every other modal mode focuses a field on open, so a keydown (notably
  // Escape → cancelModal, bound on #modal itself) bubbles up from inside it.
  // This mode has no field to focus, so without this Escape silently did
  // nothing — focus never left whatever was clicked to open the modal.
  document.getElementById('m-cancel').focus();
  send({ type: 'subagent-detail', sessionId, subagentId });
}

// Render the async detail reply — but only if the modal is still open on the SAME
// sub-agent (the user may have clicked another row, or closed it, while in flight).
function onSubagentDetail(msg) {
  if (modalMode !== 'subagent' || !subagentModalReq) return;
  if (subagentModalReq.sessionId !== msg.sessionId || subagentModalReq.subagentId !== msg.subagentId) return;
  document.getElementById('m-sa-prompt').textContent = msg.prompt || '(no prompt recorded)';
  const tools = document.getElementById('m-sa-tools');
  if (msg.toolCalls === null) {
    tools.textContent = 'Not available for this sub-agent';
  } else if (!msg.toolCalls.length) {
    tools.textContent = '(no tool calls)';
  } else {
    tools.innerHTML = `<ol class="sa-tool-list">${msg.toolCalls.map((t) => `<li><span class="sa-tool-name">${esc(t.name)}</span> <span class="sa-tool-target">${esc(t.target || '')}</span></li>`).join('')}</ol>`;
  }
  document.getElementById('m-sa-result').textContent = msg.result || '(no result recorded)';
}

function submitDispatch() {
  if (modal.classList.contains('hidden')) return;
  if (modalMode === 'subagent') return; // read-only view: no primary action
  if (scheduleMode()) return submitSchedule();
  const fields = readDispatchFields();
  const wfOn = dispatchMode === 'workflow';
  const wtOn = fields.worktree && !wfOn;
  if (wtOn && wtValidation && wtValidation.ok === false) {
    document.getElementById('m-worktree-msg').classList.remove('hidden');
    return; // can't create a worktree here — let the user untick or fix the folder
  }
  // A classified target the server says is impossible (branch busy / folder occupied)
  // blocks dispatch — Launch is disabled for it, but Cmd+Enter reaches here directly.
  if (wtOn && wtValidation && wtValidation.ok && worktreeStatusMsg(wtValidation)?.blocks) return;
  send({ type: 'dispatch', ...fields });
  // Both a workflow run and a manual worktree create the worktree server-side, so
  // keep the dialog open (pending) until the 'dispatched' ack lands.
  if (wfOn || wtOn) { wtPending = true; setDispatchPending(true); toast(wfOn ? 'Starting workflow…' : 'Creating worktree…'); return; }
  modal.classList.add('hidden');
  document.getElementById('m-intent').value = '';
  toast('Launching session…');
}

// Save a schedule: compile the picker → `when`, read the same dispatch fields a
// launch sends, and create/update. Worktree validation is advisory here (the
// authoritative create happens at fire time), so we never block on it.
function submitSchedule() {
  const picker = readPicker();
  if (!whenValid(picker, Date.now()) || !scheduleActionValid()) { syncScheduleGo(); return; }
  const when = compileWhen(picker);
  if (!when) { syncScheduleGo(); return; }
  const name = document.getElementById('m-sch-name').value.trim();
  const action = readScheduleAction();
  const editing = modalMode === 'schedule-edit';
  send(editing
    ? { type: 'schedule-update', id: editingScheduleId, patch: { name, when, action } }
    : { type: 'schedule-create', name, when, action });
  closeModal();
  openSchedulesPanel(); // back to the list, which the rebuild refreshes
  toast(editing ? 'Schedule saved' : 'Schedule created');
}

// Close #modal and reset to launch mode. If we were editing/creating a schedule,
// the caller decides whether to reopen the panel.
function closeModal() {
  modal.classList.add('hidden');
  wtPending = false; setDispatchPending(false);
  modalMode = 'launch'; editingScheduleId = null;
  subagentModalReq = null;
  pendingTodoConsume = null;
  document.getElementById('m-task').disabled = false;
}
// Dismiss (Cancel/Escape): drop back to the Schedules panel when we came from it,
// so editing a schedule round-trips through the panel rather than the bare board.
function cancelModal() {
  const reopen = scheduleMode();
  closeModal();
  if (reopen) openSchedulesPanel();
}

document.getElementById('new-session').addEventListener('click', () => openDispatch());
// Global settings live in their own module (registry + centered #settings-modal),
// opened from the bottom-rail gear (#settings-btn). initSettings wires both.
// The server bridge backs scope:'server' entries: reads come off the flag the
// graph carries, writes go through the control WS (the local assignment keeps the
// modal's optimistic toggle honest until the rebuild echoes back). The appearance
// bridge hands the Appearance section its theme rows + font-size row (bespoke
// widgets owned by theme.js / this module — settings.js just composes them in).
initSettings({
  server: {
    get: (id) => {
      if (id === 'taskMemoryEnabled') return taskMemoryEnabled;
      if (id === 'subagentsExpandedByDefault') return subagentsExpandedByDefault;
      return undefined;
    },
    set: (id, value) => {
      if (id === 'taskMemoryEnabled') {
        taskMemoryEnabled = Boolean(value);
        send({ type: 'set-task-memory-enabled', enabled: taskMemoryEnabled });
      } else if (id === 'subagentsExpandedByDefault') {
        subagentsExpandedByDefault = Boolean(value);
        send({ type: 'set-subagents-expanded-by-default', enabled: subagentsExpandedByDefault });
      }
    },
  },
  appearance: {
    themeRowsHtml: renderThemeRows,
    fontSizeRowHtml,
    onThemeSelect: selectStyle,
    onFontSize: setTermFontSize,
  },
});
document.getElementById('m-cancel').addEventListener('click', cancelModal);
document.getElementById('m-go').addEventListener('click', submitDispatch);
[1, 2].forEach((n) =>
  document.getElementById(`m-quick-${n}`).addEventListener('click', () => quickLaunch(quickLaunchModels[n - 1])));
document.getElementById('m-worktree').addEventListener('change', syncWorktreeFields);
document.getElementById('m-mode-standard').addEventListener('click', () => setDispatchMode('standard'));
document.getElementById('m-mode-workflow').addEventListener('click', () => setDispatchMode('workflow'));
// Schedule "When" picker: each change re-evaluates which rows show + Save validity.
document.getElementById('m-sch-cadence').addEventListener('change', syncWhenRows);
document.getElementById('m-sch-at').addEventListener('input', syncScheduleGo);
document.getElementById('m-sch-time').addEventListener('input', syncScheduleGo);
document.getElementById('m-sch-weekdays').addEventListener('change', syncScheduleGo);
document.querySelectorAll('#m-sch-days .day-toggle').forEach((b) => b.addEventListener('click', () => {
  const on = !b.classList.contains('on');
  b.classList.toggle('on', on);
  b.setAttribute('aria-pressed', on ? 'true' : 'false');
  syncScheduleGo();
}));
document.querySelectorAll('#m-sch-action .sched-action-btn').forEach((b) =>
  b.addEventListener('click', () => setScheduleAction(b.dataset.action)));
document.getElementById('m-sch-target').addEventListener('change', syncScheduleGo);
document.getElementById('m-sch-message').addEventListener('input', syncScheduleGo);
document.getElementById('m-cwd').addEventListener('input', syncWorktreeFields);
document.getElementById('m-intent').addEventListener('input', () => { refreshWorktreeDefaults(); validateWorktree(); });
// Strip disallowed chars as you type, preserving the cursor (1:1 → '-').
function wtSanitize(el, re) {
  const pos = el.selectionStart, cleaned = el.value.replace(re, '-');
  if (cleaned !== el.value) { el.value = cleaned; el.setSelectionRange(pos, pos); }
}
document.getElementById('m-wt-branch').addEventListener('input', (e) => { wtSanitize(e.target, /[^a-zA-Z0-9-]/g); wtBranchEdited = true; refreshWorktreeDefaults(); validateWorktree(); });
document.getElementById('m-wt-folder').addEventListener('input', (e) => { wtSanitize(e.target, /[^a-zA-Z0-9/._~-]/g); wtFolderEdited = true; });
document.getElementById('m-model').addEventListener('change', () => { modelEdited = true; populateEffortSelect(); syncRuntimeToggle(); });
document.getElementById('m-effort').addEventListener('change', () => { effortEdited = true; });
modal.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); submitDispatch(); }
  else if ((e.metaKey || e.ctrlKey) && (e.key === '1' || e.key === '2') && !scheduleMode()) {
    e.preventDefault(); quickLaunch(quickLaunchModels[Number(e.key) - 1]);
  }
  else if (e.key === 'Escape') { e.preventDefault(); cancelModal(); }
});
(() => {
  const input = document.getElementById('m-cwd');
  const box = document.getElementById('folder-suggest');
  input.addEventListener('focus', () => { suggestIndex = -1; renderFolderSuggest(); });
  input.addEventListener('input', () => { suggestIndex = -1; renderFolderSuggest(); });
  input.addEventListener('blur', () => setTimeout(hideFolderSuggest, 120)); // let a click land first
  input.addEventListener('keydown', (e) => {
    if (box.classList.contains('hidden')) return;
    const items = [...box.querySelectorAll('.suggest-item')];
    if (e.key === 'ArrowDown') { e.preventDefault(); suggestIndex = Math.min(suggestIndex + 1, items.length - 1); renderFolderSuggest(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); suggestIndex = Math.max(suggestIndex - 1, 0); renderFolderSuggest(); }
    else if (e.key === 'Enter' && suggestIndex >= 0 && !e.metaKey && !e.ctrlKey) { e.preventDefault(); input.value = items[suggestIndex].dataset.path; hideFolderSuggest(); syncWorktreeFields(); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); hideFolderSuggest(); } // first Esc closes the dropdown, not the dialog
  });
  box.addEventListener('mousedown', (e) => {
    const item = e.target.closest('.suggest-item');
    if (!item) return;
    e.preventDefault(); // keep focus; avoids the blur-hide race
    input.value = item.dataset.path;
    hideFolderSuggest();
    syncWorktreeFields();
  });
})();

// --- Schedules panel ---
// A list-only surface over graph.schedules: toggle/run-now/delete act in place
// (their schedule-* control messages rebuild the graph, which re-renders the list);
// New/Edit hand off to #modal in schedule mode and round-trip back here.
const schedulesModal = document.getElementById('schedules-modal');
function openSchedulesPanel() { schedulesModal.classList.remove('hidden'); renderSchedules(); }
function closeSchedulesPanel() { schedulesModal.classList.add('hidden'); }

function renderSchedules() {
  const el = document.getElementById('schedules-list');
  if (!el) return;
  const list = latestSchedules.schedules || [];
  if (!list.length) {
    el.innerHTML = '<div class="sched-empty">No schedules yet. Create one to launch, resume, or message a session on a one-off or recurring cadence.</div>';
    return;
  }
  const labelFor = (id) => latestSessions.find((x) => x.sessionId === id)?.label;
  el.innerHTML = list.map((s) => {
    const meta = [cadenceSummary(s.when), truncate(actionSummary(s.action, labelFor), 44)].filter(Boolean).join(' · ');
    const next = s.enabled ? formatNextRun(s.nextRunAt, Date.now()) : '';
    const badge = s.missed ? '<span class="sched-badge">missed</span>' : '';
    const nextHtml = s.enabled
      ? `<span class="sched-next">${esc(next) || '—'}</span>`
      : '<span class="sched-next off">disabled</span>';
    return `<div class="sched-row${s.enabled ? '' : ' disabled'}" data-id="${esc(s.id)}">
      <label class="sched-enable" title="${s.enabled ? 'Disable' : 'Enable'}"><input type="checkbox" ${s.enabled ? 'checked' : ''} /></label>
      <div class="sched-main">
        <div class="sched-name">${esc(s.name)}${badge}</div>
        <div class="sched-meta">${esc(meta)}</div>
      </div>
      ${nextHtml}
      <div class="sched-actions">
        <button class="sched-run" title="Run now" aria-label="Run now">▶</button>
        <button class="sched-edit" title="Edit" aria-label="Edit">✎</button>
        <button class="sched-del" title="Delete" aria-label="Delete">✕</button>
      </div>
    </div>`;
  }).join('');
  const byId = (id) => list.find((s) => s.id === id);
  el.querySelectorAll('.sched-row').forEach((row) => {
    const id = row.dataset.id;
    row.querySelector('.sched-enable input').addEventListener('change', (e) =>
      send({ type: 'schedule-toggle', id, enabled: e.target.checked }));
    row.querySelector('.sched-run').addEventListener('click', () => {
      send({ type: 'schedule-run-now', id });
      toast(`Running "${byId(id)?.name || 'schedule'}" now…`);
    });
    row.querySelector('.sched-edit').addEventListener('click', () => {
      closeSchedulesPanel();
      openScheduleEditor(byId(id));
    });
    row.querySelector('.sched-del').addEventListener('click', () => {
      const name = byId(id)?.name || 'schedule';
      send({ type: 'schedule-delete', id });
      toast(`Schedule "${name}" deleted`);
    });
  });
}

document.getElementById('usage-btn').addEventListener('click', openUsagePanel);
document.getElementById('schedules-btn').addEventListener('click', openSchedulesPanel);
document.getElementById('schedules-close').addEventListener('click', closeSchedulesPanel);
document.getElementById('schedules-new').addEventListener('click', () => { closeSchedulesPanel(); openScheduleEditor(null); });
schedulesModal.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); closeSchedulesPanel(); } });
schedulesModal.addEventListener('mousedown', (e) => { if (e.target === schedulesModal) closeSchedulesPanel(); });

// --- websocket control ---
let ws;
export function send(obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }
function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onclose = () => { setTimeout(connect, 1500); };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'graph') applyGraph(msg.graph);
    else if (msg.type === 'config') { sessionsDir = msg.sessionsDir || ''; homeDir = msg.homeDir || ''; }
    else if (msg.type === 'agents') { if (Array.isArray(msg.agents) && msg.agents.length) availableAgents = msg.agents; populateModelSelect(); }
    else if (msg.type === 'resumable') onResumable(msg);
    else if (msg.type === 'notify') notify(msg.session);
    else if (msg.type === 'diff') onDiff(msg);
    else if (msg.type === 'diff-comments-result') onDiffCommentsResult(msg);
    else if (msg.type === 'pr-checks') onPrChecks(msg);
    else if (msg.type === 'pr-merge') onPrMerge(msg);
    else if (msg.type === 'pr-dirty') onPrDirty(msg);
    else if (msg.type === 'schedule-fired') toast(`Scheduled "${msg.name}" started`);
    else if (msg.type === 'schedule-error') toast(`Schedule "${msg.name}" failed: ${msg.message}`, true);
    else if (msg.type === 'schedule-missed') toast(`Schedule "${msg.name}" was overdue and skipped`, true);
    else if (msg.type === 'snooze-wake-error') toast(`Auto-wake failed for "${msg.label}" — the snooze was cleared`, true);
    else if (msg.type === 'pr-wake-error') toast(`Couldn't wake "${msg.label}" for PR #${msg.number}: ${msg.message}`, true);
    else if (msg.type === 'fd-warning') {
      if (msg.active) showSystemBanner(`⚠ Server open file count is climbing (currently ${msg.count}) — possible leak, check server logs`, { level: msg.level });
      else hideSystemBanner();
    }
    else if (msg.type === 'auto-archived') archivedToast(msg.session.sessionId, `${msg.session.label} exited — archived`, msg.session.worktree);
    // The "Kill jobs & archive" outcome — the immediate toast in archiveSession()
    // already fired; this replaces it once the nudge/wait/teardown actually finish.
    else if (msg.type === 'archived') {
      const worktree = latestSessions.find((x) => x.sessionId === msg.sessionId)?.worktree || null;
      const archivedIds = [msg.sessionId, ...(msg.childIds || [])];
      archivedToast(msg.sessionId, msg.unclean
        ? 'Archived — the background job may have been interrupted uncleanly'
        : 'Background jobs stopped — archived cleanly', worktree, archivedIds);
    }
    // The single toast for task-archive (no separate immediate one when the task
    // had no live sessions — see archiveTask() — so this never double-fires).
    else if (msg.type === 'task-archived') {
      const n = msg.archivedSessions || 0;
      const sessionsNote = n > 0 ? ` (${n} session${n > 1 ? 's' : ''})` : '';
      toast(msg.unclean
        ? `Task archived${sessionsNote} — a background job may have been interrupted uncleanly`
        : `Task archived${sessionsNote}`, false, {
        label: 'Restore task',
        duration: 10000,
        // Force through, no dialog — this is an immediate undo of the action the
        // user just took, so it restores the task AND every session it just
        // cascaded. The deliberate "task only vs. task + sessions" choice only
        // applies later, from History (see restoreTaskFromHistory).
        onClick: () => send({ type: 'task-unarchive', taskId: msg.taskId, restoreSessions: true }),
      });
    }
    // Nav signal for a task restore (toast or History): jump back to the board
    // and halo the tile, decoupled from the slower per-session resumes a
    // restoreSessions:true restore may still be doing in the background.
    else if (msg.type === 'task-unarchived') {
      setView('grid');
      flashRestoredTask(msg.taskId);
    }
    else if (msg.type === 'worktree-removed') {
      if (msg.branchExists) toast('Worktree removed', false, { actions: [{ label: 'Delete branch', onClick: () => send({ type: 'branch-delete', sessionId: msg.sessionId }) }], duration: 15000 });
      else toast('Worktree removed');
    }
    else if (msg.type === 'worktree-remove-blocked') {
      confirmDialog({
        title: 'Git refused to remove the worktree',
        body: `Git wouldn't remove the worktree:\n\n${msg.reason}\n\nForce-delete it anyway? Any uncommitted or untracked files in it will be lost.`,
        okLabel: 'Force delete',
      }).then((result) => { if (result === 'ok') send({ type: 'worktree-remove', sessionId: msg.sessionId, force: true }); });
    }
    else if (msg.type === 'container-stopped') toast(msg.stopped ? 'Container stopped' : 'No running container to stop');
    else if (msg.type === 'branch-deleted') toast(`Branch ${msg.branch} deleted`);
    else if (msg.type === 'branch-delete-blocked') {
      confirmDialog({
        title: 'Branch has unmerged commits',
        body: `Git wouldn't delete branch ${msg.branch}:\n\n${msg.reason}\n\nForce-delete it anyway? Its unmerged commits will be lost.`,
        okLabel: 'Force delete',
      }).then((result) => { if (result === 'ok') send({ type: 'branch-delete', sessionId: msg.sessionId, force: true }); });
    }
    else if (msg.type === 'forked') { pendingSelect = msg.sessionId; tryFulfillPending(); }
    else if (msg.type === 'resume-needs-dir') {
      const forking = msg.action === 'fork';
      const verb = forking ? 'fork' : 'resume';
      confirmDialog({
        title: 'Original folder was deleted',
        body: `The folder this session ran in is gone:\n\n${tildeCollapse(msg.dir)}\n\nRecreate it and ${verb} anyway? The full conversation is restored from the transcript — but the working files that were in that folder won't be.`,
        okLabel: `Recreate & ${verb}`,
      }).then((result) => {
        if (result !== 'ok') { toast(`${forking ? 'Fork' : 'Resume'} cancelled — original folder is gone.`); return; }
        if (forking) send({ type: 'fork', sessionId: msg.sessionId, recreateDir: true, prompt: msg.prompt || '', name: msg.name || '' });
        else send({ type: 'resume', sessionId: msg.sessionId, recreateDir: true });
      });
    }
    else if (msg.type === 'open-terminal') openShellTerminal({ terminalId: msg.terminalId, command: msg.command || '', sessionId: msg.sessionId || null });
    else if (msg.type === 'styles') setCustomStyles(msg.styles);
    else if (msg.type === 'subagent-detail') onSubagentDetail(msg);
    else if (msg.type === 'usage') onUsage(msg);
    else if (msg.type === 'memory') onMemory(msg);
    else if (msg.type === 'memory-changed') onMemoryChanged(msg);
    else if (msg.type === 'worktree-validation') onWorktreeValidation(msg);
    else if (msg.type === 'dispatched') {
      if (wtPending) {
        wtPending = false; setDispatchPending(false);
        modal.classList.add('hidden');
        document.getElementById('m-intent').value = '';
      }
      if (pendingTodoConsume) {
        const { taskId, todoId, key } = pendingTodoConsume;
        pendingTodoConsume = null;
        send({ type: 'todo-delete', taskId, todoId });
        const arr = (latestTasks.todos || {})[key];
        if (arr) {
          latestTasks.todos[key] = arr.filter((td) => td.id !== todoId);
          renderGrid();
        }
      }
    }
    else if (msg.type === 'error') {
      if (wtPending) {
        wtPending = false; setDispatchPending(false);
        // Workflow mode hides the worktree box, so its message slot is invisible —
        // surface the failure as a toast there; otherwise show it inline.
        const box = document.querySelector('.worktree-box');
        if (box.classList.contains('hidden')) { toast(msg.message, true); }
        else {
          const el = document.getElementById('m-worktree-msg');
          el.textContent = msg.message; el.classList.remove('hidden', 'hint'); el.classList.add('error');
        }
      } else {
        toast(msg.message, true);
      }
    }
  };
}

// --- notifications + toast ---
// While focused, an event belonging to any OTHER task is silenced — toast, browser
// Notification and PR-dot flash alike — so focus mode actually removes the
// distraction. `ownerId` is a session id for session-scope events, a task id for
// task-scope ones. Outside focus mode this is always false (nothing changes).
function focusSuppresses(scope, ownerId) {
  if (!focusModeActive()) return false;
  const focusedId = visibleTileIds(currentOrder(), minimisedIds)[0];
  const taskId = scope === 'task' ? ownerId : (assignedTaskId(ownerId) || ADHOC_ID);
  return taskId !== focusedId;
}

function notify(session) {
  if (focusSuppresses('session', session.sessionId)) return;
  const body = `${session.label}${session.waitingFor ? ' — ' + session.waitingFor : ''}`;
  if (window.Notification && Notification.permission === 'granted') {
    const n = new Notification('Claude needs you', { body });
    n.onclick = () => { window.focus(); selectSession(session.sessionId); };
  }
  toast(`⚠ ${body}`, false);
}

// A PR's CI checks crossed into passing/failing (one-time, server-detected).
// Passing → default accent toast, no card flash; failing → red .err toast + a
// one-shot flash on the PR dot. Reuses the browser Notification path like notify().
// Toast/notification phrasing per notifiable PR status. `failing` and
// `changes-requested` are action items (red toast + dot flash); `passing`
// (mergeable) and `awaiting-review` are progress (accent toast, no flash).
const PR_CHECK_TEXT = {
  passing: 'all checks passing, mergeable',
  failing: 'required checks are now failing',
  'awaiting-review': 'all checks passing, awaiting review',
  'changes-requested': 'changes requested on review',
};
// Repo name (just the <repo>, not owner/repo) from a PR url, for the toast prefix.
function prRepoName(url) {
  const m = /github\.com\/[^/]+\/([^/]+)\/pull\/\d+/.exec(url || '');
  return m ? m[1] : '';
}
function onPrChecks(msg) {
  if (focusSuppresses(msg.scope, msg.sessionId)) return;
  const isErr = msg.status === 'failing' || msg.status === 'changes-requested';
  // Omit the `(<repo>)` segment entirely for an enterprise/malformed url (prRepoName
  // returns '') rather than rendering bare `()` — mirrors the server's prPaneNudge.
  const repo = prRepoName(msg.url);
  const label = repo ? `PR #${msg.number} (${repo})` : `PR #${msg.number}`;
  const text = `[Agent Wrangler] ${label}: ${PR_CHECK_TEXT[msg.status] || msg.status}`;
  toast(text, isErr);
  if (window.Notification && Notification.permission === 'granted') {
    const n = new Notification(text);
    n.onclick = () => { window.focus(); if (msg.scope === 'session') selectSession(msg.sessionId); };
  }
  if (isErr) flashPr(msg.url);
}

// The wrangler auto-merged (or tried to) a session's PR on the passing
// transition, because that session opted into "Auto-merge when checks pass".
// Success → accent toast; failure → red .err toast + a one-shot dot flash, so a
// blocked merge (branch protection, conflicts) is visible rather than silent.
function onPrMerge(msg) {
  if (focusSuppresses(msg.scope, msg.sessionId)) return;
  const text = msg.ok
    ? `PR #${msg.number} auto-merged`
    : `PR #${msg.number} auto-merge failed: ${msg.error}`;
  toast(text, !msg.ok);
  if (!msg.ok) flashPr(msg.url);
}

// A linked PR just became DIRTY (merge conflicts with its base branch) — always
// an alert, unlike onPrChecks where only some statuses are errors. Mirrors
// onPrChecks' shape (focus-suppressed toast + browser Notification + dot flash).
function onPrDirty(msg) {
  if (focusSuppresses(msg.scope, msg.sessionId)) return;
  const repo = prRepoName(msg.url);
  const label = repo ? `PR #${msg.number} (${repo})` : `PR #${msg.number}`;
  const text = `[Agent Wrangler] ${label}: merge conflicts with the base branch`;
  toast(text, true);
  if (window.Notification && Notification.permission === 'granted') {
    const n = new Notification(text);
    n.onclick = () => { window.focus(); if (msg.scope === 'session') selectSession(msg.sessionId); };
  }
  flashPr(msg.url);
}
// Re-theme a live terminal when the style changes — registered here so theme.js
// stays decoupled from the terminal's `current` handle.
onThemeChange(() => { if (current) current.term.options.theme = readTerminalTheme(); });
initStyles();

if (window.Notification && Notification.permission === 'default') Notification.requestPermission();
// Restore the deep link on load. #view=history switches straight to History (it
// renders empty until the first graph, then focuses the filter); otherwise a
// #session link is fulfilled once the first graph contains it.
if (hashView() === 'history') setView('history');
else pendingSelect = hashSessionId();
populateModelSelect();
connect();
