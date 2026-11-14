// An extension manifest as its two halves. The deck half is everything that
// runs beside sessions (tools, handlers, stores, graph, session hooks, sweeps,
// runtimes, skills, settings, requires, telemetry); the board half is what the
// browser loads (client, styles, themes). The halves are paired by `id` and
// `boardApi`: the deck lists `{ id, version, boardApi }` on GET /deck and the
// board mounts the half it holds for that id only when its boardApi matches.
//
// A split manifest carries its board half under `board`; an unsplit one has the
// board fields at the top level and is read as both halves, loading as it
// always did.
export const BOARD_FIELDS = ['client', 'styles', 'themes'];

export function manifestHalves(manifest) {
  const split = manifest?.board != null;
  const src = split ? manifest.board : manifest;
  const board = { id: manifest?.id, boardApi: boardApiOf(manifest) };
  for (const k of BOARD_FIELDS) if (src?.[k] != null) board[k] = src[k];
  const deck = { ...manifest };
  delete deck.board;
  for (const k of BOARD_FIELDS) delete deck[k];
  return { deck, board, split, unsplitBoard: !split && BOARD_FIELDS.some((k) => manifest?.[k] != null) };
}

// The board API range the board half was written against: its own `boardApi`,
// else the range the whole manifest declares, else null (the deck lists the
// API it serves).
export function boardApiOf(manifest) {
  if (typeof manifest?.boardApi === 'string' && manifest.boardApi) return manifest.boardApi;
  const range = manifest?.engines?.wranglerApi;
  return typeof range === 'string' && range ? range : null;
}
