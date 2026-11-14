// Adapters that keep surfaces older extensions use working on top of the deck
// API. Each logs one console warning, the first time it is used, naming what
// replaces it.
const warned = new Set();

export function warnLegacy(surface, replacement, log = (m) => console.warn(m)) {
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
        warn(`session.${key}`, 'a field the deck API session view carries');
        return value;
      },
      set(v) {
        Object.defineProperty(out, key, { value: v, enumerable: true, configurable: true, writable: true });
      },
    });
  }
  return out;
}

export const resetLegacyWarnings = () => warned.clear();
