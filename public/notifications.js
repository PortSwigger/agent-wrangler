import { getToasts } from './toast.js';

export const MAX_ACTIONS = 3;

export function createNotifications({ document, toasts = getToasts(document) }) {
  const open = new Map();

  function settle(key, answer) {
    const entry = open.get(key);
    if (!entry) return;
    open.delete(key);
    toasts.dismissPersistent(entry);
    for (const resolve of entry.resolvers) resolve(answer);
  }

  return {
    // Replacement keeps every caller waiting for the same eventual answer.
    show(owner, { id, title, body = '', actions = [] }) {
      const key = `${owner}:${id}`;
      return new Promise((resolve) => {
        let entry = open.get(key);
        if (!entry) {
          entry = { resolvers: [] };
          open.set(key, entry);
        }
        entry.resolvers.push(resolve);
        toasts.showPersistent(entry, {
          title, body,
          actions: actions.slice(0, MAX_ACTIONS).map((a) => ({
            label: a.label, primary: a.primary, onClick: () => settle(key, a.id),
          })),
          onDismiss: () => settle(key, null),
        });
      });
    },
    withdraw(owner, id) { settle(`${owner}:${id}`, null); },
    clear(owner) {
      for (const key of [...open.keys()]) if (key.startsWith(`${owner}:`)) settle(key, null);
    },
  };
}
