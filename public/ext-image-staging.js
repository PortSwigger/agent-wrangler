// `api.images.stage(source)` for extensions: upload one image in paste-image's
// `staged` mode and resolve with the server-minted NAME, the same thing the
// dispatch dialog's intent box holds. The extension never sees a path; a later
// `host.sessions.spawn({ images })` (or `host.images.keep`) takes the name.
// Replies are matched by token, since the control socket does not order them.

import { sourceToFrame, imageMimeOf } from './clipboard-images.js';

const REPLY_TIMEOUT_MS = 30_000;

export function createExtImageStaging({ send, frameOf = sourceToFrame, timeoutMs = REPLY_TIMEOUT_MS }) {
  let seq = 0;
  const pending = new Map(); // token → { resolve, reject, timer }

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
        pending.set(token, { resolve, reject, timer });
        if (!send({ type: 'paste-image', staged: true, token, ...frame })) {
          settle(token);
          reject(new Error('Not connected to the wrangler — try again in a moment.'));
        }
      });
    },
    // True when the reply was ours.
    onResult(msg) {
      if (!String(msg.token || '').startsWith('ext#')) return false;
      const p = settle(msg.token);
      if (!p) return true;
      if (msg.ok) p.resolve({ name: msg.name });
      else p.reject(new Error(msg.error || 'Could not attach that image.'));
      return true;
    },
  };
}
