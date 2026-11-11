// The board's toast stack: up to MAX_TOASTS transient messages, newest at the
// bottom, each with a close button. Zero coupling — pure DOM and timers — so
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

function severityOf(isErr, opts) {
  if (typeof isErr === 'string' && isErr in SEVERITY_MS) return isErr;
  if (isErr) return 'error';
  return opts?.severity in SEVERITY_MS ? opts.severity : 'info';
}

export function createToasts({ document, setTimeout: later = globalThis.setTimeout, clearTimeout: cancel = globalThis.clearTimeout, now = () => Date.now() }) {
  const live = []; // oldest first: { el, id, key, rank, remaining, started, timer }
  const modals = []; // open modal dialogs, in the order they opened
  let stack = null;
  let held = false; // hovered or focused: every timer waits

  function root() {
    if (stack && stack.isConnected !== false) return stack;
    stack = document.getElementById?.('toast') || document.createElement('div');
    stack.id = 'toast';
    stack.className = '';
    stack.setAttribute('popover', 'manual');
    stack.setAttribute('role', 'region');
    stack.setAttribute('aria-label', 'Messages');
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
    const open = () => el.matches?.(':popover-open');
    if (!live.length) { held = false; if (open()) el.hidePopover(); return; }
    const want = host();
    if (el.parentNode !== want) { if (open()) el.hidePopover(); want.append(el); }
    else if (raise && open()) el.hidePopover();
    if (el.showPopover && !open()) el.showPopover();
    // Re-showing restarts CSS animations: start each bar where its timer is.
    for (const t of live) if (t.bar) t.bar.style.animationDelay = `${-(t.duration - left(t))}ms`;
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

  function dismiss(t) {
    const i = live.indexOf(t);
    if (i < 0) return;
    live.splice(i, 1);
    if (t.timer != null) cancel(t.timer);
    t.el.remove();
    place();
  }

  function button(className, label, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = className;
    b.textContent = label;
    b.addEventListener('click', onClick);
    return b;
  }

  function build(t, text, severity, { actions, duration, details }) {
    const el = document.createElement('div');
    el.className = `toast toast-${severity}`;
    el.setAttribute('role', severity === 'error' || severity === 'warning' ? 'alert' : 'status');
    const body = document.createElement('div');
    body.className = 'toast-text';
    body.textContent = text;
    el.append(body);
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
      row.append(button('toast-action', action.label, () => { dismiss(t); action.onClick(); }));
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
    if (actions.length && Number.isFinite(duration)) {
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
    const lowest = Math.min(...live.map((t) => t.rank));
    dismiss(live.find((t) => t.rank === lowest));
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
    const same = live.find((t) => (id != null && t.id === id) || (key != null && t.key === key));
    if (same) dismiss(same);
    const t = { id, key, rank: severity === 'error' ? 2 : actions.length ? 1 : 0, duration, remaining: duration, started: 0, timer: null, bar: null };
    t.el = build(t, text, severity, { actions, duration, details });
    while (live.length >= MAX_TOASTS) evict();
    live.push(t);
    root().append(t.el);
    place(true);
    t.measure();
    run(t);
    return t.el;
  }

  // A modal dialog opening goes into the top layer above the stack; follow it.
  function watch() {
    const MO = document.defaultView?.MutationObserver ?? globalThis.MutationObserver;
    if (!MO || !document.documentElement) return;
    modals.push(...(document.querySelectorAll?.('dialog:modal') ?? []));
    new MO((records) => {
      let changed = false;
      for (const r of records) {
        const d = r.target;
        if (d.tagName !== 'DIALOG') continue;
        changed = true;
        const i = modals.indexOf(d);
        if (i >= 0) modals.splice(i, 1);
        if (d.open && d.matches(':modal')) modals.push(d);
      }
      if (changed && live.length) place(true);
    }).observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ['open'] });
  }
  watch();

  return { show, count: () => live.length, clear: () => { for (const t of [...live]) dismiss(t); } };
}

let shared = null;
export function toast(text, isErr, opts) {
  shared ||= createToasts({ document: globalThis.document });
  shared.show(text, isErr, opts);
}
