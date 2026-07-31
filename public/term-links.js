// A markdown-file path as it appears in terminal output, ending in .md /
// .markdown. Fed to a custom xterm link provider in openTerminal so paths
// linkify the same way URLs do. Kept DOM-free (the matcher half) so it unit
// tests like util.js. Three shapes, via the leading alternation:
//   - absolute   (/…)         — the `\/` branch
//   - home       (~/…)        — the `~` branch
//   - relative-with-a-dir     — the `[\w.\-]+\/` branch: one path segment then a
//     slash, so `docs/x.md`, `./notes.md`, `../plan.md`, `a/b/c.md` all match.
// A relative path is resolved against the session's cwd by resolveTerminalPath
// before it hits the server (which only accepts an absolute/home path).
//
// - The `[\w.\-]+\/` branch REQUIRES a slash, so a bare filename (`README.md`,
//   `foo.md` in prose) is deliberately NOT matched — a lone `word.md` is too
//   ambiguous to linkify. A directory separator is the "this is a path" signal.
// - Leading (?<![\w:/@~.]) stops a path being matched *inside* a URL
//   (https://x/y.md — every candidate slash is preceded by `:`/`/`/a word char)
//   or mid-token — a path must start at a token boundary. Known false positive:
//   a scheme-less host like `example.com/x.md` reads as a relative path and
//   resolves to `<cwd>/example.com/x.md` → a harmless 404 toast (dots are in the
//   segment class, so there's no way to tell it from a real relative path).
// - The body excludes whitespace and shell/markup delimiters so the match ends
//   at the token edge; because the extension is the end of the match, trailing
//   sentence punctuation (. , ) ] …) is naturally left out. Known limitation: a
//   path containing spaces is matched only up to the first space — an inherent
//   terminal-text ambiguity with no reliable delimiter.
// - Trailing (?!\.?\w) rejects .mdx and .md.bak (an extension followed by more
//   word chars) while still allowing a legit .md before a sentence period
//   (`/a/b.md.` → matches `/a/b.md`). A plain (?![\w.]) would wrongly reject the
//   sentence-period case, so the optional-dot form is required.
// Global flag: the link provider scans each logical line with exec() in a loop.
// Case-insensitive (i) too, so a `.MD` path still linkifies — matching the
// server, which validates the extension case-insensitively.
export function markdownPathRegex() {
  return /(?<![\w:/@~.])(?:~|\/|[\w.\-]+\/)[^\s"'`<>()[\]{}|]*\.(?:markdown|md)(?!\.?\w)/gi;
}

// Resolve a matched path to what the server's GET /file accepts (absolute or
// ~-home). Absolute/home pass through untouched; a relative match is joined onto
// baseDir (the session's cwd) — the server's realpath normalizes any ./ or ../
// segments, so a plain join is enough. A relative match with no baseDir (e.g. an
// unassigned scratch session with no cwd) returns null → the provider skips it
// rather than fabricate a wrong absolute path.
export function resolveTerminalPath(match, baseDir) {
  if (match[0] === '/' || match[0] === '~') return match;
  if (!baseDir) return null;
  return `${baseDir.replace(/\/+$/, '')}/${match}`;
}

// Test-facing convenience: all matches on one string.
export function findMarkdownPaths(text) {
  return (text || '').match(markdownPathRegex()) || [];
}

// xterm ILinkProvider: underlines .md paths in the pane and opens them on click.
// Registered alongside the URL WebLinksAddon in openTerminal. Uses a raw provider
// (not a second WebLinksAddon) because that addon rejects any match that isn't a
// valid `new URL()` — which every filesystem path is not. `baseDir` (the
// session's cwd) is where a relative match is resolved from; pass it through from
// openTerminal (may be undefined for a cwd-less session, which just disables
// relative links).
export function createMarkdownLinkProvider(term, onActivate, baseDir) {
  return {
    provideLinks(y, callback) {
      const buf = term.buffer.active;
      // Walk up to the first row of the logical line (continuation rows are isWrapped).
      let start = y;
      while (start > 1 && buf.getLine(start - 1)?.isWrapped) start--;
      // Build the line string + a coord for each string char (1-based x/y).
      let text = '';
      const coords = [];
      for (let row = start; ; row++) {
        const line = buf.getLine(row - 1);
        if (!line) break;
        if (row !== start && !line.isWrapped) break;
        for (let col = 0; col < term.cols; col++) {
          const c = line.getCell(col);
          if (!c || c.getWidth() === 0) continue; // skip the empty tail cell of a wide char
          const str = c.getChars() || ' ';
          for (let k = 0; k < str.length; k++) { text += str[k]; coords.push({ x: col + 1, y: row }); }
        }
      }
      const rex = markdownPathRegex();
      const links = [];
      let m;
      while ((m = rex.exec(text))) {
        const s = coords[m.index];
        const e = coords[m.index + m[0].length - 1];
        if (!s || !e) continue;
        const uri = resolveTerminalPath(m[0], baseDir);
        if (!uri) continue; // relative match with no cwd to resolve against
        links.push({
          text: m[0],
          range: { start: { x: s.x, y: s.y }, end: { x: e.x, y: e.y } },
          activate: () => onActivate(uri),
        });
      }
      callback(links.length ? links : undefined);
    },
  };
}
