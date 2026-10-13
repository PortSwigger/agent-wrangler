// Image paste and drop for the agent terminal. Cmd+V of an image into xterm used
// to do nothing: xterm only ever reads text/plain, and the agent's own image
// paste reads the HOST clipboard, which this page cannot reach. So the terminal
// takes the composer's route — upload, the server writes the file into the
// session's pastes dir — except that with no composer to hold a chip, the server
// also pastes the path into the live pane (paste-image's `intoPane`), where the
// TUI turns it into `[Image #N]` at the cursor.
//
// The listeners are on the terminal's container in the CAPTURE phase, so they
// run before xterm's own paste handlers on its textarea; stopping the event there
// is what keeps xterm from also typing the clipboard's text. A paste with no
// image is left alone and xterm handles it exactly as before.

import { imageSources, sourceToFrame, MAX_IMAGES_PER_PASTE } from './clipboard-images.js';

// A reply that never comes (the control socket dropped mid-paste) must not wedge
// the images queued behind it.
const REPLY_TIMEOUT_MS = 30_000;

export function createTerminalImagePaste({ send, toast, frameOf = sourceToFrame, timeoutMs = REPLY_TIMEOUT_MS }) {
  // Its own token namespace, so the reply can never be mistaken for one of the
  // chat view's era-stamped tokens.
  let seq = 0;
  const pending = new Map(); // token → resolve

  function take(e, dt, { sessionId, pasteText }) {
    const { sources, text } = imageSources(dt);
    if (!sources.length) return;
    e.preventDefault();
    e.stopPropagation();
    if (text) pasteText(text);
    const chosen = sources.slice(0, MAX_IMAGES_PER_PASTE);
    if (sources.length > chosen.length) toast(`Pasting ${chosen.length} images — ${sources.length - chosen.length} more were skipped.`, false);
    // One at a time, each waiting for the previous reply: the control socket
    // does not await its handlers, so firing them together could land the
    // images in the pane out of the order they were copied.
    (async () => {
      for (const source of chosen) {
        let frame;
        try { frame = await frameOf(source); } catch (err) { toast(err?.message || 'Could not read that image.', true); continue; }
        const token = `term#${++seq}`;
        const replied = new Promise((resolve) => {
          pending.set(token, resolve);
          setTimeout(() => { if (pending.delete(token)) resolve(); }, timeoutMs);
        });
        if (!send({ type: 'paste-image', sessionId, token, intoPane: true, ...frame })) {
          pending.delete(token);
          toast('Not connected to the wrangler — try again in a moment.', true);
          return;
        }
        await replied;
      }
    })();
  }

  // Returns the detach function closeTerminal calls.
  function attach(el, { sessionId, pasteText }) {
    const opts = { sessionId, pasteText };
    const onPaste = (e) => take(e, e.clipboardData, opts);
    // Without cancelling dragover a dropped file is opened by the browser,
    // replacing the whole board with the image.
    const onDragOver = (e) => { if (Array.from(e.dataTransfer?.types || []).includes('Files')) e.preventDefault(); };
    const onDrop = (e) => take(e, e.dataTransfer, opts);
    el.addEventListener('paste', onPaste, true);
    el.addEventListener('dragover', onDragOver);
    el.addEventListener('drop', onDrop);
    return () => {
      el.removeEventListener('paste', onPaste, true);
      el.removeEventListener('dragover', onDragOver);
      el.removeEventListener('drop', onDrop);
    };
  }

  // True when the reply was ours. Success needs no word: the `[Image #N]` it
  // put in the pane is the confirmation.
  function onResult(msg) {
    const resolve = pending.get(msg.token);
    if (!resolve) return false;
    pending.delete(msg.token);
    if (!msg.ok) toast(msg.error || 'Could not paste that image.', true);
    resolve();
    return true;
  }

  return { attach, onResult };
}
