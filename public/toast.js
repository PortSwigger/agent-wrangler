// The board's shared stack: up to MAX_TOASTS transient messages plus persistent
// notifications, newest nearest the chosen edge. Pure DOM and timers, so
// every module can surface feedback without importing app state; `document` and
// the clock are injected so the stacking rules are unit-testable.
//
// toast(text, isErr, opts) keeps its old signature. `isErr` is a boolean (true
// means 'error') or a severity name; the severity sets how long it stays:
// success 3 s, info 5 s, warning 8 s, and an error until it is closed.
// `opts` is either a single action `{ label, onClick, duration }` (legacy) or
// `{ actions: [{label, onClick}], duration, details, id }`:
//   duration  overrides the severity's lifetime (ms)
//   details   longer text behind a Details expander
//   id        a toast with the same id is replaced in place rather than stacked
// Long text is clamped to three lines, with Details to read the rest.
//
// The stack is a manual popover, so it is drawn in the top layer. A modal
// <dialog> makes everything outside it inert, so while one is open the stack is
// moved inside the topmost one and re-shown, which puts it above that dialog
// and keeps its buttons clickable.

export const MAX_TOASTS = 3;
export const SEVERITY_MS = { success: 3000, info: 5000, warning: 8000, error: Infinity };

const FOOTERS = '.modal-actions, dialog footer';
const HEADERS = `header, [role="banner"], [role="toolbar"], #panel, #system-banner, .task-head, .search-head, .diff-head, .file-head, .usage-head, .terminal-dialog-head, .modal-card > h3, dialog > :first-child:has(> :is(h1, h2, h3)), dialog > :first-child > :first-child:has(:is(h1, h2, h3)), ${FOOTERS}`;

function severityOf(isErr, opts) {
  if (typeof isErr === 'string' && isErr in SEVERITY_MS) return isErr;
  if (isErr) return 'error';
  return opts?.severity in SEVERITY_MS ? opts.severity : 'info';
}

