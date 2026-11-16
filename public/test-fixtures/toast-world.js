import { createToasts } from '../toast.js';

// Just enough DOM for the stack: elements with children, classes, attributes,
// listeners and a popover state, plus a manual clock.
export function fakeWorld({ position = 'bottom-right' } = {}) {
  const make = (tag) => {
    const classes = new Set();
    const el = {
      tag, children: [], parentNode: null, textContent: '', attrs: {}, listeners: {}, style: { setProperty(k, v) { this[k] = v; } }, hidden: false, popoverOpen: false, shows: 0,
      get className() { return [...classes].join(' '); },
      set className(v) { classes.clear(); for (const c of String(v).split(/\s+/).filter(Boolean)) classes.add(c); },
      classList: { toggle: (c) => (classes.has(c) ? (classes.delete(c), false) : (classes.add(c), true)), contains: (c) => classes.has(c) },
      get isConnected() { let n = el; while (n.parentNode) n = n.parentNode; return n === doc.body; },
      get nextSibling() { return el.parentNode?.children[el.parentNode.children.indexOf(el) + 1] ?? null; },
      setAttribute(k, v) { el.attrs[k] = v; },
      addEventListener(t, fn) { (el.listeners[t] ||= []).push(fn); },
      fire(t, e = {}) { for (const fn of el.listeners[t] || []) fn({ stopPropagation() {}, ...e }); },
      click() { el.fire('click'); },
      matches: (sel) => (sel === ':popover-open' ? el.popoverOpen : false),
      showPopover() { el.popoverOpen = true; el.shows++; },
      hidePopover() { el.popoverOpen = false; },
      append(...kids) { for (const k of kids) { if (k.parentNode) k.remove(); k.parentNode = el; el.children.push(k); } },
      insertBefore(child, before) { if (!before) return el.append(child); if (child.parentNode) child.remove(); child.parentNode = el; el.children.splice(el.children.indexOf(before), 0, child); },
      replaceChildren(...kids) { for (const c of [...el.children]) c.remove(); el.append(...kids); },
      remove() { if (!el.parentNode) return; const p = el.parentNode; p.children.splice(p.children.indexOf(el), 1); el.parentNode = null; if (el.popoverOpen) el.popoverOpen = false; },
    };
    return el;
  };
  const doc = { createElement: make, getElementById: () => null };
  doc.body = make('body');
  let t = 0;
  const timers = new Map();
  let next = 1;
  const clock = {
    setTimeout: (fn, ms) => { timers.set(next, { fn, at: t + ms }); return next++; },
    clearTimeout: (id) => timers.delete(id),
    now: () => t,
    advance(ms) {
      const end = t + ms;
      for (;;) {
        const due = [...timers].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        t = due[1].at;
        due[1].fn();
      }
      t = end;
    },
  };
  return { doc, clock, toasts: createToasts({ document: doc, position, ...clock }) };
}
