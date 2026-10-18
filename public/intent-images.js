// Image paste and drop for the dispatch dialog's intent box. There is no session
// yet, so an image is uploaded in paste-image's `staged` mode and held as the
// server-minted NAME the composer would hold; the dispatch carries those names
// and the server claims the files into the new session and pastes them into its
// first prompt (dispatch-runner.js). Same chip markup and classes as the chat
// composer's attachments, so the two look alike.
//
// A chip whose image this page uploaded (here or via api.images.stage) also gets
// a thumbnail, with a larger preview on hover or focus. Both come from the
// browser's own copy (staged-previews.js); the server never serves them back.

import { imageSources, sourceToFrame, MAX_IMAGES_PER_PASTE } from './clipboard-images.js';
import { frameToBlob } from './staged-previews.js';

// The server keeps at most this many per message (MAX_ATTACHMENTS_PER_MESSAGE).
const MAX_ATTACHMENTS = 8;

// `previews` (optional) is the shared staged-previews map; `previewHost` is where
// the hover preview is mounted — outside any scrolling or backdrop-filtered card,
// which would clip a position:fixed child or become its containing block.
export function createIntentImages({ input, listEl, send, toast, enabled = () => true, frameOf = sourceToFrame, document: doc = globalThis.document, previews = null, previewHost = null }) {
  let names = [];
  let seq = 0;
  // Bumped on reset, so an upload that finishes after the dialog closed or was
  // reopened is dropped instead of attaching to the next dispatch.
  let era = 0;
  const pending = new Set();
  // token → the uploaded bytes as a Blob, remembered as a preview on success.
  const blobs = new Map();
  // Preview lifetime: every name that has had a chip since the last reset. A
  // removed chip keeps its URL (an extension may adopt the same name again), and
  // reset() revokes them all, since after a reset none is attached. reset() runs
  // on open and right AFTER a launch is sent; the launch carries names only, so
  // nothing it needs is revoked. Names staged but never shown here are left to
  // the bounded map's eviction.
  const shown = new Set();
  const popover = createPreviewPopover(doc, previewHost);

  function thumbnail(url, alt) {
    const img = doc.createElement('img');
    img.className = 'chat-attachment-thumb';
    img.src = url;
    img.alt = alt;
    img.tabIndex = 0;
    // An evicted entry's URL is dead; fall back to the plain chip.
    img.addEventListener('error', () => { popover.hide(); img.remove?.(); });
    img.addEventListener('mouseenter', () => popover.show(img, url, alt));
    img.addEventListener('mouseleave', () => popover.hide());
    img.addEventListener('focus', () => popover.show(img, url, alt));
    img.addEventListener('blur', () => popover.hide());
    // Escape closes the preview first; with no preview open it reaches the
    // dialog's own Escape binding and cancels as usual.
    img.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && popover.isOpen()) { e.preventDefault(); e.stopPropagation(); popover.hide(); }
    });
    return img;
  }

  function render() {
    popover.hide();
    listEl.hidden = !names.length;
    listEl.textContent = '';
    names.forEach((name, i) => {
      shown.add(name);
      const chip = doc.createElement('span');
      chip.className = 'chat-attachment';
      const url = previews?.urlFor(name);
      if (url) chip.appendChild(thumbnail(url, `Image #${i + 1}`));
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

  function skipped(n) {
    if (n > 0) toast(`${n} image${n === 1 ? ' was' : 's were'} skipped — a first prompt holds ${MAX_ATTACHMENTS}.`, false);
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
    skipped(sources.length - chosen.length);
    for (const source of chosen) {
      const token = `dispatch#${era}#${++seq}`;
      pending.add(token);
      frameOf(source).then(
        (frame) => {
          if (!pending.has(token)) return;
          if (previews) blobs.set(token, frameToBlob(frame));
          if (!send({ type: 'paste-image', staged: true, token, ...frame })) {
            pending.delete(token);
            blobs.delete(token);
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
      for (const name of shown) previews?.forget(name);
      shown.clear();
      names = [];
      pending.clear();
      blobs.clear();
      era += 1;
      render();
    },
    // Attach names that are ALREADY staged (an extension's api.images.stage,
    // handed to api.openDispatch) as if they had just been pasted: same chips,
    // same cap. Call it after the open's reset(), which would otherwise drop them.
    adopt(list) {
      const incoming = [...new Set(list)].filter((n) => !names.includes(n));
      const chosen = incoming.slice(0, Math.max(0, MAX_ATTACHMENTS - names.length - pending.size));
      skipped(incoming.length - chosen.length);
      names.push(...chosen);
      render();
    },
    // True when the reply was ours.
    onResult(msg) {
      if (!String(msg.token || '').startsWith('dispatch#')) return false;
      if (!pending.delete(msg.token)) return true;
      const blob = blobs.get(msg.token);
      blobs.delete(msg.token);
      if (!msg.ok) { toast(msg.error || 'Could not attach that image.', true); return true; }
      previews?.remember(msg.name, blob);
      names.push(msg.name);
      render();
      return true;
    },
  };
}

// The larger hover/focus preview: one lightweight element, mounted on demand and
// positioned next to the thumbnail — below it, or above when there is more room
// there — and kept inside the viewport. pointer-events:none, so it never steals
// the hover that keeps it open.
function createPreviewPopover(doc, host) {
  let el = null;
  let anchor = null;
  const MARGIN = 8;

  function place() {
    if (!el || !anchor) return;
    const win = doc.defaultView || globalThis;
    const a = anchor.getBoundingClientRect();
    const { width, height } = el.getBoundingClientRect();
    const vw = win.innerWidth;
    const vh = win.innerHeight;
    const below = vh - a.bottom;
    const top = below >= height + MARGIN || below >= a.top ? a.bottom + MARGIN / 2 : a.top - height - MARGIN / 2;
    const left = Math.min(Math.max(MARGIN, a.left), Math.max(MARGIN, vw - width - MARGIN));
    el.style.top = `${Math.max(MARGIN, Math.min(top, vh - height - MARGIN))}px`;
    el.style.left = `${left}px`;
  }

  return {
    isOpen: () => Boolean(el),
    show(target, url, alt) {
      const parent = host || doc.body;
      if (!parent || typeof target.getBoundingClientRect !== 'function') return;
      if (anchor === target && el) return;
      this.hide();
      anchor = target;
      el = doc.createElement('div');
      el.className = 'chat-attachment-preview';
      el.setAttribute('role', 'tooltip');
      const img = doc.createElement('img');
      img.src = url;
      img.alt = alt;
      // Its size is only known once decoded; place again then.
      img.addEventListener('load', place);
      el.appendChild(img);
      parent.appendChild(el);
      place();
    },
    hide() {
      el?.remove();
      el = null;
      anchor = null;
    },
  };
}
