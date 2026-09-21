// Claude Code (2.1+) wraps material the human pasted into the composer in
// <pasted_content id="…">…</pasted_content id="…"> — both the open and close
// tag carry the same id, which is composer plumbing the human never typed or
// sees. Three surfaces extract Claude user text independently (chat-events.js
// for the chat view, search/extract.js for the search corpus,
// transcript-reader.js's two summary paths) and all three need the same
// strip, so it lives here once rather than being copied three times.
//
// A LEAF: zero imports, so it is safe for chat-events.js and search/extract.js
// (which must themselves stay leaf-compatible) to pull in.
//
// A hand-rolled linear scan, not a single backreferenced regex — a regex of
// the shape /<pasted_content id="([^"]*)">([\s\S]*?)<\/pasted_content id="\1">/g
// retries its lazy body scan from every unmatched opening tag when no closer
// exists, which is O(n²) on adversarial input (measured ~340ms for a ~290KB
// message of nothing but unclosed openers — user-controlled transcript text,
// scanned on every chat poll). This scan makes one forward pass and, on
// hitting an unterminated wrapper, gives up on the REST of the string rather
// than backtracking to retry from the next character — which is also the
// correct fallback, not just the fast one: once one wrapper is broken, nothing
// after it in that message can be trusted to close cleanly either, so the
// remainder is left exactly as written rather than risk eating real text.
//
// Recurses on each wrapper's own body so a DIFFERENT-id wrapper nested inside
// one still gets stripped — a single regex pass can't do this, because
// String.replace never reprocesses the text it just substituted in. A wrapper
// nested with the SAME id closes at its own first inner close tag rather than
// the outer one, same limit a regex would have; genuine same-id nesting does
// not occur in practice (every paste mints its own id), so this is a
// documented limit, not a bug being papered over.
const OPEN_PREFIX = '<pasted_content id="';

export function stripPastedContentWrapper(text) {
  if (typeof text !== 'string' || !text.includes(OPEN_PREFIX)) return text;
  let out = '';
  let i = 0;
  while (i < text.length) {
    const openIdx = text.indexOf(OPEN_PREFIX, i);
    if (openIdx === -1) { out += text.slice(i); break; }
    const idStart = openIdx + OPEN_PREFIX.length;
    const idEnd = text.indexOf('"', idStart);
    const tagEnd = idEnd === -1 ? -1 : text.indexOf('>', idEnd);
    // Malformed or truncated open tag: leave everything from here on untouched
    // rather than guess at what it meant.
    if (idEnd === -1 || tagEnd === -1) { out += text.slice(i); break; }
    const id = text.slice(idStart, idEnd);
    const bodyStart = tagEnd + 1;
    const closeTag = `</pasted_content id="${id}">`;
    const closeIdx = text.indexOf(closeTag, bodyStart);
    // No matching close anywhere ahead: an interrupted paste, most likely.
    // Same "stop, don't backtrack" reasoning as above.
    if (closeIdx === -1) { out += text.slice(i); break; }
    out += text.slice(i, openIdx) + stripPastedContentWrapper(text.slice(bodyStart, closeIdx));
    i = closeIdx + closeTag.length;
  }
  return out;
}
