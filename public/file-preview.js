import { toast } from './toast.js';
import { esc } from './util.js';
import { createRenderer } from './markdown-preview.js';

// The click-to-preview modal for a .md path clicked in the terminal. Fetches
// GET /file, renders with the shared markdown renderer, shows it full-height.
// Owns its own DOM wiring (like modals.js). currentPath guards against a slow
// fetch resolving after the user has opened a different file / closed the modal.
const modal = document.getElementById('file-modal');
const titleEl = document.getElementById('file-title');
const pathEl = document.getElementById('file-path');
const bodyEl = document.getElementById('file-body');
let currentPath = null;

// Lazy + memoized: window.markdownit is read on first render, by which point the
// vendored classic <script> has run (same trick as modals.js).
let render;
const renderer = () => (render ||= createRenderer(window.markdownit));

function close() { modal.classList.add('hidden'); currentPath = null; }

async function load(p) {
  bodyEl.innerHTML = '<div class="file-loading">Loading…</div>';
  try {
    const res = await fetch(`/file?path=${encodeURIComponent(p)}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    if (currentPath !== p) return; // superseded
    bodyEl.innerHTML = renderer()(data.content);
    if (data.path) pathEl.textContent = data.path;
  } catch (err) {
    if (currentPath !== p) return;
    bodyEl.innerHTML = `<div class="file-error">Couldn't open this file: ${esc(err.message)}</div>`;
    toast(`Couldn't open ${p}`, true);
  }
}

export function openFilePreview(p) {
  currentPath = p;
  titleEl.textContent = p.split('/').pop() || p;
  pathEl.textContent = p;
  modal.classList.remove('hidden');
  document.getElementById('file-close').focus(); // so Escape reaches the modal
  load(p);
}

document.getElementById('file-close').addEventListener('click', close);
document.getElementById('file-refresh').addEventListener('click', () => { if (currentPath) load(currentPath); });
modal.addEventListener('mousedown', (e) => { if (e.target === modal) close(); });
modal.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); close(); } });
