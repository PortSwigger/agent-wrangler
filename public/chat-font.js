// Chat-view font-size presets. A sibling of term-font.js, deliberately NOT a
// shared generalisation of it: the two settings have different preset sets,
// different defaults and different application mechanics (xterm needs a number
// and a refit; the chat view needs a CSS length and nothing else). What they
// share is a two-line coercion, which is not worth coupling two independent
// preferences together to deduplicate.
//
// Pure module (imports nothing) so it's unit-testable under node and free of any
// DOM coupling — app.js owns the localStorage + CSS-variable wiring.

// The chat view scales as a whole from this one number: every other size in the
// stream is an `em` fraction of it (see #chat-wrap in styles.css), so a preset
// moves the prose, the chips, the tool rows and the composer together rather
// than making prose big beside unchanged 11px machinery.
export const CHAT_FONT_SIZES = [12, 13, 14, 16, 18];
export const DEFAULT_CHAT_FONT_SIZE = 14;

// Same guard as term-font's: coerce a stored value (a localStorage string, or
// anything) to a valid preset, falling back to the default for non-members,
// non-integers and garbage.
export function normalizeChatFontSize(raw) {
  const n = typeof raw === 'number' ? raw : Number(raw);
  return Number.isInteger(n) && CHAT_FONT_SIZES.includes(n) ? n : DEFAULT_CHAT_FONT_SIZE;
}
