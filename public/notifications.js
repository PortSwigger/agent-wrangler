// The bottom-right notification stack: persistent cards an extension raises
// with api.ui.notify (slots.js) for something the human may want to act on but
// did not ask about. Unlike toast.js's single transient toast they stack, stay
// until answered or closed, and never take focus. A leaf: `document` is
// injected so the stacking rules are unit-testable.
//
// Cards are keyed `<owner>:<id>`, the owner being the extension id, so one
// extension can neither replace nor withdraw another's. All text is set as
// text.

export const MAX_ACTIONS = 3;

export function createNotifications({ document }) {
  let stack = null;
  // key -> { el, resolvers }
  const open = new Map();

  function root() {
    if (!stack || !stack.parentNode) {
      stack = document.createElement('div');
      stack.className = 'notif-stack';
      stack.setAttribute('role', 'region');
      stack.setAttribute('aria-label', 'Notifications');
      document.body.append(stack);
    }
    return stack;
  }

  function settle(key, answer) {
    const entry = open.get(key);
    if (!entry) return;
    open.delete(key);
    entry.el.remove();
    for (const resolve of entry.resolvers) resolve(answer);
  }

  function fill(el, key, { title, body, actions }) {
    el.replaceChildren();
    const close = document.createElement('button');
    close.className = 'notif-close';
    close.setAttribute('aria-label', 'Close');
    close.textContent = '×';
    close.addEventListener('click', () => settle(key, null));
    const head = document.createElement('div');
    head.className = 'notif-title';
    head.textContent = title;
    el.append(close, head);
    if (body) {
      const p = document.createElement('div');
      p.className = 'notif-body';
      p.textContent = body;
      el.append(p);
    }
    if (actions.length) {
      const row = document.createElement('div');
      row.className = 'notif-actions';
      for (const a of actions) {
        const b = document.createElement('button');
        b.className = a.primary ? 'primary' : 'ghost';
        b.textContent = a.label;
        b.addEventListener('click', () => settle(key, a.id));
        row.append(b);
      }
      el.append(row);
    }
  }

  return {
    // Resolves with the clicked action's id, or null when closed or withdrawn.
    // Showing an id that is already up updates it in place, and every caller
    // waiting on it gets the same answer.
    show(owner, { id, title, body = '', actions = [] }) {
      const key = `${owner}:${id}`;
      return new Promise((resolve) => {
        let entry = open.get(key);
        if (!entry) {
          const el = document.createElement('div');
          el.className = 'notif-card';
          entry = { el, resolvers: [] };
          open.set(key, entry);
          root().append(el);
        }
        entry.resolvers.push(resolve);
        fill(entry.el, key, { title, body, actions: actions.slice(0, MAX_ACTIONS) });
      });
    },
    withdraw(owner, id) { settle(`${owner}:${id}`, null); },
    clear(owner) {
      for (const key of [...open.keys()]) if (key.startsWith(`${owner}:`)) settle(key, null);
    },
  };
}
