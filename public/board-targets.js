// What the board can press right now, for `api.targets` and `api.front` (1.65.0):
// every button, tab, field, session card and menu row in front, each under a key
// that names the same thing across redraws, a badge layer the board draws with
// text an extension sets, and what is in front (view, dialog, menu, session).
//
// "In front" decides the list: an open dialog takes it all, then a context menu,
// then the board's surfaces (the rail, the board or Search or an extension view,
// a session's panel and chat, the diff). A terminal's own DOM is never a target:
// the open session's Terminal is listed once, as `panel:terminal` (1.68.0), and
// pressing it focuses it.
//
// Keys come from what a redraw keeps: a session card's id, a task tile's id and
// the button's role in it, an element id, a rail view. Anything else is keyed
// by its tag, first class and data attributes inside its nearest keyed scope,
// then by its label, then by an ordinal, only as far as it takes to be unique.
//
// The DOM is injected, and the parts that decide (keyFor, uniqueKeys, frontKey,
// badgeText) are pure so they test without one.

export const CHOICE = 'input:is([type="checkbox"], [type="radio"])';
export const FIELD = 'textarea, select, input:not([type="checkbox"], [type="radio"], [type="hidden"], [type="button"], [type="submit"], [type="file"])';
export const CLICKABLE = `a[href], button, summary, [role="button"], [role="tab"], [role="link"], [role="option"], [role="radio"], [role="checkbox"], label:has(${CHOICE}, input[type="file"]), ${CHOICE}, ${FIELD}`;
// Never a target: a terminal, the badge layer, anything hidden or inert, what a
// shut <details> hides, a chart's points.
const NEVER = '.xterm, #ext-target-badges, [inert], [hidden], details:not([open]) > :not(summary), svg';
export const MODALS = '#modal, [id$="-modal"], dialog';
// The board's surfaces outside a dialog or menu, each with the `where` its targets carry.
export const SURFACES = [
  ['#nav-rail', 'rail'],
  ['#grid:not(.hidden)', 'board'],
  ['#search:not(.hidden)', 'search'],
  ['#ext-views > .ext-view:not(.hidden)', 'view'],
  ['#diff-panel:not([hidden])', 'diff'],
  ['#panel', 'panel'],
  ['#panel-sections', 'panel'],
  ['#chat-wrap:not([hidden])', 'panel'],
];
// The reserved task id of the Unassigned tile (app.js ADHOC_ID), as api.openTask names it.
export const ADHOC_ID = 'adhoc';
// Badge text is a short label, never markup.
export const BADGE_MAX = 24;
const LABEL_MAX = 80;

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const cap = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function badgeText(v) {
  if (typeof v !== 'string' && typeof v !== 'number') return '';
  return cap(clean(v), BADGE_MAX);
}

export const isOpenModal = (el) => {
  if (el.tagName === 'DIALOG') {
    if (!el.open) return false;
    try { return el.matches(':modal') || /-modal$/.test(el.id) || el.id === 'modal'; } catch { return /-modal$/.test(el.id); }
  }
  return !el.classList.contains('hidden') && !el.hidden;
};

// The facts a key is made from, read off one element. `scope` is filled by the caller.
export function factsOf(el) {
  const ds = el.dataset || {};
  const tile = el.closest?.('.task-cell');
  const card = el.closest?.('.session-card[data-sid], .worker-row[data-sid]:not(.team-row)');
  return {
    tag: el.tagName.toLowerCase(),
    id: el.id || '',
    cls: el.classList?.[0] || '',
    classes: [...(el.classList || [])],
    data: Object.keys(ds).filter((k) => !k.startsWith('busy')).sort().map((k) => `${k}=${ds[k]}`),
    name: el.getAttribute?.('name') || '',
    href: el.matches?.('a[href]') ? el.getAttribute('href') : '',
    role: el.getAttribute?.('role') || '',
    field: !!el.matches?.(FIELD),
    primary: !!el.matches?.('.primary'),
    rail: !!el.closest?.('#nav-rail'),
    sid: card?.dataset.sid || '',
    selfSession: card === el,
    leadSid: el.matches?.('.team-row') ? (ds.leadSid || '') : '',
    subagent: el.matches?.('.subagent-row') ? `${ds.ownerSid || ''}/${ds.subagentId || ''}` : '',
    taskId: tile ? (tile.dataset.taskid || (tile.dataset.entity === 'no-task' ? ADHOC_ID : '')) : '',
    railExt: ds.extRail || '',
    label: labelOf(el, card === el),
  };
}

