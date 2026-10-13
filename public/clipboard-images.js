// Finds the images in a paste or a drop and turns each into the
// { mime, dataBase64 } frame the server's paste-image handler accepts. Shared by
// the chat composer and the terminal pane so the two cannot disagree about what
// counts as an image.
//
// What each copy source actually puts in a ClipboardEvent, logged in Chrome 152
// on macOS before any of this was written:
//  - Finder file copy (and a Finder drop): types ['Files'], one kind:'file' item
//    per file, typed from the extension — image/png, image/heic, image/tiff,
//    image/bmp. An unknown extension arrives with an empty type.
//  - A bitmap clipboard (screenshot to clipboard, Preview's Copy, Copy Image in
//    Chrome or Slack): Chromium re-encodes it as a single image/png file item,
//    even when the pasteboard only held TIFF.
//  - A selection containing an image, or an app that copies markup only: no file
//    at all, just text/html with an <img src> (data: or http) and a text/plain
//    that may be empty.
//  - A data: URL copied as text: text/plain only.
// Chromium cannot decode HEIC or TIFF (createImageBitmap rejects both), so those
// two are the only formats sent raw for the server to convert; everything else
// the browser can draw is re-encoded to PNG here.

// Bounded per paste. A clipboard can hold a whole screenshot burst, and each one
// costs a base64 frame plus a file, so a slip is capped rather than unbounded —
// the human can always paste again.
export const MAX_IMAGES_PER_PASTE = 4;

// Stored by the server exactly as sent.
const STORED_AS_IS = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
// Converted by the server, and only because the browser cannot draw them.
const SERVER_CONVERTS = new Set(['image/heic', 'image/heif', 'image/tiff']);

// For files whose type the OS left empty. Finder types the common ones itself, so
// this is the fallback, not the main path.
const MIME_BY_EXT = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  heic: 'image/heic', heif: 'image/heif', tif: 'image/tiff', tiff: 'image/tiff',
  bmp: 'image/bmp', avif: 'image/avif', ico: 'image/x-icon',
};

// SVG is excluded on purpose: it is text, and pasting an .svg is as likely to
// mean "here is the markup" as "here is a picture".
export function imageMimeOf(file) {
  const type = typeof file?.type === 'string' ? file.type.toLowerCase() : '';
  if (type.startsWith('image/')) return type === 'image/svg+xml' ? null : type;
  const ext = /\.([a-z0-9]+)$/i.exec(file?.name || '')?.[1]?.toLowerCase();
  return (ext && MIME_BY_EXT[ext]) || null;
}

const DATA_IMAGE_RE = /^data:image\/[a-z0-9.+-]+(?:;[a-z0-9=.+-]+)*;base64,[a-z0-9+/=\s]+$/i;

// Only srcs this page can actually read: data: is self-contained and http(s) is
// fetched by the BROWSER (never the server). blob:, file: and anything else
// belongs to another page or the disk and cannot be reached from here.
function readableSrc(src) {
  const s = src.trim();
  if (DATA_IMAGE_RE.test(s)) return s;
  return /^https?:\/\//i.test(s) ? s : null;
}

const decodeAttr = (s) => s
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&amp;/g, '&');

// The srcs of every <img> in clipboard markup. A regex rather than DOMParser so it
// runs under node --test; the markup is only ever mined for src strings, never
// rendered or inserted, so a miss costs an attachment and nothing else.
export function imgSrcsFromHtml(html) {
  if (typeof html !== 'string' || !html) return [];
  const out = [];
  const re = /<img\b[^>]*?\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  let m;
  while ((m = re.exec(html))) {
    const src = readableSrc(decodeAttr(m[1] ?? m[2] ?? m[3] ?? ''));
    if (src && !out.includes(src)) out.push(src);
  }
  return out;
}

