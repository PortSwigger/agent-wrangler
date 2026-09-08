// The one sink every server log line goes through. launchd appends stdout/stderr
// to a plain file that nothing rotates and nothing dates, so before this the log
// held 273 byte-identical "agent-wrangler running at ..." lines and not one
// restart could be placed in time. Stamping at the sink (rather than in each
// message) means a call site added later is dated by default instead of by
// someone remembering to.
//
// A leaf on purpose — it imports nothing, so agents/*, the MCP server and the
// stores can all use it without touching the import-direction rule in CLAUDE.md.

export function stamp(date = new Date()) {
  return date.toISOString();
}

// The stamp is prefixed INTO the first argument when that's a string, never
// passed as its own console argument. Two reasons: callers like
// `console.error('[uncaughtException]', err)` must keep the error as a separate
// argument so console renders its stack, and a test that captures with
// `console.error = (msg) => errors.push(msg)` would otherwise capture the
// timestamp alone and assert against the wrong string.
function stamped(args, date) {
  const [first, ...rest] = args;
  if (typeof first === 'string') return [`${stamp(date)} ${first}`, ...rest];
  return [stamp(date), ...args];
}

// console.* is looked up per call, not captured, so a test swapping console.error
// still intercepts these.
export function log(...args) { console.log(...stamped(args)); }
export function logWarn(...args) { console.warn(...stamped(args)); }
export function logError(...args) { console.error(...stamped(args)); }

// Compact duration for the lifecycle lines ("idle 8h3m", "up 12d4h"). Two units
// at most: an operator reading a log wants the magnitude, and "8h3m17s" is just
// harder to scan. Rounds down, so a sub-minute span reads "0m" rather than
// implying more precision than the caller's clock has.
export function humanDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return 'unknown';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d${h}h`;
  if (h) return `${h}h${m}m`;
  return `${m}m`;
}
