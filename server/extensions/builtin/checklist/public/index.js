// Client half of the builtin checklist extension: the per-session Checklist
// panel (`panel.section`) and its collapsed disclosure chip (`panel.metaChip`).
// A session-scoped list written by BOTH the human (this panel) and the launched
// agent (its four MCP tools) — deliberately not the task-level TODO list and not
// a mirror of the agent's own private planning tool. Rows are patched in place
// by checklist-dom.js rather than rebuilt from a string, so the ~4s graph poll
// can't reset the list's scroll.
//
// The loader only imports this module while the extension is enabled, so there
// is no "enabled" flag here: if this code is running, the feature is on.
import {
  createChecklistDom, checklistCountLabel, checklistPillLabel, isPendingChecklistId,
  isChecklistOpen, toggleChecklistOpen, parseChecklistOpen, serializeChecklistOpen,
  visibleChecklistItems, isChecklistShowDone, toggleChecklistShowDone,
  parseChecklistShowDone, serializeChecklistShowDone, reorderVisibleChecklistItems,
  checklistHiddenDoneLabel,
} from './checklist-dom.js';

// Inlined: an extension module cannot import the core's icons.js.
const SVG = (inner, fill = 'none') => `<svg class="icon" viewBox="0 0 24 24" fill="${fill}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
const CHECK_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
const PLUS_ICON = SVG('<path d="M5 12h14"/><path d="M12 5v14"/>');
const MINUS_ICON = SVG('<path d="M5 12h14"/>');
const FILTER_ICON = SVG('<polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/>');

// Legacy keys, read through the namespacedStorage escape hatch so existing
// users keep their per-session open / show-done choices.
const OPEN_KEY = 'wrangler.checklistOpen';
const SHOW_DONE_KEY = 'wrangler.checklistShowDone';

const SECTION_HTML = `
  <div class="ck-head">
    <span class="ck-title">Checklist</span>
    <span class="ck-count" id="ck-count"></span>
    <button type="button" class="card-tag checklist-filter" id="ck-filter" title="Show all items" aria-pressed="false">${FILTER_ICON}<span id="ck-filter-label">Open</span></button>
    <button type="button" class="ck-add" id="ck-add" title="Add a checklist item">+ Add</button>
  </div>
  <div class="ck-list" id="ck-list"></div>
  <div class="ck-empty" id="ck-empty" role="status" hidden></div>`;

export default {
  register(reg) {
    const api = reg.api;
    const dom = createChecklistDom({ document });
    const openStore = api.storage.raw(OPEN_KEY);
    const showDoneStore = api.storage.raw(SHOW_DONE_KEY);
    const openOverrides = parseChecklistOpen(openStore.get());
    const showDoneIds = parseChecklistShowDone(showDoneStore.get());

    // The latest graph's snapshot, mutated optimistically below exactly like the
    // todo flow writes into latestTasks; replaced wholesale on every update.
    let checklists = {};
    let sessionId = null;
    const sections = new Set();
    const pills = new Set();
    // Two freeze flags, both load-bearing: a poll tick landing mid-gesture would
    // otherwise reorder rows out from under the cursor, or replace the very input
    // someone is typing into.
    let dragActive = false;
    let dragRow = null;
    let unclaimDrag = null;
    let editing = false;

    const itemsFor = (sid) => checklists[sid] || [];

    function renderPills() {
      const items = sessionId ? itemsFor(sessionId) : [];
      const open = isChecklistOpen(openOverrides, sessionId);
      for (const el of pills) {
        const btn = el.querySelector('#panel-checklist-toggle');
        btn.classList.toggle('showing', open);
        btn.setAttribute('title', `${open ? 'Hide' : 'Show'} checklist`);
        btn.setAttribute('aria-expanded', String(open));
        btn.querySelector('.ck-pill-count').lastChild.textContent = checklistPillLabel(items);
        btn.querySelector('.subagent-toggle-icon').innerHTML = open ? MINUS_ICON : PLUS_ICON;
      }
    }

    function renderSection(el) {
      const root = el.firstChild;
      const items = sessionId ? itemsFor(sessionId) : [];
      // Collapsed is the whole panel gone, not a shrunken one: the collapsed form
      // is the chip in #panel's meta row, which costs the terminal no height.
      if (!sessionId || !isChecklistOpen(openOverrides, sessionId)) { root.hidden = true; return; }
      root.hidden = false;
      root.querySelector('#ck-count').textContent = checklistCountLabel(items);
      const showDone = isChecklistShowDone(showDoneIds, sessionId);
      const filter = root.querySelector('#ck-filter');
      filter.classList.toggle('showing', showDone);
      filter.setAttribute('aria-pressed', String(showDone));
      filter.setAttribute('title', showDone ? 'Show open items only' : 'Show all items');
      root.querySelector('#ck-filter-label').textContent = showDone ? 'All' : 'Open';
      const empty = root.querySelector('#ck-empty');
      const emptyLabel = checklistHiddenDoneLabel(items, { showDone });
      if (empty.textContent !== emptyLabel) empty.textContent = emptyLabel;
      empty.hidden = !emptyLabel;
      if (dragActive || editing) return;
      const list = root.querySelector('#ck-list');
      dom.patch(list, { sessionId, items: visibleChecklistItems(items, { showDone }), focusFallback: filter });
      syncScrollHint(root, list);
    }

    function renderAll() {
      renderPills();
      for (const el of sections) renderSection(el);
    }

    // The list is height-capped, so a long checklist clips its last visible row —
    // mark the panel while there is content further down.
    function syncScrollHint(root, list) {
      const more = list.scrollHeight - list.clientHeight - list.scrollTop > 2;
      root.classList.toggle('ck-more-below', more);
    }

    // Belt-and-braces alongside the `pending` class: a click on a not-yet-echoed
    // item must not send an id the server has never heard of.
    function toggleItem(itemId) {
      const sid = sessionId;
      if (isPendingChecklistId(itemId)) return;
      const item = itemsFor(sid).find((i) => i.id === itemId);
      if (!item) return;
      const done = !item.done;
      api.send({ type: 'checklist-update', sessionId: sid, itemId, done });
      item.done = done;
      renderAll();
    }

    function deleteItem(itemId) {
      const sid = sessionId;
      if (isPendingChecklistId(itemId)) return;
      api.send({ type: 'checklist-remove', sessionId: sid, itemId });
      checklists[sid] = itemsFor(sid).filter((i) => i.id !== itemId);
      renderAll();
    }

    // Inline add: an input appended as the last row. Enter/blur commits, Escape
    // cancels.
    function beginAdd(root) {
      const sid = sessionId;
      const list = root.querySelector('#ck-list');
      if (!sid || editing || root.hidden) return;
      const holder = document.createElement('div');
      holder.className = 'ck-row ck-editing';
      const input = document.createElement('input');
      input.className = 'ck-input';
      input.placeholder = 'New checklist item…';
      input.setAttribute('aria-label', 'New checklist item');
      holder.appendChild(input);
      list.appendChild(holder);
      editing = true;
      input.focus();
      let settled = false;
      const finish = (save) => {
        if (settled) return;
        settled = true;
        editing = false;
        const text = input.value.trim();
        if (holder.parentNode) holder.parentNode.removeChild(holder);
        if (save && text) {
          api.send({ type: 'checklist-add', sessionId: sid, text });
          // Optimistic: a tmp id the next graph replaces with the server's real one.
          checklists[sid] = [...itemsFor(sid), { id: `tmp_${Date.now()}`, text, done: false, createdAt: Date.now() }];
        }
        renderAll();
      };
      input.addEventListener('keydown', (e) => {
        // stopPropagation: finish() synchronously removes this input, so a
        // bubbling Enter would reach the window handler with the input gone.
        if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); finish(true); }
        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
      });
      input.addEventListener('blur', () => finish(true));
    }

    // Click-to-edit one item's text. The input replaces the span's text node
    // rather than the span itself, so the row element (and drag handle) survives.
    function beginEdit(row) {
      const sid = sessionId;
      if (editing || isPendingChecklistId(row.dataset.ckid)) return;
      const span = row.querySelector('.ck-text');
      const itemId = row.dataset.ckid;
      const current = span.textContent;
      const input = document.createElement('input');
      input.className = 'ck-input';
      input.value = current;
      input.setAttribute('aria-label', `Edit checklist item: ${current}`);
      span.textContent = '';
      span.appendChild(input);
      editing = true;
      input.focus();
      input.select();
      let settled = false;
      const finish = (save) => {
        if (settled) return;
        settled = true;
        editing = false;
        const text = input.value.trim();
        if (input.parentNode) input.parentNode.removeChild(input);
        span.textContent = current;
        if (save && text && text !== current) {
          api.send({ type: 'checklist-update', sessionId: sid, itemId, text });
          const item = itemsFor(sid).find((i) => i.id === itemId);
          if (item) item.text = text;
        }
        renderAll();
      };
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); finish(true); }
        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
      });
      input.addEventListener('blur', () => finish(true));
    }

    // The row the dragged one should sit BEFORE for a cursor Y (null = the end).
    function dragBefore(list, y) {
      for (const row of list.children) {
        if (row === dragRow) continue;
        const r = row.getBoundingClientRect();
        if (y < r.top + r.height / 2) return row;
      }
      return null;
    }

    // Idempotent: `drop` fires before `dragend`, and a drag can also end with no
    // drop at all, so both call this.
    function endDrag() {
      if (dragRow) dragRow.classList.remove('ck-dragging');
      dragActive = false;
      dragRow = null;
      if (unclaimDrag) { unclaimDrag(); unclaimDrag = null; }
    }

    // One delegated listener set on the list, wired once per mount — rows are
    // created and destroyed by the patch.
    function wire(root) {
      const list = root.querySelector('#ck-list');
      root.querySelector('#ck-add').addEventListener('click', () => beginAdd(root));
      root.querySelector('#ck-filter').addEventListener('click', () => {
        toggleChecklistShowDone(showDoneIds, sessionId);
        showDoneStore.set(serializeChecklistShowDone(showDoneIds));
        renderAll();
      });
      list.addEventListener('click', (e) => {
        const row = e.target.closest('.ck-row');
        if (!row || !row.dataset.ckid) return;
        if (e.target.closest('.ck-check')) { toggleItem(row.dataset.ckid); return; }
        if (e.target.closest('.ck-del')) { deleteItem(row.dataset.ckid); return; }
        if (e.target.closest('.ck-text')) beginEdit(row);
      });
      list.addEventListener('dragstart', (e) => {
        const row = e.target.closest('.ck-row[draggable="true"]');
        if (!row) return;
        dragRow = row;
        dragActive = true;
        // Tell the board this drag is ours, so it does not re-render under it.
        if (!unclaimDrag) unclaimDrag = api.claimDrag(list);
        e.dataTransfer.effectAllowed = 'move';
        // A payload is required for the drag to start at all in some browsers.
        e.dataTransfer.setData('text/plain', row.dataset.ckid);
        row.classList.add('ck-dragging');
      });
      list.addEventListener('dragover', (e) => {
        if (!dragActive || !dragRow) return;
        e.preventDefault();
        const before = dragBefore(list, e.clientY);
        if (before !== dragRow) list.insertBefore(dragRow, before);
      });
      list.addEventListener('drop', (e) => {
        e.preventDefault();
        if (!dragActive) return;
        const sid = sessionId;
        const visibleOrder = [...list.children].map((r) => r.dataset.ckid).filter(Boolean);
        // A `tmp_` id belongs to an add still in flight — filter it out of what
        // is sent; reorder appends anything it isn't told about.
        const reordered = reorderVisibleChecklistItems(itemsFor(sid), visibleOrder);
        const order = reordered.map((item) => item.id);
        api.send({ type: 'checklist-reorder', sessionId: sid, order: order.filter((id) => !isPendingChecklistId(id)) });
        // Optimistic reorder, so the next patch agrees with the DOM.
        checklists[sid] = reordered;
        endDrag();
        renderAll();
      });
      list.addEventListener('dragend', endDrag);
      list.addEventListener('scroll', () => syncScrollHint(root, list));
    }

    function sync(session, graph) {
      sessionId = session?.sessionId || null;
      checklists = graph?.checklists || {};
    }

    reg.register('panel.section', {
      id: 'checklist',
      mount(el) {
        const root = document.createElement('div');
        root.id = 'checklist';
        root.hidden = true;
        root.innerHTML = SECTION_HTML;
        el.appendChild(root);
        wire(root);
        sections.add(el);
      },
      update(el, session, graph) {
        sync(session, graph);
        renderSection(el);
      },
      unmount(el) {
        sections.delete(el);
        endDrag();
        editing = false;
      },
    });

    // The COLLAPSED form: a disclosure chip in the panel's meta row, styled and
    // toggled like the sub-agents pill. Shown even for an empty checklist
    // ("0/0"): while collapsed this chip is the only thing telling a human the
    // feature exists on this session.
    reg.register('panel.metaChip', {
      id: 'checklist-pill',
      mount(el) {
        el.innerHTML = `<button class="card-tag checklist-pill" id="panel-checklist-toggle" aria-expanded="false"><span class="ck-pill-count">${CHECK_ICON}0/0</span><span class="subagent-toggle-icon">${PLUS_ICON}</span></button>`;
        el.querySelector('button').addEventListener('click', (e) => {
          e.stopPropagation();
          toggleChecklistOpen(openOverrides, sessionId);
          openStore.set(serializeChecklistOpen(openOverrides));
          renderAll();
          api.requestPanelRender();
        });
        pills.add(el);
      },
      update(el, session, graph) {
        sync(session, graph);
        renderPills();
      },
      unmount(el) { pills.delete(el); },
    });

    // The module loads after the first panel render on a cold page; draw now
    // rather than waiting up to a poll tick for the pill and panel to appear.
    if (api.selectedSessionId()) api.requestPanelRender();
  },
};
