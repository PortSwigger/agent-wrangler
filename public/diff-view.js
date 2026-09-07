import { send, latestSessions, setMaximized, renderGridIfVisible, taskForSession } from './app.js';
import { toast } from './toast.js';
import { X_ICON, MAXIMIZE_ICON, MINIMIZE_ICON } from './icons.js';
import {
  buildCommentsPayload, draftCount, parseDrafts, isSaveCommentKey,
  diffLineKeys, partitionDrafts, isStaleReply, shouldDeferDiffRender,
  draftKey, rangeSnapshot, draftSpanKeys, dragRange, diffPrLinks,
  draftStorageKeysForSource, clearSubmittedDraftSource, pairHunkLines,
} from './diff.js';
import {
  noticeEl, fileHeaderEl, hunkHeadEl, binaryEl, lineEl, pairRowEl, editorEl, detachedSectionEl,
  fileListEl, orderFilesForDisplay,
} from './diff-dom.js';

// The working-tree diff panel: a slide-in over the #grid slot (the terminal
// #sidebar stays live, so the user keeps talking to the agent while reviewing).
// Owns its own DOM wiring + transient state, reaching back into app.js for
// send/selection (same pattern as modals.js). All git access is server-side —
// this only renders the `diff` reply and batches inline review comments.

const REFRESH_MS = 3000;
const PR_REFRESH_MS = 30000;
// Defensive ceiling on the view-diff in-flight guard: if a reply is lost (WS blip),
// clear the flag so polling isn't wedged forever. Well above a normal slow git diff
// so it never fires for a merely-slow-but-alive request.
const INFLIGHT_TIMEOUT_MS = 12000;
// A diff-comments submit must resolve (diff-comments-result) within this window; if
// it doesn't (WS blip / lost reply), the Send button is un-stuck, the drafts are
// kept, and an inline error invites a retry. Generous because delivery to a DORMANT
// session resumes it first (relaunch + a ~2 s pane-ready settle before sendText).
const SUBMIT_TIMEOUT_MS = 20000;

const panelEl = document.getElementById('diff-panel');
const subEl = document.getElementById('diff-sub');
const bodyEl = document.getElementById('diff-body');
const filelistEl = document.getElementById('diff-filelist');
const sendBtn = document.getElementById('diff-send');
const closeBtn = document.getElementById('diff-close');
const fullscreenBtn = document.getElementById('diff-fullscreen');
const modeWtBtn = document.getElementById('diff-mode-wt');
const modeBranchBtn = document.getElementById('diff-mode-branch');
const modePrsEl = document.getElementById('diff-mode-prs');
const layoutInlineBtn = document.getElementById('diff-layout-inline');
const layoutSplitBtn = document.getElementById('diff-layout-split');

// One-time icon fill (icons are JS strings, so the static HTML leaves the slot
// empty). Close is icon-only; the send button keeps its text label.
closeBtn.innerHTML = X_ICON;
fullscreenBtn.innerHTML = MAXIMIZE_ICON;
sendBtn.title = 'Send to agent (⌘/Ctrl + Enter)';

let openSid = null;        // session whose diff is shown, or null when closed
let diffFullscreen = false; // the diff panel's own fullscreen (hides #sidebar); reset on close
let sessionLabel = '';     // the session label shown in diff-sub, before any baseRef suffix
let diffMode = 'working-tree'; // 'working-tree' (uncommitted only) or 'branch' (vs origin/branch)
// 'inline' (one unified column) or 'split' (old | new side by side). Unlike diffMode
// — a scope choice that resets to Uncommitted on every fresh open — this is a viewing
// preference, so it's persisted globally alongside cm-diff-filelist-w and the theme
// keys and survives both a panel switch and a reload.
const LAYOUT_KEY = 'cm-diff-layout';
let diffLayout = localStorage.getItem(LAYOUT_KEY) === 'split' ? 'split' : 'inline';
let prLinks = [];
let selectedPr = null;
let pollTimer = null;
let hideTimer = null;
let lastDiff = null;       // the last APPLIED `diff` reply, for in-place re-render
let activeFileRow = null;  // the fullscreen file nav's current pick — a click sets it
                            // directly (see scrollToFile); a re-render must REAPPLY it
                            // rather than recompute, or every poll would silently drop
                            // back to the geometry scan and undo the click
let pendingDiff = null;    // a fresh diff that arrived while an editor was open (Fix A)
let drafts = {};           // review drafts keyed by file|side|startLine|endLine
let activeKey = null;      // the span whose comment box is open (pauses polling)
let sending = false;       // a diff-comments submit is in flight
let sendError = null;      // last submit failure, surfaced inline for retry
let persistError = null;   // last localStorage persist failure, surfaced inline
let reqSeq = 0;            // monotonic stamp on each view-diff request
let lastReqId = 0;         // highest request id sent, for stale-reply drop (Fix B)
let inFlight = false;      // a view-diff request is outstanding (poll skips while set)
let inFlightTimer = null;  // defensive clear so a lost reply can't wedge polling
let submitTimer = null;    // bounds a diff-comments submit (Fix C)
let submitSid = null;      // the session a still-outstanding submit belongs to
let submitSourceKey = null;// localStorage draft key submitted with the outstanding send
let submitLegacyKey = null;// legacy localStorage draft key claimed by the outstanding send
let draftsLoadedFromLegacyKey = null;
let lastPrRequestAtByKey = new Map(); // PR diffs shell out to gh; refresh them less aggressively
let dragAnchor = null;     // {file,side,line} where a click-drag range select started
let dragCurrentLine = null;// last in-range line the drag extended to (same file/side)
let dragging = false;      // real movement happened → a drag, not a plain click
let dragSelecting = false;  // a drag gesture is live (mousedown → mouseup)
let dragStartX = 0, dragStartY = 0; // pointer origin, to tell a jittery click from a drag
const DRAG_THRESHOLD_PX = 4; // movement under this (still on the anchor line) is a click
const FILE_SCROLL_GAP_PX = 16; // matches .diff-body's own padding, so scrollToFile leaves
                                // the same breathing room above the target that organic
                                // scrolling shows between cards, instead of a flush edge

