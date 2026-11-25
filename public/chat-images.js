// The chat stream's tool-result images: chat-dom.js builds each thumbnail as an
// empty button carrying the image's ref, and this fills it in and opens it full
// size.
//
// The bytes never come with the chat poll (see chat-scanner.js). Each image is
// fetched on its own, once its thumbnail nears the viewport, through the deck's
// session.chat-image action, which reads it back out of the transcript. A
// fetched image becomes one blob: URL, shared by every thumbnail of that ref and
// by the full-size view, and revoked when the stream is cleared.

export function base64ToBlob(data, type) {
  const bin = atob(data);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}

// `fetchImage(card, ref)` resolves the action's result ({ ok, data }); `currentCard()`
// is the card on screen, read when a fetch starts. `win` is a seam for the
// tests, which have no IntersectionObserver, URL.createObjectURL or <dialog>.
export function createChatImages({ stream, fetchImage, currentCard, document: doc = globalThis.document, win = globalThis } = {}) {
  // Bumped by clear(), so a fetch that lands after the stream it was for has
  // gone makes no URL that nothing would ever revoke.
  let era = 0;
  const urls = new Map(); // ref -> Promise<blob URL | null>
  const made = new Set();
  let observer = null;
  let dialog = null;

  function urlFor(ref) {
    if (urls.has(ref)) return urls.get(ref);
    const at = era;
    const card = currentCard();
    const p = Promise.resolve()
      .then(() => fetchImage?.(card, ref))
      .then((res) => {
        const img = res?.ok ? res.data : null;
        if (at !== era || typeof img?.data !== 'string' || typeof img.mediaType !== 'string') return null;
        const url = win.URL.createObjectURL(base64ToBlob(img.data, img.mediaType));
        made.add(url);
        return url;
      })
      .catch(() => null);
    urls.set(ref, p);
    return p;
  }

  function load(button) {
    if (button.dataset.state !== 'pending') return;
    button.dataset.state = 'loading';
    const at = era;
    urlFor(button.dataset.imageRef).then((url) => {
      if (at !== era) return;
      if (!url) {
        // Kept clickable: a click retries (see the stream handler below).
        urls.delete(button.dataset.imageRef);
        button.dataset.state = 'failed';
        return;
      }
      button.querySelector('.chat-image-img')?.setAttribute('src', url);
      button.dataset.state = 'loaded';
    });
  }

  // Lazy where the browser can say what is on screen: opening a long session
  // must not pull every screenshot in its window, only the ones the reader sees.
  function watcher() {
    if (observer || typeof win.IntersectionObserver !== 'function') return observer;
    observer = new win.IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        observer.unobserve(e.target);
        load(e.target);
      }
    }, { root: stream, rootMargin: '600px 0px' });
    return observer;
  }

  function closeViewer() {
    if (dialog?.open) dialog.close();
  }

  function viewer() {
    if (dialog) return dialog;
    dialog = doc.createElement('dialog');
    dialog.className = 'chat-image-dialog';
    const head = doc.createElement('div');
    head.className = 'chat-image-dialog-head';
    const caption = doc.createElement('span');
    caption.className = 'chat-image-dialog-caption';
    const close = doc.createElement('button');
    close.type = 'button';
    close.className = 'ghost chat-image-dialog-close';
    close.textContent = 'Close';
    close.addEventListener('click', closeViewer);
    head.append(caption, close);
    const frame = doc.createElement('div');
    frame.className = 'chat-image-dialog-frame';
    const img = doc.createElement('img');
    img.className = 'chat-image-full';
    // Fitted to the window by default; a click shows it at its own pixel size,
    // scrolling inside the frame, for a screenshot too large to read fitted.
    img.addEventListener('click', () => { dialog.dataset.zoom = dialog.dataset.zoom === '1' ? '0' : '1'; });
    frame.appendChild(img);
    dialog.append(head, frame);
    dialog.addEventListener('mousedown', (e) => { if (e.target === dialog) closeViewer(); });
    // Kept from the page, so Escape closes this and nothing behind it.
    dialog.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeViewer(); } });
    dialog.addEventListener('cancel', (e) => { e.preventDefault(); closeViewer(); });
    doc.body.appendChild(dialog);
    return dialog;
  }

  async function open(button) {
    const at = era;
    const url = await urlFor(button.dataset.imageRef);
    if (at !== era || !url) return;
    const d = viewer();
    d.dataset.zoom = '0';
    d.querySelector('.chat-image-full').setAttribute('src', url);
    d.querySelector('.chat-image-full').setAttribute('alt', button.querySelector('.chat-image-img')?.getAttribute('alt') || 'Image');
    d.querySelector('.chat-image-dialog-caption').textContent = button.getAttribute('title') || '';
    if (!d.open) d.showModal();
    d.querySelector('.chat-image-dialog-close').focus();
  }

  stream.addEventListener('click', (e) => {
    const hit = e.target?.closest?.('[data-image-ref]');
    if (!hit) return;
    e.preventDefault();
    if (hit.dataset.state === 'failed') {
      hit.dataset.state = 'pending';
      load(hit);
      return;
    }
    open(hit);
  });

  return {
    // Every thumbnail in a node just appended to the stream.
    observe(node) {
      for (const button of node.querySelectorAll?.('.chat-image') || []) {
        const o = watcher();
        if (o) o.observe(button);
        else load(button);
      }
    },
    // The stream was emptied: its thumbnails are gone, and so is the card the
    // cached URLs were fetched for.
    clear() {
      era += 1;
      observer?.disconnect();
      observer = null;
      closeViewer();
      for (const url of made) win.URL.revokeObjectURL(url);
      made.clear();
      urls.clear();
    },
  };
}
