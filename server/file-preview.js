import path from 'node:path';

// Pure path validation for GET /file. fs functions are injected so this unit
// tests without touching disk; server/index.js passes the real ones. Returns an
// HTTP status + (on 200) the resolved real path — the caller reads the bytes.
export function expandHome(p, homedir) {
  if (p === '~') return homedir;
  if (p.startsWith('~/')) return path.join(homedir, p.slice(2));
  return p;
}

export function isMarkdownPath(p) {
  return /\.(?:md|markdown)$/i.test(p);
}

// realpath BEFORE the extension check: a symlink named foo.md pointing at a
// non-markdown target must be rejected (and vice-versa), so the .md gate is
// only meaningful against the resolved target.
export function resolveMarkdownPath(raw, { homedir, realpathSync, statSync, maxBytes }) {
  if (typeof raw !== 'string' || !raw) return { status: 400, message: 'missing path' };
  const expanded = expandHome(raw, homedir);
  if (!path.isAbsolute(expanded)) return { status: 400, message: 'path must be absolute' };
  let real;
  try { real = realpathSync(expanded); } catch { return { status: 404, message: 'not found' }; }
  if (!isMarkdownPath(real)) return { status: 415, message: 'not a markdown file' };
  let st;
  try { st = statSync(real); } catch { return { status: 404, message: 'not found' }; }
  if (!st.isFile()) return { status: 415, message: 'not a markdown file' };
  if (st.size > maxBytes) return { status: 413, message: 'file too large' };
  return { status: 200, path: real };
}