function reducedMotion() {
  return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function isDiffPanelOpen() { return openSid !== null; }

// The session the panel is currently showing (null when closed). Lets app.js
// couple the panel to the session: close it on session-close, or when the board
// selection moves to a *different* session (the diff is a supporting view of one
// session's terminal, so a stale diff shouldn't linger over another).
export function diffPanelSessionId() { return openSid; }

// Menu / shortcut entry point. Opens the panel for a session (switching if it was
// showing a different one) and kicks off the first diff request. Idempotent for
// the same session — a re-request just refreshes.
export function openDiffPanel(sessionId) {
  if (!sessionId) return;
  const alreadyOpenSame = openSid === sessionId;
  const switching = openSid && openSid !== sessionId;
  openSid = sessionId;
  if (switching) { cancelDrag(); resetSessionState(); clearSubmit(); }
  // Reset the mode toggle back to the default on every genuinely fresh open (a new
  // session, or reopening after a close) — but NOT on a redundant re-invoke for the
  // session already showing, which is just a refresh and shouldn't yank the user back
  // to "Uncommitted" mid-review.
  if (!alreadyOpenSame) { selectedPr = null; applyMode('working-tree'); }
  loadDrafts();
  // Don't reset `sending` on a re-open of the SAME session while a submit is still
  // genuinely outstanding — otherwise the reopened panel would re-enable Send and
  // allow a duplicate delivery before the first result lands (Fix C). A switch above
  // already settled any old-session submit via clearSubmit.
  if (!(sending && submitSid === sessionId)) sending = false;
  sendError = null; persistError = null; activeKey = null;
  pendingDiff = null; inFlight = false; clearTimeout(inFlightTimer);
  const s = latestSessions.find((x) => x.sessionId === sessionId);
  sessionLabel = s ? s.label : sessionId;
  prLinks = diffPrLinks(s, taskForSession(sessionId));
  renderPrModeButtons();
  applyMode(diffMode);
  updateSubText();
  showPanel();
  updateSendBtn();
  lastDiff = null;
  renderLoading();
  requestDiff();
  startPolling();
}

// Ctrl+Cmd+D: a toggle — close if already showing this session, else open.
export function toggleDiffPanel(sessionId) {
  if (openSid && openSid === sessionId) { closeDiffPanel(); return; }
  openDiffPanel(sessionId);
}

export function closeDiffPanel() {
  if (openSid === null) return;
  openSid = null;
  stopPolling();
  cancelDrag();
  activeKey = null;
  pendingDiff = null;
  inFlight = false; clearTimeout(inFlightTimer);
  // NOTE: an outstanding diff-comments submit is deliberately NOT cancelled here —
  // its bounded timeout still settles it, and a re-open of the same session keeps
  // Send disabled until it does, so closing then reopening can't double-submit.
  panelEl.classList.remove('open');
  panelEl.setAttribute('aria-hidden', 'true');
  // Let the slide-out play, then fully hide + un-hide the board behind it. A
  // re-open (openDiffPanel → showPanel) cancels this so the two can't race.
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    panelEl.hidden = true;
    document.querySelector('main').classList.remove('diffing');
    // Drop fullscreen together with the panel itself, at the end of the slide-out,
    // so #sidebar reappears at the same moment the diff view actually disappears
    // rather than mid-animation.
    if (diffFullscreen) setDiffFullscreen(false);
    // #grid is measurable again only now the `diffing` class is gone. Its column count
    // is width-derived, so re-render at real dimensions rather than leaving the board
    // collapsed to one column until the next ~4s poll.
    renderGridIfVisible();
  }, reducedMotion() ? 0 : 220);
}

// The diff panel's own fullscreen: hides #sidebar so the diff fills the whole
// content area (mirrors the terminal's main.maximized, in the other direction).
// Mutually exclusive with it — entering this always drops the terminal's
// maximize so the two states can't both hide each other's surface at once.
export function setDiffFullscreen(on) {
  if (diffFullscreen === on) return;
  diffFullscreen = on;
  document.querySelector('main').classList.toggle('diff-fullscreen', on);
  fullscreenBtn.innerHTML = on ? MINIMIZE_ICON : MAXIMIZE_ICON;
  fullscreenBtn.title = on ? 'Restore' : 'Fullscreen';
  fullscreenBtn.classList.toggle('active', on);
  if (on) setMaximized(false);
}

function showPanel() {
  clearTimeout(hideTimer);
  document.querySelector('main').classList.add('diffing');
  panelEl.hidden = false;
  panelEl.setAttribute('aria-hidden', 'false');
  // Force a reflow so the .open transform transitions from the hidden state
  // rather than snapping — same trick the theme editor uses.
  void panelEl.offsetWidth;
  panelEl.classList.add('open');
}

function resetSessionState() {
  drafts = {};
  pendingDiff = null;
}

// Settle an outstanding diff-comments submit (used when switching sessions): cancel
// its timeout and clear the sending flag so the new session starts clean. The old
// session's diff-comments-result, if it still arrives, is ignored (sessionId gate).
function clearSubmit() {
  clearTimeout(submitTimer);
  sending = false;
  submitSid = null;
  submitSourceKey = null;
  submitLegacyKey = null;
}

function loadDrafts() {
  try {
    const { primary, legacy } = draftKeysForCurrentSource();
    let raw = localStorage.getItem(primary);
    const fromLegacy = raw == null && legacy && localStorage.getItem(legacy) != null;
    if (fromLegacy) raw = localStorage.getItem(legacy);
    drafts = parseDrafts(raw);
    draftsLoadedFromLegacyKey = fromLegacy ? legacy : null;
    if (fromLegacy && Object.keys(drafts).length) {
      try {
        localStorage.setItem(primary, JSON.stringify(drafts));
      } catch {
        persistError = 'Comments kept in memory but could not be saved — a reload may lose them.';
      }
    }
  } catch { drafts = {}; draftsLoadedFromLegacyKey = null; }
}

