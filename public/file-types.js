// The one extension → { kind, mime } table behind api.files.canOpen, api.files.types
// and the viewer panel. The server (host.files, GET /ext-file) imports this same
// module, so what the browser says it can open is what the server will read.
// mime is derived from the extension, never sniffed from the bytes. Pure and
// DOM-free so both halves can load it; extension-only, so no disk is touched.

const TYPES = Object.freeze({
  '.md': Object.freeze({ kind: 'markdown', mime: 'text/markdown' }),
  '.markdown': Object.freeze({ kind: 'markdown', mime: 'text/markdown' }),
  '.png': Object.freeze({ kind: 'image', mime: 'image/png' }),
  '.jpg': Object.freeze({ kind: 'image', mime: 'image/jpeg' }),
  '.jpeg': Object.freeze({ kind: 'image', mime: 'image/jpeg' }),
  '.gif': Object.freeze({ kind: 'image', mime: 'image/gif' }),
  '.webp': Object.freeze({ kind: 'image', mime: 'image/webp' }),
});

export const FILE_KIND_LIMITS = Object.freeze({ markdown: 2 * 1024 * 1024, image: 8 * 1024 * 1024 });

function extOf(p) {
  const base = p.slice(p.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot).toLowerCase() : '';
}

// { kind, mime } for a path's extension, or null (also for a non-string).
export function fileTypeOf(p) {
  if (typeof p !== 'string' || !p) return null;
  const ext = extOf(p);
  return Object.hasOwn(TYPES, ext) ? TYPES[ext] : null;
}

export function canOpenPath(p) {
  return fileTypeOf(p) !== null;
}

// A fresh list per call: [{ ext, kind, mime }].
export function fileTypes() {
  return Object.entries(TYPES).map(([ext, t]) => ({ ext, kind: t.kind, mime: t.mime }));
}
