// Adapters that keep surfaces older extensions use working on top of the deck
// API. Each logs one console warning, the first time it is used, naming what
// replaces it, and reports each extension's first use of it this page load to
// the deck (the deck.deprecation action, sent on as `core.deprecated`).
const warned = new Set();
const reported = new Set();
let reporter = null;
let early = [];

// The extension whose contribution is running now (slots.js wraps each
// contribution method in actingAs), so a read can name its reader. A read
// after an await has left that scope and is reported with no extension.
let acting = null;
export function actingAs(extId, fn) {
  const prev = acting;
  acting = extId;
  try { return fn(); } finally { acting = prev; }
}
export const actingExt = () => acting;

// `fn(surface, extId)` sends one report and resolves true once the deck took
// it; a refusal lets the next use try again.
export function setLegacyReporter(fn) {
  reporter = typeof fn === 'function' ? fn : null;
  if (reporter) for (const [use, ext] of early.splice(0)) report(use, ext);
}

function report(use, ext) {
  const key = `${use}|${ext ?? ''}`;
  if (reported.has(key)) return;
  if (!reporter) {
    if (early.length < 50 && !early.some(([u, e]) => u === use && e === ext)) early.push([use, ext]);
    return;
  }
  reported.add(key);
  Promise.resolve()
    .then(() => reporter(use, ext))
    .then((ok) => { if (!ok) reported.delete(key); }, () => reported.delete(key));
}

export function warnLegacy(surface, replacement, { use = null, ext = actingExt(), log = (m) => console.warn(m) } = {}) {
  if (use) report(use, ext ?? null);
  if (warned.has(surface)) return;
  warned.add(surface);
  log(`[agent-wrangler] ${surface} is deprecated and kept working through an adapter; use ${replacement} instead.`);
}

// A session record with its compat fields put back, each read warning once.
// Enumerable so a spread or Object.keys still sees the record's old shape; a
// write replaces the getter with the value written.
export function withCompatFields(record, fields, warn = warnLegacy) {
  const out = { ...record };
  for (const [key, value] of Object.entries(fields)) {
    Object.defineProperty(out, key, {
      enumerable: true,
      configurable: true,
      get() {
        warn(`session.${key}`, 'a field the deck API session view carries', { use: 'board.session-field' });
        return value;
      },
      set(v) {
        Object.defineProperty(out, key, { value: v, enumerable: true, configurable: true, writable: true });
      },
    });
  }
  return out;
}

export const resetLegacyWarnings = () => {
  warned.clear();
  reported.clear();
  early = [];
  reporter = null;
};