function persistDrafts() {
  try {
    const { primary, legacy } = draftKeysForCurrentSource();
    if (Object.keys(drafts).length === 0) localStorage.removeItem(primary);
    else localStorage.setItem(primary, JSON.stringify(drafts));
    if (legacy && draftsLoadedFromLegacyKey === legacy) localStorage.removeItem(legacy);
    draftsLoadedFromLegacyKey = null;
    persistError = null;
  } catch {
    // localStorage quota exceeded (or a disabled store): the drafts still live in
    // memory for this open session, but a reload would silently lose them — so tell
    // the user rather than pretending the save succeeded.
    persistError = 'Comments kept in memory but could not be saved — a reload may lose them.';
  }
}

// Stamp a monotonic request id, mark a request outstanding, and arm a defensive
// timer so a lost reply can't wedge the in-flight guard forever. Called directly on
// open/switch/mode-change (bypasses the poll's in-flight gate — those must always go).
function requestDiff() {
  if (!openSid) return;
  refreshPrLinks();
  reqSeq += 1;
  lastReqId = reqSeq;
  inFlight = true;
  clearTimeout(inFlightTimer);
  inFlightTimer = setTimeout(() => { inFlight = false; }, INFLIGHT_TIMEOUT_MS);
  const msg = { type: 'view-diff', sessionId: openSid, reqId: reqSeq, mode: diffMode };
  if (diffMode === 'pr' && selectedPr) {
    msg.prUrl = selectedPr.url;
    lastPrRequestAtByKey.set(prRequestKey(), Date.now());
  }
  send(msg);
}

// Set the diff-titles sub line: the session label, plus the resolved base ref (once
// known from a reply) when in branch mode — so it's clear what "Full branch" is
// actually comparing against (the literal "origin/branch" the issue asked for isn't
// always what's resolved — see resolveBranchBase's fallbacks server-side).
function updateSubText() {
  const baseRef = diffMode === 'branch' ? lastDiff?.baseRef : null;
  const prText = diffMode === 'pr' && selectedPr
    ? `${selectedPr.repo || 'linked PR'} #${selectedPr.number || ''}`.trim()
    : null;
  subEl.textContent = baseRef ? `${sessionLabel} · vs ${baseRef}` : prText ? `${sessionLabel} · ${prText}` : sessionLabel;
}

// Toggle the mode buttons' visual state and the tracked mode, without side effects
// (no request, no re-render) — used by openDiffPanel to reset the default silently
// before the panel's own requestDiff/renderLoading calls run.
function applyMode(mode) {
  diffMode = mode;
  modeWtBtn.classList.toggle('on', mode === 'working-tree');
  modeBranchBtn.classList.toggle('on', mode === 'branch');
  for (const btn of modePrsEl.querySelectorAll('.diff-mode-btn')) {
    btn.classList.toggle('on', mode === 'pr' && btn.dataset.prUrl === selectedPr?.url);
  }
}

// Toggle the layout buttons' visual state and the tracked layout, without side
// effects — the mirror of applyMode, used to reflect the persisted preference at
// startup before anything is rendered.
function applyLayout(layout) {
  diffLayout = layout;
  layoutInlineBtn.classList.toggle('on', layout === 'inline');
  layoutSplitBtn.classList.toggle('on', layout === 'split');
  bodyEl.classList.toggle('diff-split', layout === 'split');
}
applyLayout(diffLayout);

// User-initiated layout switch. Same close-the-editor/cancel-the-drag preamble as
// setMode (a re-render is about to replace the body), but deliberately NO re-request:
// the diff data is identical, only the rendering changes.
function setLayout(layout) {
  if (layout === diffLayout) return;
  cancelDrag();
  applyLayout(layout);
  localStorage.setItem(LAYOUT_KEY, layout);
  // closeEditor re-renders on its own (and applies any diff stashed while the box was
  // open), so let it do the one render rather than paying for two.
  if (activeKey) closeEditor(); else renderDiff();
}

// User-initiated mode switch: close any open editor/drag first (a re-render is about
// to replace the body), apply the new mode, and immediately re-request — same
// bypass-the-in-flight-gate treatment as the initial open, since the user is waiting
// on this specific change.
function setMode(mode) {
  if (mode === diffMode || !openSid) return;
  if (activeKey) closeEditor();
  cancelDrag();
  applyMode(mode);
  loadDrafts();
  updateSendBtn();
  updateSubText();
  lastDiff = null;
  pendingDiff = null;
  renderLoading();
  requestDiff();
}

function setPrMode(url) {
  const pr = prLinks.find((l) => l.url === url);
  if (!pr || (diffMode === 'pr' && selectedPr?.url === url) || !openSid) return;
  if (activeKey) closeEditor();
  cancelDrag();
  selectedPr = pr;
  applyMode('pr');
  loadDrafts();
  updateSendBtn();
  updateSubText();
  lastDiff = null;
  pendingDiff = null;
  renderLoading();
  requestDiff();
}

function prDraftKey(pr = selectedPr) {
  if (!pr) return null;
  return pr.repo && pr.number ? `${pr.repo}#${pr.number}` : pr.url;
}

function draftKeysForCurrentSource() {
  return draftStorageKeysForSource(openSid, diffMode, diffMode === 'pr' ? prDraftKey() : null);
}

function prRequestKey() {
  return `${openSid}:${selectedPr?.url || ''}`;
}

function refreshPrLinks() {
  const s = latestSessions.find((x) => x.sessionId === openSid);
  const nextLinks = diffPrLinks(s, taskForSession(openSid));
  const changed = JSON.stringify(nextLinks) !== JSON.stringify(prLinks);
  prLinks = nextLinks;
  const stillLinked = diffMode === 'pr' && selectedPr
    ? prLinks.find((l) => prDraftKey(l) === prDraftKey(selectedPr))
    : null;
  if (diffMode === 'pr' && selectedPr && !stillLinked) {
    selectedPr = null;
    applyMode('working-tree');
    loadDrafts();
    updateSendBtn();
    updateSubText();
    renderPrModeButtons();
    lastDiff = null;
    pendingDiff = null;
    renderLoading();
    toast('Linked PR removed; showing uncommitted diff');
    return;
  }
  if (stillLinked) selectedPr = stillLinked;
  if (changed) {
    renderPrModeButtons();
    applyMode(diffMode);
  }
}

