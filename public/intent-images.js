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
// which would clip a position:fixed child or become its containing block — and
// where its Escape and scroll listeners go. `adoptBlob(name)` hands over the
// bytes of a name staged elsewhere (ext-image-staging's takeBlob), so a preview
// is only made for a name that actually reaches the dialog.
export function createIntentImages({ input, listEl, send, toast, enabled = () => true, frameOf = sourceToFrame, document: doc = globalThis.document, previews = null, previewHost = null, adoptBlob = () => null }) {
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
  // reset() revokes them all, since after a reset none is attached — except the
  // `keep` names an open is about to adopt again. reset() runs on open and right
  // AFTER a launch is sent; the launch carries names only, so nothing it needs
  // is revoked. Anything else is left to the bounded map's eviction.
  const shown = new Set();
  const popover = createPreviewPopover(doc, previewHost);
  // Capture phase on the dialog, so an open preview takes the first Escape
  // wherever focus is. The dialog's own Escape (a bubbling window binding) is
  // never reached then; with no preview open, nothing is stopped.
  previewHost?.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && popover.isOpen()) { e.preventDefault(); e.stopPropagation(); popover.hide(); }
  }, true);

  function thumbnail(url, alt) {
    const img = doc.createElement('img');
    img.className = 'chat-attachment-thumb';
    img.src = url;
    img.alt = alt;
    img.tabIndex = 0;
    // Open while hovered OR focused; it closes only when neither holds.
    let hovered = false;
    let focused = false;
    const show = () => popover.show(img, url, alt);
    const settle = () => { if (!hovered && !focused) popover.hide(img); };
    // An evicted entry's URL is dead; fall back to the plain chip.
    img.addEventListener('error', () => { popover.hide(img); img.remove?.(); });
    img.addEventListener('mouseenter', () => { hovered = true; show(); });
    img.addEventListener('mouseleave', () => { hovered = false; settle(); });
    img.addEventListener('focus', () => { focused = true; show(); });
    img.addEventListener('blur', () => { focused = false; settle(); });
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
    // `keep`: names whose previews survive, because the caller is about to
    // adopt them again (a reopen with api.openDispatch's images).
    reset({ keep = [] } = {}) {
      for (const name of shown) if (!keep.includes(name)) previews?.forget(name);
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
      for (const name of chosen) if (previews && !previews.urlFor(name)) previews.remember(name, adoptBlob(name));
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
// the hover that keeps it open. A scroll inside the dialog or a window resize
// would leave it pointing at nothing, so either one closes it.
function createPreviewPopover(doc, host) {
  let el = null;
  let anchor = null;
  const MARGIN = 8;
  const win = () => doc.defaultView || globalThis;

  function place() {
    if (!el || !anchor) return;
    const a = anchor.getBoundingClientRect();
    const { width, height } = el.getBoundingClientRect();
    const vw = win().innerWidth;
    const vh = win().innerHeight;
    const below = vh - a.bottom;
    const top = below >= height + MARGIN || below >= a.top ? a.bottom + MARGIN / 2 : a.top - height - MARGIN / 2;
    const left = Math.min(Math.max(MARGIN, a.left), Math.max(MARGIN, vw - width - MARGIN));
    el.style.top = `${Math.max(MARGIN, Math.min(top, vh - height - MARGIN))}px`;
    el.style.left = `${left}px`;
  }

  // `from` (optional): only close if the preview still belongs to that thumbnail.
  function hide(from) {
    if (!el || (from && from !== anchor)) return;
    host?.removeEventListener('scroll', onAway, true);
    win().removeEventListener?.('resize', onAway);
    el.remove();
    el = null;
    anchor = null;
  }
  const onAway = () => hide();

  return {
    isOpen: () => Boolean(el),
    show(target, url, alt) {
      const parent = host || doc.body;
      if (!parent || typeof target.getBoundingClientRect !== 'function') return;
      if (anchor === target && el) return;
      hide();
      anchor = target;
      el = doc.createElement('div');
      el.className = 'chat-attachment-preview';
      el.setAttribute('role', 'tooltip');
      const img = doc.createElement('img');
      img.src = url;
      img.alt = alt;
      // Its size is only known once decoded; place again then.
      img.addEventListener('load', place);
      img.addEventListener('error', onAway);
      el.appendChild(img);
      parent.appendChild(el);
      host?.addEventListener('scroll', onAway, true);
      win().addEventListener?.('resize', onAway);
      place();
    },
    hide,
  };
}
