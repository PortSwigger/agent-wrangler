import { esc } from './util.js';
import { parseRepoInput } from './dispatch-repos.js';

// A location card's GitHub repos after dispatch (server/locations/repo-access.js):
// the "GitHub repos…" dialog adds some, and a session's request_repo asks the
// human for some. Each request is toasted once per page load with Allow and
// Decline, and stays answerable from the dialog after its toast is closed.

export function repoRequestsOf(sessions) {
  return (sessions || []).flatMap((s) => (s.repoRequests || []).map((request) => ({ sessionId: s.sessionId, label: s.label || s.sessionId, request })));
}

export const requestText = ({ label, request }) => `${label} asks to reach ${request.repos.join(', ')}`;

export function createRepoAccess({ document, send, toast, dismissToast = () => {} }) {
  const modal = document.getElementById('repos-modal');
  const have = document.getElementById('rp-have');
  const requests = document.getElementById('rp-requests');
  const input = document.getElementById('rp-add');
  const msg = document.getElementById('rp-msg');
  const go = document.getElementById('rp-go');
  const toasted = new Set();
  let sessionId = null;
  let sessions = [];

  const answer = (sid, requestId, allow) => send({ type: 'repo-request', sessionId: sid, requestId, allow });

  function draw() {
    const s = sessions.find((x) => x.sessionId === sessionId);
    if (!s || !Array.isArray(s.repos)) { close(); return; }
    have.innerHTML = s.repos.length
      ? s.repos.map((r) => `<li>${esc(r)}</li>`).join('')
      : '<li class="repos-none">No repos yet</li>';
    requests.innerHTML = (s.repoRequests || []).map((r) => `<div class="repos-request" data-request="${esc(r.id)}">
        <div>The session asks for <strong>${esc(r.repos.join(', '))}</strong></div>
        ${r.why ? `<div class="repos-request-why">${esc(r.why)}</div>` : ''}
        <div class="modal-actions"><button type="button" class="ghost" data-allow="false">Decline</button><button type="button" class="primary" data-allow="true">Allow</button></div>
      </div>`).join('');
  }

  function validate() {
    const { repos, error } = parseRepoInput(input.value);
    msg.textContent = error || '';
    msg.classList.toggle('error', Boolean(error));
    go.disabled = Boolean(error) || !repos.length;
    return error ? [] : repos;
  }

  function open(sid) {
    sessionId = sid;
    input.value = '';
    validate();
    draw();
    if (sessionId == null) return;
    modal.classList.remove('hidden');
    input.focus();
  }

  function close() {
    modal.classList.add('hidden');
    sessionId = null;
  }

  function submit() {
    if (modal.classList.contains('hidden') || sessionId == null) return;
    const repos = validate();
    if (!repos.length) return;
    send({ type: 'add-repos', sessionId, repos });
    input.value = '';
    validate();
  }

  input.addEventListener('input', validate);
  go.addEventListener('click', submit);
  document.getElementById('rp-cancel').addEventListener('click', close);
  modal.addEventListener('mousedown', (e) => { if (e.target === modal) close(); });
  modal.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); submit(); }
    else if (e.key === 'Escape') { e.preventDefault(); close(); }
  });
  requests.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-allow]');
    const row = btn?.closest('[data-request]');
    if (row && sessionId != null) answer(sessionId, row.dataset.request, btn.dataset.allow === 'true');
  });

  return {
    open,
    onGraph(next) {
      sessions = next || [];
      if (sessionId != null) draw();
      const waiting = repoRequestsOf(sessions);
      const pending = new Set(waiting.map((item) => item.request.id));
      for (const id of toasted) {
        if (pending.has(id)) continue;
        toasted.delete(id);
        dismissToast(`repo-request:${id}`);
      }
      for (const item of waiting) {
        if (toasted.has(item.request.id)) continue;
        toasted.add(item.request.id);
        toast(requestText(item), 'warning', {
          id: `repo-request:${item.request.id}`,
          duration: Infinity,
          details: item.request.why || undefined,
          actions: [
            { label: 'Allow', onClick: () => answer(item.sessionId, item.request.id, true) },
            { label: 'Decline', onClick: () => answer(item.sessionId, item.request.id, false) },
          ],
        });
      }
    },
    onAdded({ added }) {
      toast(added?.length ? `Added ${added.join(', ')}` : 'The session already has those repos', 'success');
    },
  };
}
