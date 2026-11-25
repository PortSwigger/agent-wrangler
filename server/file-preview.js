import path from 'node:path';
import { fileTypeOf } from '../public/file-types.js';

// Pure path validation for the session.file action and the show_image tool. fs
// functions are injected so this unit tests without touching disk; the callers
// pass the real ones. Returns an HTTP status + (on 200) the resolved real path —
// the caller reads the bytes.
export function expandHome(p, homedir) {
  if (p === '~') return homedir;
  if (p.startsWith('~/')) return path.join(homedir, p.slice(2));
  return p;
}

export function isMarkdownPath(p) {
  return fileTypeOf(p)?.kind === 'markdown';
}

export function isImagePath(p) {
  return fileTypeOf(p)?.kind === 'image';
}

// realpath BEFORE the extension check: a symlink named foo.md pointing at a
// non-markdown target must be rejected (and vice-versa), so the .md gate is
// only meaningful against the resolved target.
function resolveKindPath(raw, kind, notKind, { homedir, realpathSync, statSync, maxBytes }) {
  if (typeof raw !== 'string' || !raw) return { status: 400, message: 'missing path' };
  const expanded = expandHome(raw, homedir);
  if (!path.isAbsolute(expanded)) return { status: 400, message: 'path must be absolute' };
  let real;
  try { real = realpathSync(expanded); } catch { return { status: 404, message: 'not found' }; }
  if (fileTypeOf(real)?.kind !== kind) return { status: 415, message: notKind };
  let st;
  try { st = statSync(real); } catch { return { status: 404, message: 'not found' }; }
  if (!st.isFile()) return { status: 415, message: notKind };
  if (st.size > maxBytes) return { status: 413, message: 'file too large', size: st.size };
  return { status: 200, path: real };
}

export function resolveMarkdownPath(raw, deps) {
  return resolveKindPath(raw, 'markdown', 'not a markdown file', deps);
}

// The same gate for a raster image (.png, .jpg/.jpeg, .gif, .webp). The
// extension is all this checks; the caller sniffs the bytes it reads.
export function resolveImagePath(raw, deps) {
  return resolveKindPath(raw, 'image', 'not a PNG, JPEG, GIF or WebP file', deps);
}