export function labelOf(el, isCard = false) {
  const own = clean(el.getAttribute?.('aria-label')) || (isCard ? clean(el.querySelector?.('.card-name')?.textContent) : '') || clean(el.getAttribute?.('title'));
  const text = own || clean(el.textContent) || clean(el.getAttribute?.('placeholder')) || clean(el.value);
  return cap(text, LABEL_MAX);
}

// A target's kind, for an extension that ranks or filters them.
function kindOf(f) {
  if (f.selfSession || f.leadSid || f.subagent) return 'session';
  if (f.taskId && f.classes.some((c) => c === 'task-new-sess' || c === 'empty-new-sess' || c === 'new-sess-row')) return 'task-new-session';
  if (f.taskId && f.classes.includes('task-actions-btn')) return 'task-menu';
  if (f.rail) return 'rail';
  if (f.field) return 'field';
  if (f.role === 'tab') return 'tab';
  if (f.tag === 'a' || f.role === 'link') return 'link';
  return 'button';
}

// The key before uniqueKeys has had its say, and the kind. `f.scope` is
// 'dialog:<id>', 'menu' or the surface's `where`.
export function keyFor(f) {
  const kind = kindOf(f);
  if (f.selfSession) return { key: `session:${f.sid}`, kind };
  if (f.leadSid) return { key: `team:${f.leadSid}`, kind };
  if (f.subagent) return { key: `subagent:${f.subagent}`, kind };
  if (f.rail) {
    const view = f.data.find((d) => d.startsWith('view='));
    if (f.railExt) return { key: `rail:ext:${f.railExt}`, kind };
    if (view) return { key: `rail:view:${view.slice(5)}`, kind };
    if (f.id) return { key: `rail:${f.id}`, kind };
  }
  // A task tile's own buttons carry no id or data: the tile and the role name them.
  if (f.taskId && !f.sid) {
    if (f.classes.includes('task-new-sess')) return { key: `task:${f.taskId}:new-session`, kind };
    if (f.classes.includes('empty-new-sess') || f.classes.includes('new-sess-row')) return { key: `task:${f.taskId}:new-session-row`, kind };
    if (f.classes.includes('task-actions-btn')) return { key: `task:${f.taskId}:menu`, kind };
  }
  const scope = f.scope?.startsWith('dialog:') || f.scope === 'menu' ? f.scope
    : f.sid ? `session:${f.sid}`
      : f.taskId ? `task:${f.taskId}`
        : f.scope || 'board';
  if (f.id) return { key: `${scope}:#${f.id}`, kind };
  const sig = [f.tag + (f.cls ? `.${f.cls}` : ''), ...f.data, f.name && `name=${f.name}`, f.href && `href=${f.href}`].filter(Boolean).join('|');
  return { key: `${scope}:${sig}`, kind, loose: true };
}

// Make every key unique: a loose key that collides takes its label, then an
// ordinal (in document order) if the label does not settle it.
export function uniqueKeys(items) {
  const count = (list, get) => list.reduce((m, it) => m.set(get(it), (m.get(get(it)) || 0) + 1), new Map());
  const first = count(items, (it) => it.key);
  for (const it of items) if (it.loose && first.get(it.key) > 1) it.key = `${it.key}|${it.label}`;
  const seen = new Map();
  for (const it of items) {
    const n = (seen.get(it.key) || 0) + 1;
    seen.set(it.key, n);
    if (n > 1) it.key = `${it.key}~${n}`;
  }
  return items;
}

export const targetsKey = (list) => JSON.stringify(list.map((t) => [t.key, t.kind, t.label, t.where, t.primary, t.href || '']));
export const frontKey = (f) => JSON.stringify([f.view, f.ext, f.dialog, f.menu, f.session, f.panel]);
// The open session's Terminal, as one target.
export const TERMINAL_KEY = 'panel:terminal';

// The rect a target shows inside every clipping ancestor and the window, or null.
export function clippedRect(el, win) {
  if (!el.isConnected) return null;
  const r = el.getBoundingClientRect();
  let [top, left, bottom, right] = [r.top, r.left, r.bottom, r.right];
  for (let p = el.parentElement; p && p !== el.ownerDocument.body; p = p.parentElement) {
    const st = win.getComputedStyle(p);
    if (st.overflow === 'visible' && st.overflowX === 'visible' && st.overflowY === 'visible') continue;
    const pr = p.getBoundingClientRect();
    top = Math.max(top, pr.top); left = Math.max(left, pr.left);
    bottom = Math.min(bottom, pr.bottom); right = Math.min(right, pr.right);
  }
  top = Math.max(top, 0); left = Math.max(left, 0);
  bottom = Math.min(bottom, win.innerHeight); right = Math.min(right, win.innerWidth);
  return bottom - top < 4 || right - left < 4 ? null : { top, left, bottom, right };
}

