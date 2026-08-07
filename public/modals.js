import { send, selectedSessionId, deselectSession, latestTasks } from './app.js';
import { toast } from './toast.js';
import { customSnoozeValid, toDatetimeLocalValue, resolveUntil, parseDatetimeLocal, snoozeSetMessage } from './snooze.js';
import { createRenderer } from './markdown-preview.js';

// Self-contained dialogs: fork, custom-snooze, task-memory. Each
// owns its own DOM wiring + transient state; the app calls the open*/on* entry
// points and the modals reach back for send/selection/tasks. (The dispatch dialog
// stays in app.js — its worktree state is entangled with the ws handlers.)

// --- fork session modal ---
const forkModal = document.getElementById('fork-modal');
let forkParentId = null;
export function openFork(sessionId) {
  forkParentId = sessionId;
  document.getElementById('fk-name').value = '';
  document.getElementById('fk-prompt').value = '';
  forkModal.classList.remove('hidden');
  document.getElementById('fk-prompt').focus();
}
function submitFork() {
  if (forkModal.classList.contains('hidden') || !forkParentId) return;
  const name = document.getElementById('fk-name').value.trim();
  const prompt = document.getElementById('fk-prompt').value.trim();
  send({ type: 'fork', sessionId: forkParentId, prompt, name });
  forkModal.classList.add('hidden');
  forkParentId = null;
  toast('Forking…');
}
document.getElementById('fk-cancel').addEventListener('click', () => { forkModal.classList.add('hidden'); forkParentId = null; });
document.getElementById('fk-go').addEventListener('click', submitFork);
forkModal.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); submitFork(); }
  else if (e.key === 'Escape') { e.preventDefault(); forkModal.classList.add('hidden'); forkParentId = null; }
});

// --- custom snooze modal ---
// Picks an arbitrary wake time; the presets in openSnoozeMenu cover the common
// cases. The server only sanity-checks until>now, so validity lives here:
// Snooze stays disabled until the input is a parseable future instant.
const snoozeModal = document.getElementById('snooze-modal');
const snWhen = document.getElementById('sn-when');
const snComment = document.getElementById('sn-comment');
const snGo = document.getElementById('sn-go');
let snoozeTargetId = null;
function validateCustomSnooze() {
  snGo.disabled = !customSnoozeValid(snWhen.value, Date.now());
}
export function openCustomSnooze(sessionId) {
  snoozeTargetId = sessionId;
  snWhen.value = toDatetimeLocalValue(resolveUntil('tomorrow', Date.now()));
  snComment.value = ''; // reset so a prior note doesn't linger onto the next snooze
  validateCustomSnooze();
  snoozeModal.classList.remove('hidden');
  snWhen.focus();
}
function closeCustomSnooze() { snoozeModal.classList.add('hidden'); snoozeTargetId = null; }
function submitCustomSnooze() {
  if (snoozeModal.classList.contains('hidden') || !snoozeTargetId) return;
  if (!customSnoozeValid(snWhen.value, Date.now())) return;
  const sessionId = snoozeTargetId;
  send(snoozeSetMessage(sessionId, parseDatetimeLocal(snWhen.value), snComment.value));
  // Same as the presets: snoozing the open session closes its view.
  if (sessionId === selectedSessionId) deselectSession();
  closeCustomSnooze();
}
snWhen.addEventListener('input', validateCustomSnooze);
document.getElementById('sn-cancel').addEventListener('click', closeCustomSnooze);
snGo.addEventListener('click', submitCustomSnooze);
snoozeModal.addEventListener('mousedown', (e) => { if (e.target === snoozeModal) closeCustomSnooze(); });
snoozeModal.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); submitCustomSnooze(); }
  else if (e.key === 'Escape') { e.preventDefault(); closeCustomSnooze(); }
});

