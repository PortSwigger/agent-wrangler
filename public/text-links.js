// Linkify plain text: absolute http(s) URLs and local markdown-file paths.
//
// Why this is a separate leaf from term-links.js: that module owns the *matcher*
// for a markdown path plus an xterm link provider, and the chat view needs the
// matcher with none of the xterm half. So the path regex and its cwd resolution
// are imported from there — one definition of "what looks like a .md path", used
// by both views, which is the whole point of issue "Link/preview Markdown links"
// (the terminal already linkified these; the chat view must agree, not approximate).
//
// DOM-free and window-free on purpose, like util.js and term-links.js's matcher:
// it returns SEGMENTS, and the two callers decide what to build from them —
// chat-dom.js builds nodes for the plain-text user bubble, markdown-preview.js
// builds escaped HTML for a markdown-it renderer rule.
import { markdownPathRegex, resolveTerminalPath } from './term-links.js';

// The class every "open this .md in the preview modal" control carries, and the
// hook chat-view.js delegates its click and keydown handlers on (via
// [data-md-path]). Exported so the two builders can't drift apart on the string.
export const MD_LINK_CLASS = 'md-file-link';

// Explicit scheme only. A scheme-less `example.com/x` is deliberately NOT matched:
// in a human's prompt that is at least as likely to be prose as a link, and a
// wrong link is worse than a missing one. The body stops at whitespace and at the
// quoting/markup characters that can't appear unencoded in a URL anyway.
export function urlRegex() {
  return /\bhttps?:\/\/[^\s<>"'`\\]+/gi;
}

const OPENERS = { ')': '(', ']': '[', '}': '{' };

// A URL at the end of a sentence swallows the punctuation that ended the
// sentence, and a URL in parentheses swallows the closing one. Trim trailing
// sentence punctuation unconditionally, and a closing bracket only when the URL
// doesn't contain its opener — so `https://x/a_(b)` keeps its brackets while
// `(see https://x/a)` doesn't. Returns '' when nothing usable survives.
export function trimUrlTail(url) {
  let out = String(url || '');
  for (;;) {
    const last = out.slice(-1);
    if (!last) break;
    if (/[.,;:!?'"]/.test(last)) { out = out.slice(0, -1); continue; }
    const open = OPENERS[last];
    if (open) {
      const closes = out.split(last).length - 1;
      const opens = out.split(open).length - 1;
      if (closes > opens) { out = out.slice(0, -1); continue; }
    }
    break;
  }
  // Must still be scheme + at least one host character.
  return /^https?:\/\/[^\s/]/i.test(out) ? out : '';
}

// Split `text` into a flat, gap-free list of segments:
//   { kind: 'text', text }
//   { kind: 'url',  text, href }
//   { kind: 'file', text, path }   — path already resolved for GET /file
//
// `baseDir` is the session's cwd, used to resolve a relative match. With no
// baseDir a relative path is left as plain text rather than turned into a link
// pointing somewhere invented — the same refusal term-links.js's provider makes.
// `urls:false` is for markdown prose, where markdown-it's own linkify has already
// turned bare URLs into anchors and a second pass would nest a link in a link.
export function linkSegments(text, { baseDir = null, urls = true } = {}) {
  const src = typeof text === 'string' ? text : '';
  if (!src) return [{ kind: 'text', text: '' }];

  const spans = [];
  if (urls) {
    const rex = urlRegex();
    let m;
    while ((m = rex.exec(src))) {
      const href = trimUrlTail(m[0]);
      if (href) spans.push({ start: m.index, end: m.index + href.length, kind: 'url', text: href, href });
      rex.lastIndex = m.index + m[0].length; // never rescan inside the raw match
    }
  }

  const prex = markdownPathRegex();
  let p;
  while ((p = prex.exec(src))) {
    const start = p.index;
    const end = start + p[0].length;
    // A URL ending in .md is a URL. The path regex's own lookbehind already
    // refuses to match inside one, but a trimmed URL tail can reopen the gap.
    if (spans.some((s) => start < s.end && end > s.start)) continue;
    const path = resolveTerminalPath(p[0], baseDir);
    if (path) spans.push({ start, end, kind: 'file', text: p[0], path });
  }

  spans.sort((a, b) => a.start - b.start);
  const out = [];
  let at = 0;
  for (const s of spans) {
    if (s.start > at) out.push({ kind: 'text', text: src.slice(at, s.start) });
    const { start, end, ...seg } = s;
    out.push(seg);
    at = end;
  }
  if (at < src.length) out.push({ kind: 'text', text: src.slice(at) });
  return out.length ? out : [{ kind: 'text', text: src }];
}

// The HTML half, for markdown-it renderer rules. `escapeHtml` is injected
// (md.utils.escapeHtml) so this module stays dependency-free, and EVERY segment
// goes through it — the markup here is built by this function alone, so nothing
// from the transcript can reach the output unescaped.
export function linkedHtml(text, { baseDir = null, urls = false, escapeHtml } = {}) {
  return linkSegments(text, { baseDir, urls }).map((seg) => {
    if (seg.kind === 'url') {
      return `<a href="${escapeHtml(seg.href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(seg.text)}</a>`;
    }
    if (seg.kind === 'file') {
      // A href-less <a role="button" tabindex="0">, not a <button>: there is no
      // URL that opens the preview modal, but a real <button> is an ATOMIC inline
      // box — verified in Chrome, which coerces `display: inline` on it straight
      // back to inline-block — so a long path that wraps internally pushes the
      // text after it onto a fresh line. The role and tabindex are what a bare
      // href-less <a> lacks: without them it is neither focusable nor announced.
      // The title is where the link goes, which the label often doesn't say — a
      // markdown link shows prose, and a relative path hides which repo it is in.
      return `<a class="${MD_LINK_CLASS}" role="button" tabindex="0" data-md-path="${escapeHtml(seg.path)}" title="${escapeHtml(seg.path)}">${escapeHtml(seg.text)}</a>`;
    }
    return escapeHtml(seg.text);
  }).join('');
}