export function createToasts({ document, position = 'top-right', setTimeout: later = globalThis.setTimeout, clearTimeout: cancel = globalThis.clearTimeout, now = () => Date.now() }) {
  const live = []; // oldest first: { el, id, key, rank, remaining, started, timer }
  const modals = []; // open modal dialogs, in the order they opened
  let stack = null;
  let clearButton = null;
  let held = false; // hovered or focused: every timer waits
  let headerObserver = null;
  let modalObserver = null;
  let watching = false;
  let frame = null;
  let scrollAfterLayout = false;
  const requestFrame = document.defaultView?.requestAnimationFrame?.bind(document.defaultView);
  const cancelFrame = document.defaultView?.cancelAnimationFrame?.bind(document.defaultView);
  const observedHeaders = new Set();
  position = position === 'bottom-right' ? position : 'top-right';

  function root() {
    if (stack) return stack;
    stack = document.getElementById?.('toast') || document.createElement('div');
    stack.id = 'toast';
    stack.className = '';
    stack.setAttribute('popover', 'manual');
    stack.setAttribute('role', 'region');
    stack.setAttribute('aria-label', 'Messages');
    stack.setAttribute('data-position', position);
    clearButton = button('toast-clear', 'Clear all', clear);
    stack.append(clearButton);
    const hold = (on) => () => { held = on; for (const t of live) (on ? pause : run)(t); };
    stack.addEventListener('mouseenter', hold(true));
    stack.addEventListener('mouseleave', () => { if (!stack.matches?.(':focus-within')) hold(false)(); });
    // Keyboard focus holds them too; a mouse click on Details does not, or the
    // stack would stay frozen until the human clicked somewhere else.
    stack.addEventListener('focusin', (e) => { if (e.target.matches?.(':focus-visible')) hold(true)(); });
    stack.addEventListener('focusout', (e) => { if (!stack.contains?.(e.relatedTarget) && !stack.matches?.(':hover')) hold(false)(); });
    // Inside a dialog, a click on a toast is not a click on the dialog's content
    // (some close on an outside click).
    for (const type of ['click', 'pointerdown', 'mousedown']) stack.addEventListener(type, (e) => e.stopPropagation());
    if (!stack.parentNode) document.body.append(stack);
    return stack;
  }

  // Where the stack must live to be on top and clickable: the topmost open
  // modal dialog, or <body>.
  function host() {
    while (modals.length && !(modals.at(-1).open && modals.at(-1).isConnected !== false)) modals.pop();
    return modals.at(-1) || document.body;
  }

  // Put the stack in its host and (re)show it in the top layer, or hide it when
  // it is empty. `raise` re-shows it even when already open, so it moves above
  // a top-layer element opened after it.
  function place(raise = false) {
    const el = root();
    clearButton.hidden = live.length < 2;
    const open = () => el.matches?.(':popover-open');
    if (!live.length) { held = false; stopWatching(); if (open()) el.hidePopover(); return; }
    watch();
    const want = host();
    if (el.parentNode !== want) { if (open()) el.hidePopover(); want.append(el); }
    else if (raise && open()) el.hidePopover();
    if (el.showPopover && !open()) el.showPopover();
    scheduleLayout();
    // Re-showing restarts CSS animations: start each bar where its timer is.
    for (const t of live) if (t.bar) t.bar.style.animationDelay = `${-(t.duration - left(t))}ms`;
  }

  function scheduleLayout() {
    if (!live.length || frame != null) return;
    if (requestFrame) frame = requestFrame(() => { frame = null; layout(); });
    else layout();
  }

  function layout() {
    if (!stack || !live.length) return;
    const viewport = document.defaultView?.innerWidth || document.documentElement?.clientWidth || 800;
    const height = document.defaultView?.innerHeight || document.documentElement?.clientHeight || 800;
    const bounds = stack.getBoundingClientRect?.();
    const right = bounds?.width ? bounds.right - 12 : viewport - 16;
    const left = bounds?.width ? bounds.left + 12 : right - Math.min(560, viewport - 32);
    const headers = new Set(document.querySelectorAll?.(HEADERS) ?? []);
    const topBands = [];
    const modalBands = new Map();
    let top = 16;
    let bottom = 18;
    for (const el of headers) {
      const r = el.getBoundingClientRect?.();
      if (r?.width > 0 && r.height > 0 && r.right > left && r.left < right && r.bottom > 0 && r.top < height) {
        if (el.matches?.(FOOTERS)) {
          if (r.top >= height / 2) bottom = Math.max(bottom, Math.ceil(height - r.top) + 8);
        } else if (r.top <= height / 2) {
          const dialog = el.closest?.('dialog');
          const modal = dialog ? (dialog === modals.at(-1) ? dialog : null) : el.closest?.('.modal-card');
          if (modal) {
            if (!modalBands.has(modal)) modalBands.set(modal, []);
            modalBands.get(modal).push(r);
          } else topBands.push(r);
        }
      }
      if (!observedHeaders.has(el)) headerObserver?.observe(el);
    }
    for (const bands of [topBands, ...modalBands.values()]) {
      bands.sort((a, b) => a.top - b.top);
      let edge = bands === topBands ? top : bands[0].top;
      for (const r of bands) {
        if (r.top > edge + 8) break;
        edge = Math.max(edge, Math.ceil(r.bottom) + 8);
      }
      top = Math.max(top, edge);
    }
    for (const el of observedHeaders) if (!headers.has(el)) headerObserver?.unobserve(el);
    observedHeaders.clear();
    for (const el of headers) observedHeaders.add(el);
    const budget = Math.max(0, height - 120);
    if (top + bottom > budget) {
      const scale = budget / (top + bottom);
      top = Math.floor(top * scale);
      bottom = Math.floor(bottom * scale);
    }
    stack.style.setProperty('--toast-top', `${top}px`);
    stack.style.setProperty('--toast-bottom', `${bottom}px`);
    if (scrollAfterLayout) { scrollAfterLayout = false; scrollToNewest(); }
  }

  function left(t) { return t.timer == null ? t.remaining : t.remaining - (now() - t.started); }

  function pause(t) {
    if (t.timer == null) return;
    cancel(t.timer);
    t.timer = null;
    t.remaining -= now() - t.started;
  }

  function run(t) {
    if (held || t.timer != null || !Number.isFinite(t.remaining)) return;
    t.started = now();
    t.timer = later(() => dismiss(t), Math.max(0, t.remaining));
  }

  function dismiss(t, notify = true) {
    const i = live.indexOf(t);
    if (i < 0) return;
    live.splice(i, 1);
    if (t.timer != null) cancel(t.timer);
    t.el.remove();
    place();
    if (notify) t.onDismiss?.();
  }

  function clear() { for (const t of [...live]) dismiss(t); }

  function insert(t) {
    const el = root();
    el.insertBefore(t.el, position === 'top-right' ? clearButton.nextSibling : clearButton);
  }

  function scrollToNewest() {
    stack.scrollTop = position === 'top-right' ? 0 : stack.scrollHeight;
    scrollAfterLayout = frame != null;
  }

  function setPosition(value) {
    position = value === 'bottom-right' ? value : 'top-right';
    if (!stack) return;
    stack.setAttribute('data-position', position);
    const ordered = position === 'top-right' ? [...live].reverse() : live;
    stack.replaceChildren(...(position === 'top-right' ? [clearButton, ...ordered.map((t) => t.el)] : [...ordered.map((t) => t.el), clearButton]));
    place();
    scrollToNewest();
  }

  function button(className, label, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = className;
    b.textContent = label;
    b.addEventListener('click', onClick);
    return b;
  }

  function build(t, text, severity, { actions, duration, details, body: messageBody }) {
    const el = t.el || document.createElement('div');
    el.replaceChildren();
    el.className = `toast toast-${severity}`;
    if (t.persistent) el.classList.toggle('toast-persistent');
    el.setAttribute('role', severity === 'error' || severity === 'warning' ? 'alert' : 'status');
    const body = document.createElement('div');
    body.className = 'toast-text';
    body.textContent = text;
    el.append(body);
    if (messageBody) {
      const content = document.createElement('div');
      content.className = 'toast-body';
      content.textContent = messageBody;
      el.append(content);
    }
    let more = null;
    if (details) {
      more = document.createElement('div');
      more.className = 'toast-details';
      more.textContent = details;
      more.hidden = true;
      el.append(more);
    }
    const row = document.createElement('div');
    row.className = 'toast-actions';
    for (const action of actions) {
      row.append(button(`toast-action${action.primary ? ' toast-action-primary' : ''}`, action.label, () => { dismiss(t, false); action.onClick(); }));
    }
    // Opening Details means the human is reading it: it then stays until closed.
    const expander = button('toast-action toast-more', 'Details', () => {
      const expanded = el.classList.toggle('expanded');
      expander.textContent = expanded ? 'Less' : 'Details';
      expander.setAttribute('aria-expanded', String(expanded));
      if (more) more.hidden = !expanded;
      if (expanded) { pause(t); t.remaining = Infinity; t.bar?.remove(); t.bar = null; }
    });
    expander.setAttribute('aria-expanded', 'false');
    expander.hidden = !details;
    row.append(expander);
    el.append(row);
    const close = button('toast-close', '×', () => dismiss(t));
    close.setAttribute('aria-label', 'Dismiss');
    el.append(close);
    if (Number.isFinite(duration)) {
      const bar = document.createElement('div');
      bar.className = 'toast-progress';
      bar.style.animationDuration = `${duration}ms`;
      el.append(bar);
      t.bar = bar;
    }
    t.measure = () => { if (body.scrollHeight > body.clientHeight + 1) expander.hidden = false; };
    return el;
  }

  // The oldest of the least important goes first: a plain message before one
  // with actions, and an error last, so a 4th toast never silently drops an
  // error or an undo while a passing note is still up.
  function evict() {
    const transient = live.filter((t) => !t.persistent);
    const lowest = Math.min(...transient.map((t) => t.rank));
    dismiss(transient.find((t) => t.rank === lowest));
  }

  function show(text, isErr, opts) {
    const severity = severityOf(isErr, opts);
    const actions = opts ? (opts.actions || (opts.label ? [opts] : [])) : [];
    const duration = opts?.duration ?? SEVERITY_MS[severity];
    const details = opts?.details ? String(opts.details) : '';
    text = String(text ?? '');
    const id = opts?.id ?? null;
    // The same message again restarts its toast instead of stacking a copy.
    const key = actions.length || details ? null : `${severity}\n${text}`;
    const same = live.find((t) => !t.persistent && ((id != null && t.id === id) || (key != null && t.key === key)));
    if (same) dismiss(same);
    const t = { id, key, rank: severity === 'error' ? 2 : actions.length ? 1 : 0, duration, remaining: duration, started: 0, timer: null, bar: null };
    t.el = build(t, text, severity, { actions, duration, details });
    while (live.filter((item) => !item.persistent).length >= MAX_TOASTS) evict();
    live.push(t);
    insert(t);
    place(true);
    scrollToNewest();
    t.measure();
    run(t);
    return t.el;
  }

  function showPersistent(id, { title, body, actions, onDismiss }) {
    let t = live.find((item) => item.persistent && item.id === id);
    const fresh = !t;
    if (!t) t = { id, persistent: true, duration: Infinity, remaining: Infinity, timer: null };
    t.onDismiss = onDismiss;
    t.el = build(t, title, 'info', { body, actions, duration: Infinity });
    if (fresh) {
      live.push(t);
      insert(t);
    }
    place(true);
    if (fresh) scrollToNewest();
    t.measure();
  }

  // A modal dialog opening goes into the top layer above the stack; follow it.
  function watch() {
    if (watching) return;
    watching = true;
    const RO = document.defaultView?.ResizeObserver ?? globalThis.ResizeObserver;
    if (RO) headerObserver ||= new RO(scheduleLayout);
    document.defaultView?.addEventListener?.('resize', scheduleLayout);
    document.addEventListener?.('scroll', scheduleLayout, true);
    const MO = document.defaultView?.MutationObserver ?? globalThis.MutationObserver;
    if (!MO || !document.documentElement) return;
    modals.push(...(document.querySelectorAll?.('dialog:modal') ?? []));
    modalObserver ||= new MO((records) => {
      let changed = modals.some((d) => d.isConnected === false);
      for (const r of records) {
        if (r.type === 'childList') continue;
        const d = r.target;
        if (d.tagName !== 'DIALOG' || (r.attributeName && r.attributeName !== 'open')) continue;
        changed = true;
        const i = modals.indexOf(d);
        if (i >= 0) modals.splice(i, 1);
        if (d.open && d.isConnected !== false && d.matches(':modal')) modals.push(d);
      }
      if (changed && live.length) place(true);
      else scheduleLayout();
    });
    modalObserver.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['open', 'class', 'hidden'] });
  }

  function stopWatching() {
    if (!watching) return;
    watching = false;
    if (frame != null) cancelFrame?.(frame);
    frame = null;
    scrollAfterLayout = false;
    modalObserver?.disconnect?.();
    headerObserver?.disconnect?.();
    observedHeaders.clear();
    modals.length = 0;
    document.defaultView?.removeEventListener?.('resize', scheduleLayout);
    document.removeEventListener?.('scroll', scheduleLayout, true);
  }

  const dismissId = (id, persistent = false) => { const t = live.find((x) => !!x.persistent === persistent && x.id === id); if (t) dismiss(t); };
  return { show, showPersistent, setPosition, dismiss: dismissId, dismissPersistent: (id) => dismissId(id, true), count: () => live.length, clear };
}

const shared = new WeakMap();
export function getToasts(document) {
  if (!shared.has(document)) shared.set(document, createToasts({ document }));
  return shared.get(document);
}

export function toast(text, isErr, opts) {
  getToasts(globalThis.document).show(text, isErr, opts);
}

export function dismissToast(id) {
  shared.get(globalThis.document)?.dismiss(id);
}

export function setToastPosition(position) {
  getToasts(globalThis.document).setPosition(position);
}
