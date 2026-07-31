// A GitHub pull-request reference as it appears in terminal output ("PR #1027").
// Fed to a custom xterm link provider in openTerminal so it linkifies the same
// way URLs and .md paths do. Kept DOM-free (the matcher half) so it unit tests
// like term-links.js. owner/repo comes from the session's git remote
// (s.repoSlug, derived server-side); the PR number is the matched digits.
//
// - Requires the literal `PR #` prefix (uppercase). A bare `#123` is NOT matched
//   (too ambiguous), nor `PR#123` (no space).
// - Leading (?<![A-Za-z0-9]) stops matching "PR" that's the tail of a longer
//   token (e.g. `SUPR #5`) — the ref must start at a word boundary. The trailing
//   (?![A-Za-z0-9]) is the symmetric guard: `PR #12abc` isn't a clean ref, so it
//   matches nothing rather than linkifying a truncated wrong number `PR #12`.
// Global flag: the provider scans each logical line with exec() in a loop.
export function prRefRegex() {
  return /(?<![A-Za-z0-9])PR #(\d+)(?![A-Za-z0-9])/g;
}

// owner/repo slug + number → the github.com PR url.
export function prUrl(repoSlug, number) {
  return `https://github.com/${repoSlug}/pull/${number}`;
}

// Test-facing convenience: all PR refs (full matched text) on one string.
export function findPrRefs(text) {
  return (text || '').match(prRefRegex()) || [];
}

// xterm ILinkProvider: underlines "PR #N" refs and opens the PR on click.
// Registered alongside the URL WebLinksAddon + the .md path provider in
// openTerminal, and only when repoSlug is known. A raw provider (not a
// WebLinksAddon) because "PR #N" isn't a valid new URL(). onActivate receives
// the built url (openTerminal passes a window.open wrapper).
export function createPrLinkProvider(term, repoSlug, onActivate) {
  return {
    provideLinks(y, callback) {
      const buf = term.buffer.active;
      let start = y;
      while (start > 1 && buf.getLine(start - 1)?.isWrapped) start--;
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
      const rex = prRefRegex();
      const links = [];
      let m;
      while ((m = rex.exec(text))) {
        const s = coords[m.index];
        const e = coords[m.index + m[0].length - 1];
        if (!s || !e) continue;
        const uri = prUrl(repoSlug, m[1]);
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