// --- task memory modal: one freeform markdown file per task, shared with the
// agent running under it. memoryEditing tracks the open task and whether the
// textarea has unsaved edits, so a concurrent on-disk change refreshes a clean
// editor but never clobbers a dirty one. The textarea is the literal-markdown
// buffer (Save writes it byte-exact); #memory-preview is a read-only render of it,
// shown beside / instead of the editor per the Write·Split·Preview mode. ---
const memoryModal = document.getElementById('memory-modal');
const memoryTextEl = document.getElementById('memory-text');
let memoryEditing = null; // { taskId, dirty } while the modal is open

// Lazy + memoized so <script> load order can't break module init: window.markdownit
// is only read on first render, by which point the classic vendor <script> has run.
let render;
const renderer = () => (render ||= createRenderer(window.markdownit));
function renderPreview() {
  document.getElementById('memory-preview').innerHTML = renderer()(memoryTextEl.value);
}
// Coalesce keystroke re-renders; the preview only needs to settle, not track each char.
let previewTimer;
function schedulePreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(renderPreview, 120);
}

// mode ∈ {write, split, preview}; persisted under the cm- key convention (theme.js,
// sidebar width). Default split. setMemoryMode swaps the mode-* class CSS keys off,
// renders the preview when it's visible, and returns focus to the editor when it is.
let memoryMode = localStorage.getItem('cm-memory-mode') || 'split';
function setMemoryMode(m) {
  memoryMode = ['write', 'split', 'preview'].includes(m) ? m : 'split';
  localStorage.setItem('cm-memory-mode', memoryMode);
  const card = document.getElementById('memory-card');
  card.classList.remove('mode-write', 'mode-split', 'mode-preview');
  card.classList.add(`mode-${memoryMode}`);
  document.querySelectorAll('#memory-mode button').forEach((b) =>
    b.classList.toggle('active', b.dataset.mode === memoryMode));
  if (memoryMode !== 'write') renderPreview();
  if (memoryMode !== 'preview') memoryTextEl.focus();
}

export function openMemory(taskId) {
  memoryEditing = { taskId, dirty: false };
  send({ type: 'get-memory', taskId });
  memoryTextEl.value = '';
  const task = latestTasks.tasks.find((t) => t.id === taskId);
  document.getElementById('memory-title').textContent = task ? `Memory — ${task.name}` : 'Task memory';
  memoryModal.classList.remove('hidden');
  setMemoryMode(memoryMode);
  renderPreview();
}
function saveMemory() {
  if (!memoryEditing) return;
  send({ type: 'set-memory', taskId: memoryEditing.taskId, md: memoryTextEl.value });
  memoryModal.classList.add('hidden');
  memoryEditing = null;
}
function closeMemory() {
  memoryModal.classList.add('hidden');
  memoryEditing = null;
}
// Fill the textarea from the server only while clean — never stomp live edits.
export function onMemory(msg) {
  if (!memoryEditing || memoryEditing.taskId !== msg.taskId || memoryEditing.dirty) return;
  memoryTextEl.value = msg.md || '';
  renderPreview();
}
// The grid dot rerenders via the graph the server rebuilds alongside this event;
// here we only keep an open editor in sync — refetch when clean, warn when dirty.
// (onMemory runs renderPreview on the refetched value, so the preview tracks it.)
export function onMemoryChanged(msg) {
  if (!memoryEditing || memoryEditing.taskId !== msg.taskId) return;
  if (memoryEditing.dirty) toast('This memory changed on disk — saving will overwrite.', false);
  else send({ type: 'get-memory', taskId: msg.taskId });
}
memoryTextEl.addEventListener('input', () => { if (memoryEditing) memoryEditing.dirty = true; schedulePreview(); });
document.querySelectorAll('#memory-mode button').forEach((b) =>
  b.addEventListener('click', () => setMemoryMode(b.dataset.mode)));
document.getElementById('memory-save').addEventListener('click', saveMemory);
document.getElementById('memory-close').addEventListener('click', closeMemory);
memoryModal.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); saveMemory(); }
  else if (e.key === 'Escape') { e.preventDefault(); closeMemory(); }
});
