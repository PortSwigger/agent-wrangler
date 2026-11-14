// The deprecated surfaces an adapter keeps working, as the `surface` of the
// `core.deprecated` telemetry event (docs/extensions.md#core-events). Closed:
// an adapter added later adds its id here, and the event's version with it.
export const BOARD_SURFACES = [
  'board.session-field',
  'board.graph-key',
];

export const DECK_SURFACES = [
  'manifest.unsplit',
  'route.file',
  'route.ext-file',
  'ws.legacy',
  'board-port.deck',
  'board-port.pty',
  'board-port.ws-api',
];

export const DEPRECATED_SURFACES = [...BOARD_SURFACES, ...DECK_SURFACES];

export const EXTENSION_ID_RE = /^[a-z][a-z0-9-]{0,63}$/;