function renderPrModeButtons() {
  modePrsEl.replaceChildren();
  for (const pr of prLinks) {
    const btn = document.createElement('button');
    btn.className = 'diff-mode-btn';
    btn.type = 'button';
    btn.dataset.prUrl = pr.url;
    btn.textContent = pr.label;
    btn.title = pr.repo ? `${pr.repo} pull request` : 'Linked pull request';
    btn.classList.toggle('on', diffMode === 'pr' && pr.url === selectedPr?.url);
    btn.addEventListener('click', () => setPrMode(pr.url));
    modePrsEl.append(btn);
  }
}

// Poll for a fresh diff while open, but skip the tick while a comment box is being
// edited (activeKey) so the diff can't shift under the user mid-comment, and skip
// while a previous view-diff is still outstanding (inFlight) so a slow repo can't
// stack overlapping server pipelines. Resumes as soon as the box closes / the reply
// lands (or the defensive timeout clears inFlight).
function startPolling() {
  stopPolling();
  pollTimer = setInterval(() => {
    if (!openSid || activeKey || inFlight || dragSelecting) return;
    if (diffMode === 'pr' && Date.now() - (lastPrRequestAtByKey.get(prRequestKey()) || 0) < PR_REFRESH_MS) return;
    requestDiff();
  }, REFRESH_MS);
}
function stopPolling() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

// Whether a comment editor is currently open — the JS flag OR a live editor node in
// the DOM (belt-and-braces so a diff re-render can never orphan the flag).
function editorOpen() {
  return shouldDeferDiffRender(activeKey, bodyEl.querySelector('.diff-editor'));
}

// --- ws replies (routed from app.js) ---

export function onDiff(msg) {
  if (msg.sessionId !== openSid) return; // a stale reply for a since-closed/switched panel
  // A reply for THIS session settles the in-flight guard regardless of ordering, so
  // even a stale/out-of-order reply un-blocks the next poll (never wedged).
  inFlight = false;
  clearTimeout(inFlightTimer);
  // Drop a slow older pipeline that landed after a newer poll — applying it would
  // flash the diff backwards over the newer content (Fix B).
  if (isStaleReply(msg.reqId, lastReqId)) return;
  // While a comment editor is open, DON'T re-render — replaceChildren would destroy
  // the open box (losing the user's typed text) and wedge polling. A drag-select in
  // progress defers too: replacing the rows mid-drag would drop the anchor row and the
  // live `.drag-selecting` paint. Stash the latest payload; closeEditor / drag-end
  // applies it once the gesture finishes (Fix A).
  if (editorOpen() || dragSelecting) { pendingDiff = msg; return; }
  lastDiff = msg;
  renderDiff();
}

export function onDiffCommentsResult(msg) {
  if (msg.sessionId !== openSid) return;
  clearTimeout(submitTimer); // the result arrived — cancel the bounded fallback (Fix C)
  sending = false;
  submitSid = null;
  if (msg.ok) {
    const currentKey = draftKeysForCurrentSource().primary;
    const { removeKey, clearCurrent } = clearSubmittedDraftSource({ currentKey, submittedKey: submitSourceKey });
    try { if (removeKey) localStorage.removeItem(removeKey); } catch {}
    try { if (submitLegacyKey) localStorage.removeItem(submitLegacyKey); } catch {}
    if (clearCurrent) {
      drafts = {};
      persistDrafts();
    }
    sendError = null;
    toast('Review comments sent to the agent');
  } else {
    // Keep the drafts so the user can retry; surface the error inline.
    sendError = msg.error || 'Send failed.';
  }
  submitSourceKey = null;
  submitLegacyKey = null;
  updateSendBtn();
  renderDiff();
}

// --- rendering ---

function renderLoading() {
  bodyEl.replaceChildren(noticeEl('Loading diff…'));
  filelistEl.replaceChildren();
}

