import { esc } from './util.js';

// The viewer panel behind `api.openFile`. Fetches GET /ext-file, which reads only
// what the extension registered with host.files, and shows markdown rendered by
// the shared renderer or an image. Resolves { ok:true } once shown, or the
// server's { ok:false, reason } with nothing opened; never rejects. `opened`
// guards a slow reply from replacing a file opened after it.
export function createExtFileViewer({ document, fetchImpl = (...a) => fetch(...a), renderMarkdown }) {
  const modal = document.getElementById('ext-file-modal');
  const titleEl = document.getElementById('ext-file-title');
  const pathEl = document.getElementById('ext-file-path');
  const bodyEl = document.getElementById('ext-file-body');
  const closeBtn = document.getElementById('ext-file-close');
  let opened = 0;

  const close = () => { modal.classList.add('hidden'); opened++; };
  closeBtn.addEventListener('click', close);
  modal.addEventListener('mousedown', (e) => { if (e.target === modal) close(); });
  modal.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); close(); } });

  function show(r) {
    titleEl.textContent = r.path.split('/').pop() || r.path;
    pathEl.textContent = r.path;
    if (r.kind === 'markdown') {
      bodyEl.innerHTML = renderMarkdown ? renderMarkdown(r.text ?? '') : esc(r.text ?? '');
    } else {
      const img = document.createElement('img');
      img.alt = titleEl.textContent;
      img.src = `data:${r.mime};base64,${r.base64}`;
      bodyEl.replaceChildren(img);
    }
    modal.classList.remove('hidden');
    closeBtn.focus();
  }

  return {
    async open(extId, p) {
      const mine = ++opened;
      try {
        const res = await fetchImpl(`/ext-file?ext=${encodeURIComponent(extId)}&path=${encodeURIComponent(p)}`);
        const r = await res.json();
        if (!r || r.ok !== true) return { ok: false, reason: typeof r?.reason === 'string' ? r.reason : 'error' };
        if (mine === opened) show(r);
        return { ok: true };
      } catch {
        return { ok: false, reason: 'unavailable' };
      }
    },
    close,
  };
}
