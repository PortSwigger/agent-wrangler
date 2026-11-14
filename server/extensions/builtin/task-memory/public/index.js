// Task memory, client half: one freeform markdown file per task, shared with the
// agent running under it. The board contributes a 'Task memory' item to every
// task tile's menus (`task.action`); picking it opens a modal built here, on
// demand, and talks to the server half over the extension's own frames:
//   -> { type: 'get-memory', taskId } / { type: 'set-memory', taskId, md }
//   <- { type: 'ext:task-memory', kind: 'memory', taskId, md }   (a get answered)
//   <- { type: 'ext:task-memory', kind: 'changed', taskId }      (file changed on disk)
//
// Another deck's task (its subject carries `deckId` and `deckTaskId`) reads and
// writes that deck's memory: the frames go to that deck alone, and only its
// answers (`fromDeck`) reach the open editor. A deck running this extension
// with another boardApi shows an Incompatible note instead of the editor.
//
// `editing` tracks the open task and whether the textarea has unsaved edits, so a
// concurrent on-disk change refreshes a clean editor but never clobbers a dirty
// one. The textarea is the literal-markdown buffer (Save writes it byte-exact);
// the preview is a read-only render of it (api.ui.markdownPreview), shown beside
// / instead of the editor per the Write / Split / Preview mode.
//
// Limitation: the modal's DOM is attached to document.body, outside the slots'
// control, and the api has no unload hook. It is created on first open and
// removed again on close, so a disabled extension leaves nothing behind unless
// it is disabled while the modal is open (then the modal stays until closed;
// its listener is already gone, so it just no longer hears disk changes).

const MEMORY_ICON =
  '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M16 13H8"/><path d="M16 17H8"/><path d="M10 9H8"/></svg>';

const MODES = ['write', 'split', 'preview'];
const MODE_KEY = 'cm-memory-mode'; // the pre-extension key, kept so the choice survives

const MODAL_HTML = `
  <div class="modal-card" id="memory-card">
    <div class="memory-head" id="memory-head">
      <h3 id="memory-title">Task memory</h3>
      <div class="memory-mode" id="memory-mode" role="tablist" aria-label="Memory view mode">
        <button id="memory-mode-write" data-mode="write" type="button">Write</button>
        <button id="memory-mode-split" data-mode="split" type="button">Split</button>
        <button id="memory-mode-preview" data-mode="preview" type="button">Preview</button>
      </div>
    </div>
    <p class="memory-note" id="memory-note">Shared with the agent — for context that spans the repos this task touches, not a session scratchpad. Repo-specific context belongs in that repo's own CLAUDE.md instead. Editable in your own editor too.</p>
    <p class="memory-conflict hidden" id="memory-conflict">This memory changed on disk — saving will overwrite.</p>
    <div class="memory-body" id="memory-body">
      <textarea id="memory-text" class="memory-text" rows="16" placeholder="Cross-repo context for this task — shared with the agent."></textarea>
      <div id="memory-preview" class="chat-prose memory-preview" aria-live="polite"></div>
    </div>
    <div class="modal-actions" id="memory-actions">
      <button id="memory-close" class="ghost">Close</button>
      <button id="memory-save" class="primary">Save</button>
    </div>
  </div>`;

export default {
  register(slots) {
    const api = slots.api;
    const names = new Map(); // taskId -> last name seen via task.action
    let editing = null; // { taskId, deck, dirty } while the modal is open
    let modal = null;
    let previewTimer;

    const $ = (id) => modal.querySelector(`#${id}`);
    const readMode = () => {
      const m = api.storage.raw(MODE_KEY).get();
      return MODES.includes(m) ? m : 'split';
    };

    function renderPreview() {
      if (!modal) return;
      $('memory-preview').innerHTML = api.ui.markdownPreview($('memory-text').value);
    }
    // Coalesce keystroke re-renders; the preview only needs to settle.
    function schedulePreview() {
      clearTimeout(previewTimer);
      previewTimer = setTimeout(renderPreview, 120);
    }

    function setMode(m) {
      const mode = MODES.includes(m) ? m : 'split';
      api.storage.raw(MODE_KEY).set(mode);
      const card = $('memory-card');
      card.classList.remove('mode-write', 'mode-split', 'mode-preview');
      card.classList.add(`mode-${mode}`);
      modal.querySelectorAll('#memory-mode button').forEach((b) =>
        b.classList.toggle('active', b.dataset.mode === mode));
      if (mode !== 'write') renderPreview();
      if (mode !== 'preview') $('memory-text').focus();
    }

    function close() {
      clearTimeout(previewTimer);
      editing = null;
      if (modal) modal.remove();
      modal = null;
    }

    const sendFor = (deck, frame) => api.send(deck ? { ...frame, deck } : frame);
    const incompatibleDeck = (deck) => (deck && typeof api.decks === 'function'
      ? api.decks().find((d) => d.deckId === deck && d.status === 'incompatible') || null
      : null);

    function save() {
      if (!editing || editing.incompatible) return;
      sendFor(editing.deck, { type: 'set-memory', taskId: editing.taskId, md: $('memory-text').value });
      close();
    }

    function build() {
      modal = document.createElement('div');
      modal.id = 'memory-modal';
      modal.innerHTML = MODAL_HTML;
      $('memory-text').addEventListener('input', () => { if (editing) editing.dirty = true; schedulePreview(); });
      modal.querySelectorAll('#memory-mode button').forEach((b) =>
        b.addEventListener('click', () => setMode(b.dataset.mode)));
      $('memory-save').addEventListener('click', save);
      $('memory-close').addEventListener('click', close);
      modal.addEventListener('keydown', (e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); save(); }
        else if (e.key === 'Escape') { e.preventDefault(); close(); }
      });
      document.body.appendChild(modal);
    }

    function open(boardId, taskId, deck) {
      if (modal) close();
      const bad = incompatibleDeck(deck);
      editing = { taskId, deck, dirty: false, incompatible: Boolean(bad) };
      build();
      const name = names.get(boardId);
      $('memory-title').textContent = name ? `Memory — ${name}` : 'Task memory';
      if (bad) {
        $('memory-note').textContent = `Incompatible: ${bad.name || 'this task\'s deck'} runs another version of task memory.`;
        $('memory-mode').style.display = 'none';
        $('memory-body').style.display = 'none';
        $('memory-save').style.display = 'none';
        return;
      }
      sendFor(deck, { type: 'get-memory', taskId });
      setMode(readMode());
      renderPreview();
    }

    slots.onMessage((msg) => {
      if (!msg || !editing || editing.incompatible || msg.taskId !== editing.taskId) return;
      if ((msg.fromDeck || null) !== editing.deck) return;
      if (msg.kind === 'memory') {
        // Fill from the server only while clean — never stomp live edits.
        if (editing.dirty) return;
        $('memory-text').value = msg.md || '';
        renderPreview();
      } else if (msg.kind === 'changed') {
        if (editing.dirty) $('memory-conflict').classList.remove('hidden');
        else sendFor(editing.deck, { type: 'get-memory', taskId: msg.taskId });
      }
    });

    slots.register('task.action', {
      id: 'memory',
      decks: true,
      items(task) {
        if (task.adhoc) return [];
        if (task.name) names.set(task.id, task.name);
        const deck = typeof task.deckId === 'string' && task.deckId ? task.deckId : null;
        const taskId = deck ? task.deckTaskId : task.id;
        return [{ label: 'Task memory', icon: MEMORY_ICON, run: () => open(task.id, taskId, deck) }];
      },
    });
  },
};