// Build the whole panel body as detached DOM (all diff/comment/error strings enter
// via textContent in diff-dom.js — NEVER innerHTML — so agent-generated file
// content can't inject markup), then swap it in atomically.
function renderDiff() {
  if (!lastDiff) { renderLoading(); return; }
  updateSubText(); // lastDiff.baseRef is only known once a branch-mode reply lands
  const prevScroll = bodyEl.scrollTop; // preserve scroll across an in-place refresh
  const frag = document.createDocumentFragment();
  if (sendError) frag.append(noticeEl(`Couldn't send comments: ${sendError}`, 'diff-notice-error'));
  if (persistError) frag.append(noticeEl(persistError, 'diff-notice-error'));
  // Server only sets lastDiff.cwd when it fell back off the launch folder (which
  // wasn't a repo) to wherever the transcript last recorded the agent cd'ing to —
  // flag it so a diff from an unexpected folder doesn't read as the wrong session.
  if (lastDiff.cwd) {
    const folder = lastDiff.cwd.split('/').filter(Boolean).pop() || lastDiff.cwd;
    frag.append(noticeEl(`Showing the diff from ${folder} — this session moved there mid-conversation, away from its launch folder.`));
  }

  // Drafts whose span is gone from the current diff would render nowhere yet still
  // count/send — surface them in a dedicated, editable/deletable section at the top
  // (Fix D). Attached drafts still render inline under their span via lineEl.
  const { attached, detached } = partitionDrafts(drafts, diffLineKeys(lastDiff));
  if (Object.keys(detached).length) frag.append(detachedSectionEl(detached));

  // Highlight every line of an attached MULTI-line comment's span, so a range comment
  // reads as a highlighted block (single-line comments keep today's look — no row
  // tint). The in-progress selection is highlighted manually by openEditor, since a
  // render is deferred while its editor is open.
  const selectedKeys = new Set();
  for (const d of Object.values(attached)) {
    const start = d.startLine ?? d.line;
    const end = d.endLine ?? d.line;
    if (start != null && end != null && start !== end) {
      for (const k of draftSpanKeys(d)) selectedKeys.add(k);
    }
  }

  const st = lastDiff.state;
  if (st === 'not-a-repo') {
    frag.append(noticeEl("This session's folder isn't a git repository."));
  } else if (st === 'empty') {
    if (diffMode === 'pr' && lastDiff.prNumber) frag.append(noticeEl(`No changes in PR #${lastDiff.prNumber}.`));
    else frag.append(noticeEl(lastDiff.baseRef ? `No differences from ${lastDiff.baseRef}.` : 'No uncommitted changes.'));
  } else if (st === 'no-remote') {
    const msg = lastDiff.reason === 'no-head'
      ? 'No commits yet — nothing to compare against a remote branch.'
      : 'No remote branch to compare against — push this branch (or its default branch) to a remote first.';
    frag.append(noticeEl(msg));
  } else if (st === 'error') {
    frag.append(noticeEl(lastDiff.error || 'Failed to read the diff.', 'diff-notice-error'));
  } else if (st === 'ok') {
    // Same order fileListEl renders the nav in (orderFilesForDisplay), not the
    // raw git-diff order — otherwise scrolling the body moves through the nav
    // non-monotonically (the nav groups by folder; raw order is a flat
    // alphabetical sort, so e.g. a root file sorts first in one, last in the
    // other) and the active marker looks like it's jumping around.
    for (const f of orderFilesForDisplay(lastDiff.files || [])) {
      const section = document.createElement('section');
      section.className = 'diff-file';
      section.dataset.file = f.path;
      section.append(fileHeaderEl(f));
      if (f.binary) {
        section.append(binaryEl());
      } else {
        for (const h of f.hunks || []) {
          section.append(hunkHeadEl(h.header));
          if (diffLayout === 'split') {
            for (const pair of pairHunkLines(h.lines)) section.append(pairRowEl(f.path, pair, drafts, selectedKeys));
          } else {
            for (const ln of h.lines || []) section.append(lineEl(f.path, ln, drafts, selectedKeys));
          }
        }
      }
      frag.append(section);
    }
    const dropped = lastDiff.truncated?.droppedLines || 0;
    const droppedFiles = lastDiff.truncated?.droppedFiles || 0;
    // droppedFiles counts untracked files skipped once the line budget was spent —
    // their lines were never read, so they're a separate tally from droppedLines.
    if (dropped > 0 || droppedFiles > 0) {
      const parts = [];
      if (dropped > 0) parts.push(`${dropped} more line${dropped === 1 ? '' : 's'}`);
      if (droppedFiles > 0) parts.push(`${droppedFiles} more file${droppedFiles === 1 ? '' : 's'}`);
      frag.append(noticeEl(`Diff truncated — ${parts.join(' and ')} not shown.`, 'diff-truncated'));
    }
  }
  bodyEl.replaceChildren(frag);
  bodyEl.scrollTop = prevScroll;
  if (st === 'ok') filelistEl.replaceChildren(fileListEl(lastDiff.files || []));
  else filelistEl.replaceChildren();
  reapplyActiveFileRow();
}

// --- fullscreen file nav: jump-to-file + scroll-synced active row ---

// Every rendered file section, keyed by path — excludes the detached-comments
// pseudo-section (diff-detached), which carries no dataset.file.
function fileSections() {
  return bodyEl.querySelectorAll('.diff-file:not(.diff-detached)');
}

// Setting bodyEl.scrollTop below fires its own native 'scroll' event (async,
// shortly after) which would otherwise re-run updateActiveFileHighlight()'s
// geometry scan and can revert the highlight we're about to set directly —
// e.g. a trailing file too close to the diff's end to ever satisfy the scan's
// threshold (clamped max scroll), no matter how that threshold is tuned. This
// window suppresses exactly that follow-on scroll event; a genuine further
// scroll by the user past it is unaffected. 150ms is generous slack past a
// single synchronous scrollTop set's resulting event, not a perceptible delay.
let programmaticScrollUntil = 0;
const PROGRAMMATIC_SCROLL_SUPPRESS_MS = 150;

function scrollToFile(file) {
  for (const section of fileSections()) {
    if (section.dataset.file !== file) continue;
    // An instant jump (no 'smooth', no scrollIntoView) — computed directly so the
    // target lands FILE_SCROLL_GAP_PX below the viewport's top edge, matching the
    // gap organic scrolling shows between cards, rather than flush against it.
    // Setting scrollTop is synchronous, so there's no in-flight animation for a
    // poll's DOM rebuild to freeze partway either.
    const delta = section.getBoundingClientRect().top - bodyEl.getBoundingClientRect().top - FILE_SCROLL_GAP_PX;
    programmaticScrollUntil = Date.now() + PROGRAMMATIC_SCROLL_SUPPRESS_MS;
    bodyEl.scrollTop += delta;
    // Set directly rather than deferring to updateActiveFileHighlight()'s geometry
    // scan: a short trailing file often can't be scrolled far enough for its own
    // top to reach the container's top (nothing below it to push it there), and
    // when the whole diff already fits in the viewport the jump is a no-op — the
    // clicked file is unambiguously what the user means regardless of either.
    activeFileRow = file;
    setActiveFileRow(file);
    flashFileHead(section);
    return;
  }
}

// Brief background pulse on the target's header, so a click reads as "landed
// here" even when the jump itself is a zero/near-zero-distance no-op (a short
// file, or one already on screen). Remove-then-reflow-then-add restarts the
// CSS animation even if the same file is clicked again mid-flash; the
// animationend listener cleans the class back up once it settles.
function flashFileHead(section) {
  if (reducedMotion()) return;
  const head = section.querySelector('.diff-file-head');
  if (!head) return;
  head.classList.remove('diff-flash');
  void head.offsetWidth;
  head.classList.add('diff-flash');
  head.addEventListener('animationend', () => head.classList.remove('diff-flash'), { once: true });
}

function setActiveFileRow(file) {
  for (const row of filelistEl.querySelectorAll('.diff-filelist-row')) {
    row.classList.toggle('active', row.dataset.file === file);
  }
}

