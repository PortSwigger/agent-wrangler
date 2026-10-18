// Browser-only previews for staged images. The server mints a NAME for each
// staged upload and deliberately has no route to read the file back (see
// chat-dom.js, "A chip, not a thumbnail"), so the only copy this page can show
// is the one it uploaded. Both upload paths — the dispatch dialog's paste/drop
// (intent-images.js) and an extension's api.images.stage (ext-image-staging.js)
// — remember that copy here as an object URL keyed by the minted name, and the
// dialog's chips look it up. A name with no entry just keeps the text-only chip.
//
// Bounded twice: past `max` entries or `maxBytes` of blobs the oldest is evicted
// and its URL revoked, so a board left open for days does not hold every image
// it ever staged. A blob larger than the whole budget is simply not kept.

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
export const MAX_PREVIEW_BYTES = 64 * 1024 * 1024;

export function createStagedPreviews({
  max = MAX_PREVIEWS,
  maxBytes = MAX_PREVIEW_BYTES,
  createObjectURL = (blob) => URL.createObjectURL(blob),
  revokeObjectURL = (url) => URL.revokeObjectURL(url),
} = {}) {
  const entries = new Map(); // name → { url, size }, oldest first
  let total = 0;

  function forget(name) {
    const entry = entries.get(name);
    if (!entry) return;
    entries.delete(name);
    total -= entry.size;
    revokeObjectURL(entry.url);
  }

  return {
    remember(name, blob) {
      if (!name || !blob) return;
      forget(name);
      const size = blob.size || 0;
      if (size > maxBytes) return;
      entries.set(name, { url: createObjectURL(blob), size });
      total += size;
      while (entries.size > max || total > maxBytes) forget(entries.keys().next().value);
    },
    urlFor: (name) => entries.get(name)?.url ?? null,
    forget,
    size: () => entries.size,
    bytes: () => total,
  };
}
