// The checklist's client half, served at /ext/checklist/index.js and loaded by
// public/extensions.js. It contributes two things to the board's slots
// (public/slots.js): the panel itself into `panel.section` (the #checklist strip
// between #panel and the terminal), and its COLLAPSED form — a disclosure chip —
// into `panel.metaChip`. Both read the same module state, so toggling the chip
// re-renders the panel directly, with no round trip through app.js.
//
// Icons come from the board's own module by ABSOLUTE URL: this file is served
// from /ext/checklist/, so a relative './icons.js' would resolve under that
// prefix and 404. Same-origin ESM, so the absolute import is fine.
import { CHECK_ICON, PLUS_ICON, MINUS_ICON } from '/icons.js';
import {
  createChecklistDom, checklistCountLabel, checklistPillLabel, isPendingChecklistId,
  isChecklistOpen, toggleChecklistOpen, parseChecklistOpen, serializeChecklistOpen,
} from './checklist-dom.js';

// A session-scoped list written by BOTH the human (this panel) and the launched
// agent (its four MCP tools) — deliberately not the task-level TODO list (that
// one is task-scoped and human-only) and not a mirror of the agent's own private
// planning tool. Rows are patched in place by checklist-dom.js rather than
// rebuilt from a string, so the ~4s graph poll can't reset the list's scroll.
const checklistDom = createChecklistDom({ document });
let api = null;
// The session the panel currently shows and the whole-store snapshot off the
// latest graph — both set by update(). `latestChecklists` is the graph's own
// object, not a copy: the optimistic mutations below write straight into it,
// so a re-render off the same graph (a chip toggle) keeps them.
let sessionId = null;
let latestChecklists = {};
// Two freeze flags, both load-bearing: a poll tick landing mid-gesture would
// otherwise reorder rows out from under the cursor, or replace the very input
// someone is typing into. Optimistic local mutation (below) is what keeps the
// panel honest in the meantime — the server echo is up to a poll away.
let checklistDragActive = false;
let checklistDragRow = null;
let checklistEditing = false;
// The two mounted elements (null while their host has not rendered).
let panelEl = null;
let pillEl = null;

// Collapsed/expanded is per session and persisted per browser, exactly like the
// panel's sub-agents zone (app.js panelSubagentShownOverrides) — collapsing one
// session's checklist must not touch another's, and the choice has to survive a
// reload. Default collapsed; see isChecklistOpen for why there's no server-side
// default to fall back to. Kept under its RAW pre-extensions key via
// storage.raw() so the move into an extension loses nobody's stored state.
const CHECKLIST_OPEN_KEY = 'wrangler.checklistOpen';
let checklistOpenOverrides = new Map();
function checklistOpen(sid) {
  return isChecklistOpen(checklistOpenOverrides, sid);
}
function toggleChecklist(sid) {
  toggleChecklistOpen(checklistOpenOverrides, sid);
  api.storage.raw(CHECKLIST_OPEN_KEY).set(serializeChecklistOpen(checklistOpenOverrides));
}

// The live array for a session (not a copy) — the optimistic mutations below
// write straight into it, exactly like the todo flow writes into latestTasks.
function checklistFor(sid) {
  return latestChecklists[sid] || [];
}

function render() {
  const items = sessionId ? checklistFor(sessionId) : [];
  const open = Boolean(sessionId) && checklistOpen(sessionId);
  // The chip first: an optimistic local edit must move its count immediately,
  // and the chip is only on screen while the panel is shut, i.e. exactly when
  // the panel half below returns early.
  if (pillEl) {
    const btn = pillEl.querySelector('.checklist-pill');
    btn.classList.toggle('showing', open);
    btn.setAttribute('aria-expanded', String(open));
    btn.setAttribute('title', `${open ? 'Hide' : 'Show'} checklist`);
    btn.querySelector('.ck-pill-n').textContent = checklistPillLabel(items);
    btn.querySelector('.subagent-toggle-icon').innerHTML = open ? MINUS_ICON : PLUS_ICON;
  }
  if (!panelEl) return;
  const el = panelEl.querySelector('#checklist');
  // Collapsed is the whole panel gone, not a shrunken one: the collapsed form is
  // that chip in #panel's own meta row, which costs the terminal no height at
  // all. Nothing selected hides it too.
  if (!open) { el.hidden = true; return; }
  el.hidden = false;
  el.querySelector('.ck-count').textContent = checklistCountLabel(items);
  if (checklistDragActive || checklistEditing) return;
  const list = el.querySelector('.ck-list');
  checklistDom.patch(list, { sessionId, items });
  syncChecklistScrollHint(el, list);
}

