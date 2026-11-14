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
      .map((e) => ({ id: e.id, version: e.version ?? null, boardApi: e.boardApi || boardApi })),
  };
}

// `?api=` on the /ws upgrade: absent is a legacy client (served by the
// adapter in legacy.js), a 1.x value is a deck API client, and anything else is
// a board this deck cannot serve.
export function wsApiMode(search) {
  const api = new URLSearchParams(search).get('api');
  if (api == null) return 'legacy';
  return /^1(\.\d+)?$/.test(api) ? 'deck' : null;
}
