// Terminal font-size presets, shared by the picker UI and the persisted setting.
// Pure module (imports nothing) so it's unit-testable under node and free of any
// DOM/xterm coupling — app.js owns the localStorage + live-terminal wiring.

// The five offered sizes; 12 is the historical hardcoded default, kept as the
// fresh-browser fallback so nobody who hasn't opted in sees a change.
export const TERM_FONT_SIZES = [11, 12, 13, 14, 15];
export const DEFAULT_TERM_FONT_SIZE = 12;

// Coerce a stored value (a localStorage string, or anything) to a valid preset,
// falling back to the default for non-members, non-integers, and garbage. This
// is the guard against a hand-edited / stale / future-shrunk preset list.
export function normalizeFontSize(raw) {
  const n = typeof raw === 'number' ? raw : Number(raw);
  return Number.isInteger(n) && TERM_FONT_SIZES.includes(n) ? n : DEFAULT_TERM_FONT_SIZE;
}
