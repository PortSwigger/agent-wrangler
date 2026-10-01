import { send, selectedSessionId, deselectSession } from './app.js';
import { toast } from './toast.js';
import { customSnoozeValid, toDatetimeLocalValue, resolveUntil, parseDatetimeLocal, snoozeSetMessage } from './snooze.js';

// Self-contained dialogs: fork, custom-snooze. Each
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