// A poll rebuilds the filelist's DOM from scratch (replaceChildren), which wipes
// any .active class outright — reapply whatever's currently pinned rather than
// recomputing it via geometry, or every poll would silently drop a click back to
// wherever the scan lands (see updateActiveFileHighlight's own caveats) and undo
// it. Only falls through to the scan when there's nothing to reapply (first
// render) or that file dropped out of the diff.
function reapplyActiveFileRow() {
  const stillPresent = activeFileRow && [...fileSections()].some((s) => s.dataset.file === activeFileRow);
  if (stillPresent) setActiveFileRow(activeFileRow);
  else updateActiveFileHighlight();
}

// Table-of-contents highlight for ORGANIC scrolling: the topmost file section
// still at/above the scroll container's own top edge is the one "currently being
// read". Compares on-screen rects (robust regardless of offsetParent chain)
// rather than IntersectionObserver — sections are fully recreated every render
// anyway, so there's no per-render observer lifecycle to manage. A click goes
// through scrollToFile's direct assignment instead — seey its comment for why.
function updateActiveFileHighlight() {
  const sections = [...fileSections()];
  if (!sections.length) { activeFileRow = null; setActiveFileRow(null); return; }
  // Plain topmost-section scan, using the SAME resting threshold scrollToFile
  // targets (FILE_SCROLL_GAP_PX) rather than a flush 0 — otherwise the native
  // 'scroll' event that a click's own bodyEl.scrollTop assignment fires (async,
  // shortly after) runs this scan against the OLD flush threshold, doesn't
  // recognize the just-clicked file (its top now intentionally sits at the gap,
  // not flush), and reverts the highlight back to the previous file — the
  // click then looks like it silently failed until a second click "sticks"
  // (nothing left to scroll, so no reverting 'scroll' event fires after it).
  // A file near the very end of the diff can still be too short to ever scroll
  // its own top past this threshold (nothing below it to push it there) — so
  // organic scrolling alone may never highlight it, and the marker just holds
  // on the previous file once you hit max scroll. That's an accepted,
  // unsurprising scrollspy limitation; clicking it still works regardless.
  const containerTop = bodyEl.getBoundingClientRect().top;
  let current = sections[0];
  for (const section of sections) {
    if (section.getBoundingClientRect().top - containerTop <= FILE_SCROLL_GAP_PX + 1) current = section;
    else break;
  }
  activeFileRow = current.dataset.file;
  setActiveFileRow(activeFileRow);
}

bodyEl.addEventListener('scroll', () => {
  if (Date.now() < programmaticScrollUntil) return; // our own scrollToFile jump settling — see its comment
  updateActiveFileHighlight();
}, { passive: true });

filelistEl.addEventListener('click', (e) => {
  const row = e.target.closest('.diff-filelist-row');
  if (row) scrollToFile(row.dataset.file);
});

// Drag-to-resize the file nav's width — same pattern as the board's own
// #drag-handle (initSidebarResize in app.js): a persisted inline width, dragging
// tracked with a boolean + a body-wide cursor/no-select class.
(function initFilelistResize() {
  const handle = document.getElementById('diff-filelist-handle');
  const saved = localStorage.getItem('cm-diff-filelist-w');
  if (saved) filelistEl.style.width = saved;
  let dragging = false;
  handle.addEventListener('mousedown', (e) => {
    dragging = true;
    handle.classList.add('dragging');
    document.body.classList.add('dragging');
    e.preventDefault();
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const left = panelEl.getBoundingClientRect().left;
    const w = Math.min(panelEl.clientWidth - 300, Math.max(160, e.clientX - left));
    filelistEl.style.width = `${w}px`;
  });
  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove('dragging');
    document.body.classList.remove('dragging');
    localStorage.setItem('cm-diff-filelist-w', filelistEl.style.width);
  });
})();

// --- inline comment editing ---

// The diff-line row for a given (file, side, line), or null if that line isn't in the
// current render (a detached draft's lines aren't). Scans by data-* since the row's
// own key is a single-line key that a range span can't reconstruct.
function findLineRow(file, side, line) {
  for (const r of bodyEl.querySelectorAll('.diff-line')) {
    if (r.dataset.file === file && r.dataset.side === side && Number(r.dataset.line) === line) return r;
  }
  return null;
}

// The element a comment box / draft block hangs off for a given line row. Inline that's
// the row itself; in the side-by-side layout the row is a cell inside a `.diff-row`
// grid container, and mounting the editor there would place it as a grid item beside
// the code instead of full-width beneath the pair — so climb to the wrapper. Same
// placement pairRowEl already gives an anchored draft, which is what keeps
// openEditor's "is my draft the next sibling?" check working in both layouts.
function mountRowFor(row) {
  return row ? (row.closest('.diff-row') ?? row) : null;
}

// Manually tint the rows of a MULTI-line selection while its editor is open — a render
// is deferred during editing (it would destroy the box), so renderDiff's own span
// highlight can't run yet. Single-line selections get no tint (preserve today's look).
// closeEditor's re-render reconciles all highlights from the saved drafts afterwards.
function highlightRange(file, side, start, end) {
  if (start === end) return;
  for (const r of bodyEl.querySelectorAll('.diff-line')) {
    if (r.dataset.file !== file || r.dataset.side !== side) continue;
    const n = Number(r.dataset.line);
    if (n >= start && n <= end) r.classList.add('selected');
  }
}

