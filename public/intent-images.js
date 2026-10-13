// Image paste and drop for the dispatch dialog's intent box. There is no session
// yet, so an image is uploaded in paste-image's `staged` mode and held as the
// server-minted NAME the composer would hold; the dispatch carries those names
// and the server claims the files into the new session and pastes them into its
// first prompt (dispatch-runner.js). Same chip markup and classes as the chat
// composer's attachments, so the two look alike.

import { imageSources, sourceToFrame, MAX_IMAGES_PER_PASTE } from './clipboard-images.js';

// The server keeps at most this many per message (MAX_ATTACHMENTS_PER_MESSAGE).
const MAX_ATTACHMENTS = 8;

export function createIntentImages({ input, listEl, send, toast, enabled = () => true, frameOf = sourceToFrame, document: doc = globalThis.document }) {
  let names = [];
  let seq = 0;
  // Bumped on reset, so an upload that finishes after the dialog closed or was
  // reopened is dropped instead of attaching to the next dispatch.
  let era = 0;
  const pending = new Set();

  function render() {
    listEl.hidden = !names.length;
    listEl.textContent = '';
    names.forEach((name, i) => {
      const chip = doc.createElement('span');
      chip.className = 'chat-attachment';
      const label = doc.createElement('span');
      label.className = 'chat-attachment-label';
      label.textContent = `Image #${i + 1}`;
      chip.appendChild(label);
      const drop = doc.createElement('button');
      drop.type = 'button';
      drop.className = 'chat-attachment-drop';
      drop.setAttribute('aria-label', `Remove image ${i + 1}`);
      drop.setAttribute('title', 'Remove');
      drop.addEventListener('click', () => { names = names.filter((n) => n !== name); render(); });
      chip.appendChild(drop);
      listEl.appendChild(chip);
    });
  }

  function take(e, dt) {
    if (!enabled()) return;
    const { sources, text } = imageSources(dt);
    if (!sources.length) return;
    e.preventDefault();
    if (text) {
      input.setRangeText(text, input.selectionStart, input.selectionEnd, 'end');
      input.dispatchEvent(new Event('input'));
    }
    const room = Math.max(0, Math.min(MAX_IMAGES_PER_PASTE, MAX_ATTACHMENTS - names.length - pending.size));
    const chosen = sources.slice(0, room);
    if (sources.length > chosen.length) toast(`${sources.length - chosen.length} image${sources.length - chosen.length === 1 ? ' was' : 's were'} skipped — a first prompt holds ${MAX_ATTACHMENTS}.`, false);
    for (const source of chosen) {
      const token = `dispatch#${era}#${++seq}`;
      pending.add(token);
      frameOf(source).then(
        (frame) => {
          if (!pending.has(token)) return;
          if (!send({ type: 'paste-image', staged: true, token, ...frame })) {
            pending.delete(token);
            toast('Not connected to the wrangler — try again in a moment.', true);
          }
        },
        (err) => { if (pending.delete(token)) toast(err?.message || 'Could not read that image.', true); },
      );
    }
  }

  input.addEventListener('paste', (e) => take(e, e.clipboardData));
  input.addEventListener('dragover', (e) => {
    if (enabled() && Array.from(e.dataTransfer?.types || []).includes('Files')) e.preventDefault();
  });
  input.addEventListener('drop', (e) => take(e, e.dataTransfer));

  return {
    // The names to send with the dispatch, in chip order.
    names: () => names.slice(),
    // True while an upload is still in flight, so a launch can wait for it.
    busy: () => pending.size > 0,
    reset() {
      names = [];
      pending.clear();
      era += 1;
      render();
    },
    // True when the reply was ours.
    onResult(msg) {
      if (!String(msg.token || '').startsWith('dispatch#')) return false;
      if (!pending.delete(msg.token)) return true;
      if (!msg.ok) { toast(msg.error || 'Could not attach that image.', true); return true; }
      names.push(msg.name);
      render();
      return true;
    },
  };
}
