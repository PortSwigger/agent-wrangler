import path from 'node:path';

// Validation and naming for an image pasted into the chat composer. Pure and
// fs-free (the caller does the writing) so it unit-tests without touching disk,
// the same split file-preview.js uses for GET /file.
//
// Why a file at all: Claude Code's own Cmd+V image paste reads the HOST
// clipboard, so it is unreachable from a browser — the bytes are in the page, not
// on the machine running the pane. Writing them to a file the agent is ALREADY
// allowed to read and putting that path in the prompt is what bridges the gap.
// Verified against a real Claude TUI: a path pasted inside prompt text is
// auto-attached as an inline image (the composer rewrites it to `[Image #1]` and
// the transcript carries a real base64 `image` block), with no Read tool call and
// no permission prompt. That is why the destination has to be inside the
// session's `--add-dir` and nowhere else.

// mime → extension. A fixed map, never string surgery on the client-supplied
// mime: it is untrusted input that would otherwise reach a filename.
const EXT_BY_MIME = new Map([
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
  ['image/gif', 'gif'],
  ['image/webp', 'webp'],
]);

// Generous, because the agent — not the wrangler — decides what is too big to
// send (Claude Code downscales oversized images itself). This cap exists to stop
// a runaway or hostile frame filling the disk, not to second-guess the model.
export const MAX_PASTE_BYTES = 10 * 1024 * 1024;

// Magic-byte sniff, so a frame claiming image/png cannot land an arbitrary
// payload on disk under a .png name. Cheap, and the only check that looks at
// what the bytes ARE rather than what the sender says they are.
function sniff(buf) {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length >= 6 && buf.subarray(0, 6).toString('latin1').match(/^GIF8[79]a$/)) return 'gif';
  if (buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  return null;
}

// Returns { bytes, ext } or { error }. `error` is a sentence shown to the human,
// so it says what to do rather than naming a field.
export function decodePasteImage({ mime, dataBase64 } = {}) {
  const ext = EXT_BY_MIME.get(typeof mime === 'string' ? mime.toLowerCase().trim() : '');
  if (!ext) return { error: 'Only PNG, JPEG, GIF and WebP images can be pasted.' };
  if (typeof dataBase64 !== 'string' || !dataBase64) return { error: 'The pasted image was empty.' };
  // Length-checked BEFORE decoding: base64 is 4/3 of the payload, so this refuses
  // an oversized frame without first materialising it as a Buffer.
  if (Math.floor(dataBase64.length * 3 / 4) > MAX_PASTE_BYTES) return { error: 'That image is over 10 MB.' };
  let bytes;
  try {
    bytes = Buffer.from(dataBase64, 'base64');
  } catch {
    return { error: 'The pasted image could not be decoded.' };
  }
  if (!bytes.length) return { error: 'The pasted image was empty.' };
  if (bytes.length > MAX_PASTE_BYTES) return { error: 'That image is over 10 MB.' };
  // The sniffed type wins over the claimed one, so the extension always describes
  // the actual bytes. A mismatch is a refusal rather than a silent rename: it
  // means the frame was wrong about itself, and guessing is how you end up with a
  // file the agent cannot read.
  const actual = sniff(bytes);
  if (!actual) return { error: 'That does not look like an image file.' };
  if (actual !== ext) return { error: `That file is a ${actual.toUpperCase()}, not a ${ext.toUpperCase()}.` };
  return { bytes, ext };
}

// Flat, sortable and collision-proof without a stat: the millisecond keeps
// pastes in order for a human browsing the folder, the random suffix keeps two
// pastes in the same millisecond apart.
export function pasteFileName(ext, { now, rand }) {
  return `paste-${now}-${rand}.${ext}`;
}

// The gate that keeps a client-supplied value from ever becoming a path. The
// composer sends back only the NAME it was given, never a path, so a frame can
// name a file inside the session's own pastes dir and nothing else — no
// traversal, no absolute path, no pointing the agent at an arbitrary file it
// would then read into its context. Anchored, and the shape is exactly what
// pasteFileName produces.
const PASTE_NAME_RE = /^paste-\d{1,20}-[a-f0-9]{4,32}\.(?:png|jpg|gif|webp)$/;
export function isPasteFileName(name) {
  return typeof name === 'string' && PASTE_NAME_RE.test(name);
}

// A mis-paste is cheap to undo, so the cap is about bounding one submit, not
// policing the human. Matches the client's own per-paste cap.
export const MAX_ATTACHMENTS_PER_MESSAGE = 8;

// A paste is consumed the moment the prompt is sent, so nothing needs these for
// long — but the file must outlive the send, and a session can be resumed days
// later with the path still sitting in its composer. A week is the compromise.
// Age-based rather than count-based so a burst of pastes in one turn all survive.
export const PASTE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Best-effort: every failure is swallowed per entry, because pruning is
// housekeeping on the write path and must never be the reason a paste fails.
export function prunePastes(dir, { now, readdirSync, statSync, rmSync, ttlMs = PASTE_TTL_MS }) {
  let names;
  try { names = readdirSync(dir); } catch { return 0; }
  let removed = 0;
  for (const name of names) {
    // Scoped to our own filenames so a file a human dropped in this folder is
    // never deleted by us.
    if (!/^paste-\d+-[a-z0-9]+\.(?:png|jpg|gif|webp)$/.test(name)) continue;
    const full = path.join(dir, name);
    try {
      if (now - statSync(full).mtimeMs <= ttlMs) continue;
      rmSync(full, { force: true });
      removed += 1;
    } catch { /* raced with another prune, or unreadable: leave it */ }
  }
  return removed;
}