// clippedRect, only while it is painted, takes the pointer and is not covered.
function shownRect(el, win) {
  const r = clippedRect(el, win);
  if (!r || el.checkVisibility?.({ visibilityProperty: true }) === false || win.getComputedStyle(el).pointerEvents === 'none') return null;
  const inset = Math.min(8, Math.max(2, Math.min(r.right - r.left, r.bottom - r.top) * 0.3));
  const at = el.ownerDocument.elementFromPoint?.(Math.min(r.left + inset, r.right - 1), Math.min(r.top + inset, r.bottom - 1));
  return !at || el.contains(at) || at.contains(el) ? r : null;
}

const clickables = (root) => [...root.querySelectorAll(CLICKABLE)].filter((el) =>
  !el.matches(':disabled, [aria-disabled="true"], label:has(:disabled)') && !(el.matches(CHOICE) && el.closest('label')) && !el.closest(NEVER));

// `view()` the board's current view key, `session()` the selected session id,
// `extOfView(view)` the extension that owns a view key (or null), `panel()` what
// the open session's panel shows ('chat', 'terminal' or null) and `terminal()`
// its Terminal as `{ el, focus }` (or null).
export function createBoardTargets({ doc, view = () => 'grid', session = () => null, extOfView = () => null, panel = () => null, terminal = () => null, onError = (...a) => console.error(...a) }) {
  const win = doc.defaultView;
  const targetListeners = new Set();
  const frontListeners = new Set();
  // extId -> Map<key, text>
  const badges = new Map();
  let layer = null;
  // key -> { el, rect } from the last scan
  let current = new Map();
  let lastList = [];
  let lastTargets = null, lastFront = null;
  let observer = null, timer = null, frame = null;

  function topModal() {
    const open = [...doc.querySelectorAll(MODALS)].filter(isOpenModal);
    return open.find((m) => m.contains(doc.activeElement)) || open.at(-1) || null;
  }
  const openMenu = () => [...doc.querySelectorAll('body > .context-menu')].at(-1) || null;

  function front() {
    const v = String(view() || 'grid');
    const modal = topModal();
    return {
      view: v,
      ext: extOfView(v) || null,
      dialog: modal ? (modal.id || 'dialog') : null,
      menu: !!openMenu(),
      session: session() || null,
      panel: panel() || null,
    };
  }

  function roots() {
    const modal = topModal();
    if (modal) return [[modal, `dialog:${modal.id || 'dialog'}`]];
    const menu = openMenu();
    if (menu) return [[menu, 'menu']];
    return SURFACES.flatMap(([sel, where]) => [...doc.querySelectorAll(sel)].map((el) => [el, where]));
  }

  // The open Terminal, when nothing is over it and it shows.
  function terminalItem(rootList) {
    if (rootList.some(([, where]) => where.startsWith('dialog:') || where === 'menu')) return null;
    const t = terminal();
    const rect = t?.el ? shownRect(t.el, win) : null;
    if (!rect) return null;
    return { key: TERMINAL_KEY, kind: 'terminal', el: t.el, focus: t.focus, rect, label: 'Terminal', primary: false, href: '', where: 'panel' };
  }

  function scan() {
    const seen = new Set();
    const items = [];
    const rootList = roots();
    for (const [root, where] of rootList) {
      for (const el of clickables(root)) {
        if (seen.has(el)) continue;
        seen.add(el);
        const rect = shownRect(el, win);
        if (!rect) continue;
        const f = factsOf(el);
        f.scope = where;
        const { key, kind, loose } = keyFor(f);
        items.push({ key, kind, loose, el, rect, label: f.label, primary: f.primary, href: f.href, where: where.startsWith('dialog:') ? 'dialog' : where });
      }
    }
    uniqueKeys(items);
    const term = terminalItem(rootList);
    if (term) items.push(term);
    current = new Map(items.map((it) => [it.key, it]));
    lastList = items;
    return items;
  }

  const publicOf = (it) => ({
    key: it.key, kind: it.kind, label: it.label, where: it.where, primary: it.primary,
    ...(it.href ? { href: it.href } : {}),
    rect: { x: Math.round(it.rect.left), y: Math.round(it.rect.top), width: Math.round(it.rect.right - it.rect.left), height: Math.round(it.rect.bottom - it.rect.top) },
  });

  function ensureLayer() {
    if (layer?.isConnected) return layer;
    layer = doc.createElement('div');
    layer.id = 'ext-target-badges';
    layer.setAttribute('aria-hidden', 'true');
    doc.body.appendChild(layer);
    return layer;
  }

  // Draw every extension's badges on the targets of the last scan. A key not on
  // screen draws nothing and keeps its text for when it is back.
  function paintBadges() {
    const want = new Map();
    for (const [extId, map] of badges) {
      for (const [key, text] of map) {
        const it = current.get(key);
        if (it && it.el.isConnected) want.set(`${extId}\u0000${key}`, { extId, key, text, it });
      }
    }
    if (!want.size && !layer) return;
    const host = ensureLayer();
    const have = new Map([...host.children].map((b) => [b.dataset.slot, b]));
    for (const [slot, b] of have) if (!want.has(slot)) b.remove();
    for (const [slot, { extId, key, text, it }] of want) {
      let b = have.get(slot);
      if (!b) {
        b = doc.createElement('span');
        b.className = 'ext-target-badge';
        b.dataset.slot = slot;
        b.dataset.ext = extId;
        b.dataset.key = key;
        host.appendChild(b);
      }
      if (b.textContent !== text) b.textContent = text;
      const r = clippedRect(it.el, win) || it.rect;
      b.style.left = `${Math.max(2, Math.round(r.left - 4))}px`;
      b.style.top = `${Math.max(2, Math.round(r.top - 6))}px`;
    }
  }

  function notify() {
    const list = lastList.map(publicOf);
    const tk = targetsKey(list);
    if (tk !== lastTargets) {
      lastTargets = tk;
      for (const fn of [...targetListeners]) {
        try { fn(list.map((t) => ({ ...t, rect: { ...t.rect } }))); } catch (err) { onError('targets.onChange listener failed', err); }
      }
    }
    const f = front();
    const fk = frontKey(f);
    if (fk !== lastFront) {
      lastFront = fk;
      for (const fn of [...frontListeners]) {
        try { fn({ ...f }); } catch (err) { onError('front.onChange listener failed', err); }
      }
    }
  }

  function run() {
    timer = null;
    if (doc.hidden) return;
    try { scan(); paintBadges(); notify(); } catch (err) { onError('board targets scan failed', err); }
  }
  // Coalesce a burst of redraws into one scan.
  function schedule() {
    if (!active() || timer) return;
    timer = win.setTimeout(run, 60);
  }
  // A scroll or resize moves badges every frame; the full scan follows it.
  function onMove() {
    if (!active()) return;
    if (!frame) frame = win.requestAnimationFrame(() => { frame = null; paintBadges(); });
    schedule();
  }

  const active = () => targetListeners.size > 0 || frontListeners.size > 0 || [...badges.values()].some((m) => m.size);
  const ignorable = (n) => {
    const el = n?.nodeType === 1 ? n : n?.parentElement;
    return !!el?.closest?.('.xterm, #ext-target-badges');
  };
  function watch() {
    if (observer || !active()) return;
    observer = new win.MutationObserver((records) => { if (records.some((r) => !ignorable(r.target))) schedule(); });
    observer.observe(doc.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class', 'hidden', 'open', 'disabled', 'aria-disabled', 'inert', 'style', 'title', 'aria-label'] });
    win.addEventListener('scroll', onMove, true);
    win.addEventListener('resize', onMove);
    doc.addEventListener('visibilitychange', schedule);
    schedule();
  }
  function unwatchIfIdle() {
    if (active() || !observer) return;
    observer.disconnect();
    observer = null;
    win.removeEventListener('scroll', onMove, true);
    win.removeEventListener('resize', onMove);
    doc.removeEventListener('visibilitychange', schedule);
    lastTargets = null; lastFront = null;
  }

  return {
    list() {
      scan();
      return lastList.map(publicOf);
    },
    // Click the target (focus a field), as a pointer would. False if no target has that key now.
    press(key) {
      scan();
      const it = current.get(key);
      if (!it) return false;
      if (it.focus) it.focus();
      else if (it.el.matches(FIELD)) it.el.focus();
      else it.el.click();
      schedule();
      return true;
    },
    front,
    onTargets(fn) { targetListeners.add(fn); watch(); return () => { targetListeners.delete(fn); unwatchIfIdle(); }; },
    onFront(fn) {
      frontListeners.add(fn);
      if (lastFront == null) lastFront = frontKey(front());
      watch();
      return () => { frontListeners.delete(fn); unwatchIfIdle(); };
    },
    // Replace `extId`'s badges with `map` ({ key: text }); an empty map clears them.
    setBadges(extId, map) {
      const next = new Map();
      for (const [k, v] of Object.entries(map || {})) {
        const t = badgeText(v);
        if (typeof k === 'string' && k && t) next.set(k, t);
      }
      if (next.size) badges.set(extId, next); else badges.delete(extId);
      watch();
      if (!current.size && next.size) scan();
      paintBadges();
      unwatchIfIdle();
    },
    dropExtension(extId) {
      if (badges.delete(extId)) paintBadges();
      unwatchIfIdle();
    },
  };
}
