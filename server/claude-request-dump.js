// Claude Code 2.1.300+ also writes a copy of each API request into the
// transcript: `api-request` (params), `api-request-shape` (system prompt and
// tools) and `api-request-blob` (the messages, one per line). A blob carries an
// ordinary `message: { role: 'user', content }`, so every reader that keys on
// `message`/`role` takes it for a conversation turn. It is not one: it repeats
// turns already recorded on their own `user`/`assistant` lines, plus the
// `<system-reminder>` blocks the harness injected (instruction files, memory
// indexes) that never appear anywhere else. Unfiltered, those reminders drew as
// multi-KB human bubbles in the chat view.
//
// A LEAF with no imports, so chat-events.js and search/extract.js can share it
// without depending on each other.

// Claude Code writes `type` as the line's first key, so the raw-line check is a
// prefix test that lets the cheap substring gates reject a dump before parsing.
const LINE_PREFIX = '{"type":"api-request';

export function isRequestDumpLine(line) {
  return typeof line === 'string' && line.startsWith(LINE_PREFIX);
}

// The parsed-entry check is the one that does not depend on key order.
export function isRequestDump(entry) {
  return typeof entry?.type === 'string' && entry.type.startsWith('api-request');
}