// What a DataTransfer (clipboardData or a drop's dataTransfer) holds in the way
// of images, in the order to try them:
//   files — real image files, which win whenever there is one, because the
//           markup that often rides alongside (Copy Image) describes the same
//           picture and would attach it twice;
//   urls  — <img> srcs from text/html, then a lone data: URL pasted as text;
//   text  — the plain text that should still land as text when the images came
//           from markup ('' when the text WAS the image).
// `sources` is empty when nothing here is an image, and the caller must then let
// the event through untouched so an ordinary text paste keeps working.
export function imageSources(dt) {
  if (!dt) return { sources: [], text: '' };
  const fromFiles = Array.from(dt.files || []);
  const fromItems = fromFiles.length ? [] : Array.from(dt.items || [])
    .filter((it) => it.kind === 'file')
    .map((it) => it.getAsFile?.())
    .filter(Boolean);
  const files = [...fromFiles, ...fromItems]
    .map((file) => ({ kind: 'file', file, mime: imageMimeOf(file) }))
    .filter((s) => s.mime);
  const text = dt.getData?.('text/plain') || '';
  if (files.length) return { sources: files, text: '' };

  const urls = imgSrcsFromHtml(dt.getData?.('text/html') || '');
  if (urls.length) return { sources: urls.map((url) => ({ kind: 'url', url })), text: text.trim() ? text : '' };
  // A drop from another tab carries the image's address in text/uri-list.
  const uri = (dt.getData?.('text/uri-list') || '').split(/\r?\n/).find((l) => l && !l.startsWith('#'));
  if (uri && DATA_IMAGE_RE.test(uri.trim())) return { sources: [{ kind: 'url', url: uri.trim() }], text: '' };
  if (DATA_IMAGE_RE.test(text.trim())) return { sources: [{ kind: 'url', url: text.trim() }], text: '' };
  return { sources: [], text };
}

// Chunked so a 10 MB image does not blow the argument limit of fromCharCode.
export function bytesToBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

async function blobToFrame(blob, mime) {
  return { mime, dataBase64: bytesToBase64(new Uint8Array(await blob.arrayBuffer())) };
}

// Draws the image and re-encodes it as PNG. Null when the browser cannot decode
// the format (HEIC and TIFF in Chromium), which is the caller's cue to fall back.
export async function browserToPng(blob) {
  let bmp;
  try { bmp = await createImageBitmap(blob); } catch { return null; }
  try {
    if (typeof OffscreenCanvas === 'function') {
      const canvas = new OffscreenCanvas(bmp.width, bmp.height);
      canvas.getContext('2d').drawImage(bmp, 0, 0);
      return await canvas.convertToBlob({ type: 'image/png' });
    }
    const canvas = document.createElement('canvas');
    canvas.width = bmp.width;
    canvas.height = bmp.height;
    canvas.getContext('2d').drawImage(bmp, 0, 0);
    return await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  } finally {
    bmp.close?.();
  }
}

// One source → one upload frame, or a thrown Error whose message is shown to the
// human as is. `fetchImpl` and `toPng` are seams for the tests.
export async function sourceToFrame(source, { fetchImpl = globalThis.fetch, toPng = browserToPng } = {}) {
  let blob;
  let mime;
  if (source.kind === 'file') {
    blob = source.file;
    mime = source.mime;
  } else {
    const isData = source.url.startsWith('data:');
    let res;
    try {
      // No cookies: the page is fetching on the human's behalf, and a site that
      // only serves the image with credentials is one we should not be replaying
      // them to. CORS still applies, which is why this can fail.
      res = await fetchImpl(source.url, isData ? undefined : { mode: 'cors', credentials: 'omit' });
    } catch {
      throw new Error(isData ? 'Could not read that image.' : 'That site does not let other pages download its images — use Copy Image, or save it and paste the file.');
    }
    if (!res.ok) throw new Error(`Could not download that image (HTTP ${res.status}).`);
    blob = await res.blob();
    mime = imageMimeOf(blob) || '';
  }
  if (STORED_AS_IS.has(mime)) return blobToFrame(blob, mime);
  const png = await toPng(blob);
  if (png) return blobToFrame(png, 'image/png');
  if (SERVER_CONVERTS.has(mime)) return blobToFrame(blob, mime);
  throw new Error('That image format cannot be pasted — PNG, JPEG, GIF, WebP, HEIC, TIFF and BMP can.');
}
