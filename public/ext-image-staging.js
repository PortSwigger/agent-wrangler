// `api.images.stage(source)` for extensions: upload one image in paste-image's
// `staged` mode and resolve with the server-minted NAME, the same thing the
// dispatch dialog's intent box holds. The extension never sees a path; a later
// `host.sessions.spawn({ images })` (or `host.images.keep`) takes the name.
// Replies are matched by token, since the control socket does not order them.
// A successful upload also keeps its bytes, by name, for the dispatch dialog to
// take (takeBlob) when the name is handed to it, so its chip can show a
// thumbnail. Only the last few wait: a name the dialog never sees costs nothing
// past that, and no object URL exists until the dialog takes it.

import { sourceToFrame, imageMimeOf } from './clipboard-images.js';
import { frameToBlob } from './staged-previews.js';

const REPLY_TIMEOUT_MS = 30_000;
// Matches the dialog's attachment cap: one openDispatch's worth.
const MAX_WAITING_BLOBS = 8;

export function createExtImageStaging({ send, frameOf = sourceToFrame, timeoutMs = REPLY_TIMEOUT_MS }) {
  let seq = 0;
  const pending = new Map(); // token → { resolve, reject, timer, blob }
  const waiting = new Map(); // name → Blob, oldest first

  function settle(token) {
    const p = pending.get(token);
    if (p) { clearTimeout(p.timer); pending.delete(token); }
    return p;
  }

  return {
    // A File/Blob → { name }. Rejects with a message fit to show the human.
    async stage(file) {
      const mime = imageMimeOf(file);
      if (!mime) throw new Error(`${file?.name || 'That file'} is not an image.`);
      const frame = await frameOf({ kind: 'file', file, mime });
      const token = `ext#${++seq}`;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { if (settle(token)) reject(new Error('The wrangler did not answer the upload.')); }, timeoutMs);
        pending.set(token, { resolve, reject, timer, blob: frameToBlob(frame) });
        if (!send({ type: 'paste-image', staged: true, token, ...frame })) {
          settle(token);
          reject(new Error('Not connected to the wrangler — try again in a moment.'));
        }
      });
    },
    // The uploaded bytes for a name this staged, handed over once; null if
    // unknown, undrawable, or already taken or dropped.
    takeBlob(name) {
      const blob = waiting.get(name) ?? null;
      waiting.delete(name);
      return blob;
    },
    // True when the reply was ours.
    onResult(msg) {
      if (!String(msg.token || '').startsWith('ext#')) return false;
      const p = settle(msg.token);
      if (!p) return true;
      if (msg.ok) {
        if (p.blob) {
          waiting.set(msg.name, p.blob);
          while (waiting.size > MAX_WAITING_BLOBS) waiting.delete(waiting.keys().next().value);
        }
        p.resolve({ name: msg.name });
      }
      else p.reject(new Error(msg.error || 'Could not attach that image.'));
      return true;
    },
  };
}
