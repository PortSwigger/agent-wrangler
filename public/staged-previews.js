// Browser-only previews for staged images. The server mints a NAME for each
// staged upload and deliberately has no route to read the file back (see
// chat-dom.js, "A chip, not a thumbnail"), so the only copy this page can show
// is the one it uploaded. Both upload paths — the dispatch dialog's paste/drop
// (intent-images.js) and an extension's api.images.stage (ext-image-staging.js)
// — remember that copy here as an object URL keyed by the minted name, and the
// dialog's chips look it up. A name with no entry just keeps the text-only chip.
//
// Bounded: past `max` entries the oldest is evicted and its URL revoked, so a
// board left open for days does not hold every image it ever staged.

// What a browser can draw as-is. HEIC and TIFF frames are sent raw for the
// server to convert (clipboard-images.js), and Chromium cannot draw them, so
// they get no preview rather than a broken one.
const DRAWABLE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

// The upload frame's bytes as a Blob, built from what was already read rather
// than reading the source again. Null for a format the page cannot draw.
export function frameToBlob(frame) {
  if (!frame || !DRAWABLE.has(frame.mime) || typeof frame.dataBase64 !== 'string') return null;
  try {
    const bin = atob(frame.dataBase64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: frame.mime });
  } catch {
    return null;
  }
}

export const MAX_PREVIEWS = 32;

export function createStagedPreviews({
  max = MAX_PREVIEWS,
  createObjectURL = (blob) => URL.createObjectURL(blob),
  revokeObjectURL = (url) => URL.revokeObjectURL(url),
} = {}) {
  const urls = new Map(); // name → object URL, oldest first

  function forget(name) {
    const url = urls.get(name);
    if (url === undefined) return;
    urls.delete(name);
    revokeObjectURL(url);
  }

  return {
    remember(name, blob) {
      if (!name || !blob) return;
      forget(name);
      urls.set(name, createObjectURL(blob));
      while (urls.size > max) forget(urls.keys().next().value);
    },
    urlFor: (name) => urls.get(name) ?? null,
    forget,
    size: () => urls.size,
  };
}