// Open (or focus) a comment box for a line span {file,side,startLine,endLine}. Snapshots
// the span's CURRENT text (every line in range on that side) into the draft so the note
// stays meaningful even if a later refresh changes or drops those lines; re-opening an
// existing draft keeps its original snapshot. Pauses polling (activeKey) so the diff
// can't shift while typing.
function openEditor(target) {
  const { file, side, startLine, endLine } = target;
  const key = draftKey(file, side, startLine, endLine);
  // One box at a time. If this span's box is already open, just refocus it; otherwise
  // close whatever else was open first.
  if (activeKey === key) { bodyEl.querySelector('.diff-editor-text')?.focus(); return; }
  if (activeKey) closeEditor();
  const existing = drafts[key];
  const snapshot = existing ? existing.snapshot : rangeSnapshot(lastDiff, file, side, startLine, endLine);
  // Anchor the editor under the LAST line of the span (or its own draft block); a
  // detached draft's lines aren't rendered, so fall back to its `.diff-draft` item.
  const anchorRow = mountRowFor(findLineRow(file, side, endLine));
  let mount = anchorRow;
  if (anchorRow) {
    // Scan the whole run of draft cards hanging off this row, not just the first: a
    // side-by-side pair can carry TWO (an old-side note and a new-side one), and
    // mounting the box on the wrapper when the match is the second would drop it
    // above the other side's card. Inline, the run is at most one — same behaviour.
    for (let n = anchorRow.nextElementSibling; n?.classList?.contains('diff-draft'); n = n.nextElementSibling) {
      if (n.dataset.key === key) { mount = n; break; }
    }
  } else {
    mount = bodyEl.querySelector(`.diff-draft[data-key="${cssEscape(key)}"]`);
  }
  if (!mount) return; // span isn't rendered anywhere (shouldn't happen) — nothing to attach to
  activeKey = key;
  const ed = editorEl(side, startLine, endLine);
  mount.after(ed);
  highlightRange(file, side, startLine, endLine);
  const ta = ed.querySelector('.diff-editor-text');
  ta.value = existing ? existing.body : '';
  ta.dataset.snapshot = snapshot;
  ta.focus();
  // Cmd/Ctrl+Enter saves (isSaveCommentKey); plain Enter falls through to the
  // textarea's default newline insert, so a comment can span multiple lines and
  // only the modifier chord submits. Escape (cancel) is handled by the panel's
  // document-level keydown so it can win over the board's other Escape handlers.
  ta.addEventListener('keydown', (e) => {
    if (isSaveCommentKey(e)) { e.preventDefault(); saveEditor(target, ta); }
  });
  ed.querySelector('.diff-editor-save').addEventListener('click', () => saveEditor(target, ta));
  ed.querySelector('.diff-editor-cancel').addEventListener('click', () => closeEditor());
}

function saveEditor(target, ta) {
  const { file, side, startLine, endLine } = target;
  const key = draftKey(file, side, startLine, endLine);
  const body = ta.value.trim();
  if (body) {
    drafts[key] = { file, side, startLine, endLine, snapshot: ta.dataset.snapshot ?? '', body };
  } else {
    delete drafts[key]; // a Save of a blank box clears any existing draft
  }
  persistDrafts();
  sendError = null;
  closeEditor(); // re-renders, reconciling span highlights from the saved drafts
  updateSendBtn();
}

function closeEditor() {
  const ed = bodyEl.querySelector('.diff-editor');
  if (ed) ed.remove();
  activeKey = null;
  // A diff reply that arrived while the box was open was stashed (Fix A) — apply it now
  // the editor is gone. Always re-render on close: it repaints the freshened diff AND
  // reconciles the `.selected` span highlights (dropping the manual in-progress tint,
  // re-applying saved multi-line drafts' tint).
  if (pendingDiff) { lastDiff = pendingDiff; pendingDiff = null; }
  renderDiff();
}

function deleteDraft(key) {
  delete drafts[key];
  persistDrafts();
  updateSendBtn();
  renderDiff();
}

function updateSendBtn() {
  const n = draftCount(drafts);
  sendBtn.textContent = `Send to agent (${n})`;
  sendBtn.hidden = n === 0;
  sendBtn.disabled = n === 0 || sending;
}

function submit() {
  const comments = buildCommentsPayload(drafts);
  if (sending || comments.length === 0 || !openSid) return;
  sending = true;
  submitSid = openSid;
  {
    const keys = draftKeysForCurrentSource();
    submitSourceKey = keys.primary;
    submitLegacyKey = draftsLoadedFromLegacyKey === keys.legacy ? keys.legacy : null;
  }
  sendError = null;
  updateSendBtn();
  // Bound the wait for diff-comments-result: if it never arrives (WS blip), un-stick
  // Send, keep the drafts, and surface an inline retry hint — the button would
  // otherwise stay disabled forever with no feedback (Fix C).
  clearTimeout(submitTimer);
  submitTimer = setTimeout(() => {
    if (!sending) return;
    sending = false;
    submitSid = null;
    submitSourceKey = null;
    submitLegacyKey = null;
    sendError = "Couldn't confirm delivery — drafts kept, try again.";
    updateSendBtn();
    renderDiff();
  }, SUBMIT_TIMEOUT_MS);
  const msg = { type: 'diff-comments', sessionId: openSid, comments, mode: diffMode };
  if (diffMode === 'pr' && selectedPr) {
    msg.prUrl = selectedPr.url;
    msg.prNumber = selectedPr.number;
    msg.prRepo = selectedPr.repo;
  }
  send(msg);
}

// --- events ---

closeBtn.addEventListener('click', () => closeDiffPanel());
fullscreenBtn.addEventListener('click', () => setDiffFullscreen(!diffFullscreen));
sendBtn.addEventListener('click', () => submit());
modeWtBtn.addEventListener('click', () => { selectedPr = null; setMode('working-tree'); });
modeBranchBtn.addEventListener('click', () => { selectedPr = null; setMode('branch'); });
layoutInlineBtn.addEventListener('click', () => setLayout('inline'));
layoutSplitBtn.addEventListener('click', () => setLayout('split'));

// Delegated clicks in the scroll body: draft edit/delete (line comments themselves
// are opened via the click-and-drag gesture below, not a click handler here).
bodyEl.addEventListener('click', (e) => {
  const edit = e.target.closest('.diff-draft-edit');
  if (edit) {
    // Re-open the draft's own span from the stored record (which carries file/side/
    // start/end) — works for an attached draft and a detached one alike, no DOM lookup
    // needed.
    const d = drafts[edit.dataset.key];
    if (d) {
      const startLine = d.startLine ?? d.line;
      const endLine = d.endLine ?? d.line;
      openEditor({ file: d.file, side: d.side, startLine, endLine });
    }
    return;
  }
  const del = e.target.closest('.diff-draft-del');
  if (del) { deleteDraft(del.dataset.key); return; }
});