// The list is height-capped, so a long checklist clips its last visible row —
// with no cue, that reads as a rendering glitch rather than "more below". Marks
// the panel while there is content further down (and only then, so the hint
// never sits over the last row once you have reached the bottom).
function syncChecklistScrollHint(el, list) {
  const more = list.scrollHeight - list.clientHeight - list.scrollTop > 2;
  el.classList.toggle('ck-more-below', more);
}

// Belt-and-braces alongside the `pending` class the patch puts on such a row
// (its controls are inert in CSS): a click that somehow lands must not send an
// id the server has never heard of. See isPendingChecklistId.
function toggleChecklistItem(itemId) {
  const sid = sessionId;
  if (isPendingChecklistId(itemId)) return;
  const item = checklistFor(sid).find((i) => i.id === itemId);
  if (!item) return;
  const done = !item.done;
  api.send({ type: 'checklist-update', sessionId: sid, itemId, done });
  item.done = done;
  render();
}

function deleteChecklistItem(itemId) {
  const sid = sessionId;
  if (isPendingChecklistId(itemId)) return;
  api.send({ type: 'checklist-remove', sessionId: sid, itemId });
  latestChecklists[sid] = checklistFor(sid).filter((i) => i.id !== itemId);
  render();
}

// Inline add: an input appended as the last row. Enter/blur commits, Escape
// cancels — same contract as the todo zone's inline add.
function beginChecklistAdd(el) {
  const sid = sessionId;
  if (!sid || checklistEditing || el.hidden) return;
  const list = el.querySelector('.ck-list');
  const holder = document.createElement('div');
  holder.className = 'ck-row ck-editing';
  const input = document.createElement('input');
  input.className = 'ck-input';
  input.placeholder = 'New checklist item…';
  input.setAttribute('aria-label', 'New checklist item');
  holder.appendChild(input);
  list.appendChild(holder);
  checklistEditing = true;
  input.focus();
  let settled = false;
  const finish = (save) => {
    if (settled) return;
    settled = true;
    checklistEditing = false;
    const text = input.value.trim();
    if (holder.parentNode) holder.parentNode.removeChild(holder);
    if (save && text) {
      api.send({ type: 'checklist-add', sessionId: sid, text });
      // Optimistic: a tmp id the next graph replaces with the server's real one.
      latestChecklists[sid] = [...checklistFor(sid), { id: `tmp_${Date.now()}`, text, done: false, createdAt: Date.now() }];
    }
    render();
  };
  input.addEventListener('keydown', (e) => {
    // stopPropagation: finish() synchronously removes this input, so a bubbling
    // Enter would reach the window handler with the input already gone and the
    // isTypingTarget guard would miss it (same reason as the todo inputs).
    if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
}

// Click-to-edit one item's text. The input replaces the span's text node rather
// than the span itself, so the row element (and its drag handle) survives.
function beginChecklistEdit(row) {
  const sid = sessionId;
  if (checklistEditing || isPendingChecklistId(row.dataset.ckid)) return;
  const span = row.querySelector('.ck-text');
  const itemId = row.dataset.ckid;
  const current = span.textContent;
  const input = document.createElement('input');
  input.className = 'ck-input';
  input.value = current;
  input.setAttribute('aria-label', `Edit checklist item: ${current}`);
  span.textContent = '';
  span.appendChild(input);
  checklistEditing = true;
  input.focus();
  input.select();
  let settled = false;
  const finish = (save) => {
    if (settled) return;
    settled = true;
    checklistEditing = false;
    const text = input.value.trim();
    if (input.parentNode) input.parentNode.removeChild(input);
    span.textContent = current;
    if (save && text && text !== current) {
      api.send({ type: 'checklist-update', sessionId: sid, itemId, text });
      const item = checklistFor(sid).find((i) => i.id === itemId);
      if (item) item.text = text;
    }
    render();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
}

// The row the dragged one should sit BEFORE for a given cursor Y (null = the
// end). Scoped to the list's own rows, so it can never hit-test anything else in
// the sidebar.
function checklistDragBefore(list, y) {
  for (const row of list.children) {
    if (row === checklistDragRow) continue;
    const r = row.getBoundingClientRect();
    if (y < r.top + r.height / 2) return row;
  }
  return null;
}

// Idempotent: `drop` fires before `dragend`, and a drag can also end with no
// drop at all, so both call this.
function endChecklistDrag() {
  if (checklistDragRow) checklistDragRow.classList.remove('ck-dragging');
  checklistDragActive = false;
  checklistDragRow = null;
}

// The panel's static markup. No agent text goes through here — item text is
// written by checklist-dom.js via textContent only; this is the frame around it.
// `id="checklist"` is what styles.css keys the strip on (the rules stay in the
// board's stylesheet), and the `hidden` default is the collapsed state.
function mountPanel(el, a) {
  api = a;
  checklistOpenOverrides = parseChecklistOpen(api.storage.raw(CHECKLIST_OPEN_KEY).get());
  el.innerHTML = `<div id="checklist" hidden>
    <div class="ck-head">
      <span class="ck-title">Checklist</span>
      <span class="ck-count"></span>
      <button type="button" class="ck-add" title="Add a checklist item">+ Add</button>
    </div>
    <div class="ck-list"></div>
  </div>`;
  panelEl = el;
  const strip = el.querySelector('#checklist');
  const list = strip.querySelector('.ck-list');
  // One delegated listener pair on the list, wired once — rows are created and
  // destroyed by the patch, so per-row wiring would have to be redone on every
  // tick and would miss any row the patch reused.
  strip.querySelector('.ck-add').addEventListener('click', () => beginChecklistAdd(strip));
  list.addEventListener('click', (e) => {
    const row = e.target.closest('.ck-row');
    if (!row || !row.dataset.ckid) return;
    if (e.target.closest('.ck-check')) { toggleChecklistItem(row.dataset.ckid); return; }
    if (e.target.closest('.ck-del')) { deleteChecklistItem(row.dataset.ckid); return; }
    if (e.target.closest('.ck-text')) beginChecklistEdit(row);
  });
  list.addEventListener('dragstart', (e) => {
    const row = e.target.closest('.ck-row[draggable="true"]');
    if (!row) return;
    checklistDragRow = row;
    checklistDragActive = true;
    e.dataTransfer.effectAllowed = 'move';
    // A payload is required for the drag to start at all in some browsers; the
    // drop reads the resulting DOM order, not this.
    e.dataTransfer.setData('text/plain', row.dataset.ckid);
    row.classList.add('ck-dragging');
  });
  list.addEventListener('dragover', (e) => {
    if (!checklistDragActive || !checklistDragRow) return;
    e.preventDefault();
    const before = checklistDragBefore(list, e.clientY);
    if (before !== checklistDragRow) list.insertBefore(checklistDragRow, before);
  });
  list.addEventListener('drop', (e) => {
    e.preventDefault();
    if (!checklistDragActive) return;
    const sid = sessionId;
    const order = [...list.children].map((r) => r.dataset.ckid).filter(Boolean);
    // A `tmp_` id belongs to an add still in flight — the server has never heard
    // of it, so sending it would just be ignored. Filter it out rather than
    // skipping the whole round trip (skipping would let the next graph echo
    // revert the drag). Reorder appends anything it isn't told about, and an
    // optimistic item is always the last row anyway, so it lands where it was.
    api.send({ type: 'checklist-reorder', sessionId: sid, order: order.filter((id) => !isPendingChecklistId(id)) });
    // Optimistic reorder of the local snapshot, so the next patch agrees with
    // the DOM the drag already produced rather than snapping it back.
    const byId = new Map(checklistFor(sid).map((i) => [i.id, i]));
    latestChecklists[sid] = order.map((id) => byId.get(id)).filter(Boolean);
    endChecklistDrag();
    render();
  });
  list.addEventListener('dragend', endChecklistDrag);
  list.addEventListener('scroll', () => syncChecklistScrollHint(strip, list));
}

// The COLLAPSED form: a disclosure chip in #panel's meta row, styled and toggled
// exactly like the sub-agents pill beside it (icon + count + a +/- state icon,
// per-session and persisted). Shown even for an empty checklist (hence
// checklistPillLabel's "0/0"): while collapsed this chip is the only thing
// telling a human the feature exists on this session. The chips row is rebuilt
// by innerHTML on every panel render, so this mounts afresh each time — the
// click wiring here is per mount, exactly as often as it was per render before.
function mountPill(el, a) {
  api = a;
  el.innerHTML = `<button type="button" class="card-tag checklist-pill" aria-expanded="false" title="Show checklist"><span class="ck-pill-count">${CHECK_ICON}<span class="ck-pill-n"></span></span><span class="subagent-toggle-icon">${PLUS_ICON}</span></button>`;
  pillEl = el;
  el.querySelector('.checklist-pill').addEventListener('click', (e) => {
    e.stopPropagation();
    if (!sessionId) return;
    toggleChecklist(sessionId);
    render();
  });
}

function update(el, session, graph) {
  sessionId = session?.sessionId || null;
  latestChecklists = graph?.checklists || {};
  render();
}

export default {
  register(slots) {
    slots.register('panel.section', {
      id: 'checklist-panel',
      mount: mountPanel,
      update,
      unmount: () => { panelEl = null; endChecklistDrag(); checklistEditing = false; },
    });
    slots.register('panel.metaChip', {
      id: 'checklist-pill',
      mount: mountPill,
      update,
      unmount: () => { pillEl = null; },
    });
  },
};
