export const DECK_API_VERSION = '1.0';

// GET /deck. A board needs the same major `api` and ignores any field or action
// it does not know; minor versions only add.
export function deckDescriptor({ deckId, name, actions, runtimes, extensions, boardApi }) {
  return {
    deckId,
    name,
    api: DECK_API_VERSION,
    runtimes: runtimes.map(({ id, label, agents }) => ({ id, label, agents: agents ?? null })),
    actions: [...actions].sort(),
    extensions: extensions
      .filter((e) => e.enabled)
      .map((e) => ({ id: e.id, version: e.version ?? null, boardApi })),
  };
}

// `?api=` on the /ws upgrade: a 1.x value is a board this deck serves, and
// anything else, or none, is refused.
export function wsApiMode(search) {
  const api = new URLSearchParams(search).get('api');
  return api != null && /^1(\.\d+)?$/.test(api) ? 'deck' : null;
}