// --- click-and-drag comment gesture (GitHub-style) ---
//
// The ONLY way to open a comment box: mousedown on a diff line's body/gutter anchors
// at that (file, side, line); dragging over other lines on the SAME file and side
// extends it to the inclusive range, painted live via `.drag-selecting`. On mouseup, a
// plain click (no movement) opens a single-line comment at the anchor; a real drag
// opens one range-comment editor spanning [anchor..released line]. While a drag is
// live the poll is gated and incoming diffs are deferred (see startPolling / onDiff),
// so the rows can't shift under the gesture.

// The `.diff-line` row under a pointer event, or null (over the editor, a draft card,
// the inter-file gap, or outside the panel entirely).
function dragRowFromEvent(e) {
  const t = e.target;
  return t && typeof t.closest === 'function' ? t.closest('.diff-line') : null;
}

// Paint the live range highlight on rows in [start,end] of one file/side using a
// dedicated `.drag-selecting` class — kept separate from `.selected` so it never
// clobbers a saved multi-line draft's persistent highlight (reconciled by renderDiff).
function paintDragRange(file, side, start, end) {
  for (const r of bodyEl.querySelectorAll('.diff-line')) {
    const n = Number(r.dataset.line);
    const inRange = r.dataset.file === file && r.dataset.side === side && n >= start && n <= end;
    r.classList.toggle('drag-selecting', inRange);
  }
}
function clearDragPaint() {
  for (const r of bodyEl.querySelectorAll('.diff-line.drag-selecting')) r.classList.remove('drag-selecting');
}

function onDragMove(e) {
  if (!dragSelecting || !dragAnchor) return;
  const row = dragRowFromEvent(e);
  if (!row) return; // off the lines — keep the last in-range extent
  if (row.dataset.file !== dragAnchor.file || row.dataset.side !== dragAnchor.side) return; // other file/side ignored
  const line = Number(row.dataset.line);
  if (Number.isNaN(line)) return;
  dragCurrentLine = line;
  if (!dragging) {
    // Distinguish a real drag from a jittery click: promote to "dragging" only once the
    // pointer reaches a different line OR moves past a small pixel threshold, so a
    // plain click (no movement) stays a single-line comment rather than a 1-line "range".
    const moved = Math.abs(e.clientX - dragStartX) + Math.abs(e.clientY - dragStartY);
    if (line === dragAnchor.line && moved < DRAG_THRESHOLD_PX) return;
    dragging = true;
  }
  const span = dragRange(dragAnchor, { file: dragAnchor.file, side: dragAnchor.side, line });
  if (span) paintDragRange(span.file, span.side, span.startLine, span.endLine);
}

// End (or cancel) the gesture: always tear down the document listeners and the paint so
// a mouseup ANYWHERE (even outside the panel) can't leave a dangling selection. A real
// drag opens the range editor for the span; a plain click (no movement) opens a
// single-line editor at the anchor — the click and drag gestures share one path.
function onDragEnd() {
  const a = dragAnchor;
  const span = a && dragging && dragCurrentLine != null
    ? dragRange(a, { file: a.file, side: a.side, line: dragCurrentLine })
    : a && { file: a.file, side: a.side, startLine: a.line, endLine: a.line };
  cancelDrag();
  if (span) { openEditor(span); return; }
  if (pendingDiff) { lastDiff = pendingDiff; pendingDiff = null; renderDiff(); }
}

// Tear down the live gesture without opening anything — shared by onDragEnd and by
// panel close/switch so a drag interrupted by navigation leaves no listeners or paint.
function cancelDrag() {
  document.removeEventListener('mousemove', onDragMove, true);
  document.removeEventListener('mouseup', onDragEnd, true);
  bodyEl.classList.remove('drag-selecting');
  clearDragPaint();
  dragSelecting = false; dragging = false; dragAnchor = null; dragCurrentLine = null;
}

bodyEl.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return; // left-click/drag only
  // An open editor and draft cards keep their own click behaviour — a click inside
  // either must not be hijacked into starting a new comment gesture.
  if (e.target.closest('.diff-editor, .diff-draft')) return;
  const row = dragRowFromEvent(e);
  if (!row) return;
  const line = Number(row.dataset.line);
  if (Number.isNaN(line)) return;
  dragAnchor = { file: row.dataset.file, side: row.dataset.side, line };
  dragCurrentLine = line;
  dragging = false;
  dragSelecting = true;
  dragStartX = e.clientX; dragStartY = e.clientY;
  bodyEl.classList.add('drag-selecting'); // suppress native text selection while dragging
  document.addEventListener('mousemove', onDragMove, true);
  document.addEventListener('mouseup', onDragEnd, true);
});

// Escape closes the box first (so it doesn't shift the diff under you), then the
// panel; Cmd/Ctrl+Enter sends every draft to the agent — the SAME chord an open
// editor's own textarea listener uses to save just that one comment (isSaveCommentKey),
// so `activeKey` picks which: editing → save this box (handled there, not here);
// not editing → send everything. Capture-phase + stopPropagation so it wins over the
// board's other Escape/shortcut handlers while the panel is up. Inert when closed.
document.addEventListener('keydown', (e) => {
  if (openSid === null) return;
  // An open context menu or modal dialog (e.g. Ctrl+Cmd+N's dispatch dialog, opened
  // OVER an already-open diff panel) owns both chords first — same gate the board's
  // own Ctrl+Cmd+<key> family uses, so the two agree on what's "on top". Without this
  // for Escape, it closed the diff behind the dialog instead of the dialog itself, and
  // a second Escape was needed to actually dismiss it.
  if (document.querySelector('.context-menu')) return;
  if (document.querySelector('#modal:not(.hidden), [id$="-modal"]:not(.hidden)')) return;
  if (e.key === 'Escape') {
    if (activeKey) { e.preventDefault(); e.stopPropagation(); closeEditor(); return; }
    e.preventDefault(); e.stopPropagation();
    closeDiffPanel();
    return;
  }
  if (!activeKey && isSaveCommentKey(e) && draftCount(drafts) > 0) {
    e.preventDefault();
    submit();
  }
}, true);

// CSS.escape isn't guaranteed everywhere the app runs; our keys are file|side|start|end
// so only the file path can carry awkward chars — escape the attribute-selector
// specials defensively.
function cssEscape(s) {
  return (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/["\\\]]/g, '\\$&');
}
