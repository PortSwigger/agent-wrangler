// Client-side user settings: a declarative registry + localStorage persistence,
// rendered into the centered #settings-modal (opened from the nav-rail gear).
//
// To ADD a Behavior setting: append one entry to SETTINGS below — the panel row,
// its persistence, and getSetting() all derive from it, no other wiring needed.
// Read a value anywhere with getSetting(id); it reads localStorage live, so a
// consumer that calls it per-use (e.g. on each keypress) always sees the current
// choice with no change-event plumbing.
//
// Each entry: { id, label, help, type, default }.
//   type 'toggle' → boolean, rendered as a switch; getSetting returns a boolean.
//   type 'list'   → an editable list of { label, id } pairs (add/remove), validated
//                   by `sanitize` (a pure function from cloud-ui.js et al) before
//                   every write; getSetting returns the array. server-scope only —
//                   there is no localStorage encoding for it, deliberately: a list
//                   like the cloud-environment registry has to be shared by every
//                   browser AND readable by the launch path, so a per-browser copy
//                   would be a second, silently-diverging source of truth.
// New types extend renderRow()/readStored()/writeStored() + getSetting().
//
// scope: 'server' marks a setting persisted in the server's config.json (shared
// by every browser) instead of localStorage. Its read/write goes through the
// bridge app.js hands to initSettings — read off the latest graph, write via the
// control WS — so this module stays free of app.js imports.
//
// The modal is split into three sections: Appearance (theme + terminal font size —
// bespoke widgets owned by theme.js/app.js, composed in via the `appearance` bridge
// below, the same pattern as the `server` bridge), Behavior (this registry), and
// Shortcuts (a static reference table from shortcuts.js).

import { esc } from './util.js';
import { shortcutsHtml } from './shortcuts.js';
import { sanitizeCloudEnvironments } from './cloud-ui.js';

const STORE_PREFIX = 'cm-setting-';

export const SETTINGS = [
  {
    id: 'flipNavHotkeys',
    type: 'toggle',
    label: 'Flip navigating task / session hotkeys',
    help: 'Board navigation (Shift+Cmd+arrows): by default ←/→ switch task and ↑/↓ switch session. Enable this to swap the axes.',
    default: false,
  },
  {
    id: 'taskMemoryEnabled',
    type: 'toggle',
    scope: 'server',
    label: 'Task memory / notes',
    help: 'Shared per-task notes agents are asked to read at session start. Off hides the tile button and stops instructing agents to read the file; existing notes are kept.',
    default: true,
  },
  {
    id: 'subagentsExpandedByDefault',
    type: 'toggle',
    scope: 'server',
    label: 'Sub-agents view expanded by default',
    help: 'Whether a session\'s sub-agents zone (board card + panel) starts expanded or collapsed. A card or panel you have toggled by hand keeps its own choice regardless of this setting.',
    default: false,
  },
  {
    id: 'autoFixPrChecksDefault',
    type: 'toggle',
    scope: 'server',
    label: 'Auto-fix PR checks by default',
    help: 'Whether a new session nudges its agent when a linked PR needs attention — failing required checks, a merge conflict, or new unresolved review threads. A session you have toggled by hand from its card menu keeps its own choice regardless of this setting.',
    default: true,
  },
  {
    id: 'trustCodexLaunchCwd',
    type: 'toggle',
    scope: 'server',
    label: 'Skip Codex\'s trust-folder prompt',
    help: 'Codex launches/resumes/forks already run sandboxed with approvals off — this persists the folder as trusted in Codex\'s own ~/.codex/config.toml before launch (a per-invocation flag doesn\'t work; Codex ignores it), so its trust prompt never appears. For a worktree session this trusts the repo\'s main checkout, not just that worktree, so every other worktree of the same repo — and any other Codex use of it, wrangler or not — is trusted from then on too. Off restores Codex\'s normal prompt.',
    default: true,
  },
  {
    id: 'childFullViewByDefault',
    type: 'toggle',
    scope: 'server',
    label: 'New child sessions show full view by default',
    help: 'A nested child session (a workflow worker, or any other child attached under a parent) normally renders as a compact row. This sets the default for newly-nested children; a child you have toggled by hand (its card menu\'s "Full view") keeps its own choice regardless.',
    default: false,
  },
  {
    id: 'cloudEnvironments',
    type: 'list',
    scope: 'server',
    label: 'Cloud environments',
    help: 'The cloud environments offered when Destination is ☁ Cloud. There is no API listing — you register them here. An id starting env_ is an Anthropic-hosted environment; ccpool_ is a self-hosted runner pool (only that form honours a branch ref). Anything else is rejected, since the prefix is what picks the launch form.',
    default: [],
    // Same rule the server's cloudEnvironments(cfg) accessor applies, run in front
    // of the user so a typo is reported instead of silently vanishing on the next
    // graph push.
    sanitize: sanitizeCloudEnvironments,
    itemLabelPlaceholder: 'Name (e.g. Anthropic prod)',
    itemIdPlaceholder: 'env_… or ccpool_…',
    addLabel: '+ Add environment',
  },
];

let serverBridge = { get: () => undefined, set: () => {} };
// { themeRowsHtml(), fontSizeRowHtml(), onThemeSelect(id), onFontSize(n) } — supplied
// by app.js, which owns both the live theme and the live terminal.
let appearanceBridge = { themeRowsHtml: () => '', fontSizeRowHtml: () => '', onThemeSelect: () => {}, onFontSize: () => {} };

const byId = new Map(SETTINGS.map((s) => [s.id, s]));

function readStored(def) {
  if (def.scope === 'server') {
    const v = serverBridge.get(def.id);
    if (def.type === 'list') return Array.isArray(v) ? v : def.default;
    return v == null ? def.default : v;
  }
  // A 'list' has no localStorage encoding by design (see the header comment) — a
  // per-browser copy of a registry the launch path reads would be a second source
  // of truth. Fail loudly at definition time rather than silently storing "[object
  // Object],…" via String().
  if (def.type === 'list') throw new Error(`setting '${def.id}': type 'list' requires scope 'server'`);
  const raw = localStorage.getItem(STORE_PREFIX + def.id);
  if (raw == null) return def.default;
  if (def.type === 'toggle') return raw === '1';
  return raw;
}

function writeStored(def, value) {
  if (def.scope === 'server') { serverBridge.set(def.id, value); return; }
  if (def.type === 'list') throw new Error(`setting '${def.id}': type 'list' requires scope 'server'`);
  const raw = def.type === 'toggle' ? (value ? '1' : '0') : String(value);
  localStorage.setItem(STORE_PREFIX + def.id, raw);
}

// The single read path for consumers. Unknown id → undefined (a caller typo
// shouldn't silently masquerade as a real, unset setting).
export function getSetting(id) {
  const def = byId.get(id);
  return def ? readStored(def) : undefined;
}

export function setSetting(id, value) {
  const def = byId.get(id);
  if (def) writeStored(def, value);
}

// One editable { label, id } pair. `idx` is the row's position in the list — the
// write path reads every pair back out of the DOM by index, so an id never has to
// be a stable key (two half-typed rows may briefly share one).
function listItemHtml(def, item, idx) {
  const base = `setting-${esc(def.id)}-item-${idx}`;
  return `<div class="setting-pair" id="${base}" data-idx="${idx}">
      <input class="setting-pair-label" id="${base}-label" value="${esc(item.label || '')}"
        placeholder="${esc(def.itemLabelPlaceholder || 'Label')}" aria-label="Label" autocomplete="off" />
      <input class="setting-pair-id" id="${base}-id" value="${esc(item.id || '')}"
        placeholder="${esc(def.itemIdPlaceholder || 'Id')}" aria-label="Id" autocomplete="off" />
      <button type="button" class="setting-pair-remove" id="${base}-remove" title="Remove" aria-label="Remove">×</button>
    </div>`;
}

// A 'list' row: label + help stacked above the editable pairs, an Add button, and a
// feedback line. The list is re-rendered from the STORED value after every commit,
// so a dropped row visibly disappears with its reason shown — the module's rule is
// that nothing is lost silently.
function listRowHtml(def) {
  const items = readStored(def) || [];
  const base = `setting-${esc(def.id)}`;
  return `<div class="setting-row setting-row-stacked" data-id="${esc(def.id)}" id="${base}-row">
      <div class="setting-copy" id="${base}-copy">
        <div class="setting-label" id="${base}-label">${esc(def.label)}</div>
        ${def.help ? `<div class="setting-help" id="${base}-help">${esc(def.help)}</div>` : ''}
      </div>
      <div class="setting-pairs" id="${base}-pairs">
        ${items.map((it, i) => listItemHtml(def, it, i)).join('')}
      </div>
      <div class="setting-pairs-foot" id="${base}-foot">
        <button type="button" class="ghost setting-pairs-add" id="${base}-add">${esc(def.addLabel || '+ Add')}</button>
        <div class="setting-pairs-msg hidden" id="${base}-msg" aria-live="polite"></div>
      </div>
    </div>`;
}

function rowHtml(def) {
  const on = readStored(def);
  // type dispatch: only 'toggle' today, but the switch keeps the door open for
  // select/number rows without touching the open/close/escape wiring below.
  if (def.type === 'list') return listRowHtml(def);
  if (def.type === 'toggle') {
    return `<div class="setting-row" data-id="${esc(def.id)}">
        <div class="setting-copy">
          <div class="setting-label">${esc(def.label)}</div>
          ${def.help ? `<div class="setting-help">${esc(def.help)}</div>` : ''}
        </div>
        <button type="button" class="setting-toggle${on ? ' on' : ''}" role="switch"
          aria-checked="${on ? 'true' : 'false'}" aria-label="${esc(def.label)}">
          <span class="setting-knob"></span>
        </button>
      </div>`;
  }
  return '';
}

function sectionHtml(title, inner) {
  return `<div class="settings-section">
      <div class="settings-section-title">${esc(title)}</div>
      ${inner}
    </div>`;
}

// Same label + help styling as a Behavior row (.setting-label/.setting-help), so
// Appearance's theme picker and font-size row read consistently with the toggles
// below them even though they have their own row of buttons instead of a switch.
function appearanceItemHtml(label, help, body) {
  return `<div class="appearance-item">
      <div class="setting-label">${esc(label)}</div>
      ${help ? `<div class="setting-help">${esc(help)}</div>` : ''}
      ${body}
    </div>`;
}

function render(body) {
  const behaviorRows = SETTINGS.map(rowHtml).join('') || '<div class="settings-empty">No settings yet.</div>';
  body.innerHTML = [
    sectionHtml('Appearance', [
      appearanceItemHtml('Theme', null, `<div class="theme-rows">${appearanceBridge.themeRowsHtml()}</div>`),
      appearanceItemHtml('Terminal font size', null, `<div class="fontsize-row">${appearanceBridge.fontSizeRowHtml()}</div>`),
    ].join('')),
    sectionHtml('Behavior', `<div class="settings-list">${behaviorRows}</div>`),
    sectionHtml('Shortcuts', `<div class="shortcuts-list">${shortcutsHtml()}</div>`),
  ].join('');
}

// Wire the gear button + modal once at startup. Reuses the shared modal overlay
// styling (centered, backdrop-dismiss, Escape) like every other -modal.
// `server` is the { get(id), set(id, value) } bridge for scope:'server' entries;
// `appearance` is the theme/font-size bridge described above.
export function initSettings({ server, appearance } = {}) {
  if (server) serverBridge = server;
  if (appearance) appearanceBridge = appearance;
  const btn = document.getElementById('settings-btn');
  const modal = document.getElementById('settings-modal');
  const body = document.getElementById('settings-body');
  if (!modal || !body) return;

  const closeBtn = document.getElementById('settings-close');
  // Land focus on Done so the modal-scoped Escape handler below fires on a fresh
  // open (a click-opened modal otherwise leaves focus on <body>) — same trick the
  // file-preview / schedule modals use.
  const open = () => { render(body); modal.classList.remove('hidden'); closeBtn?.focus(); };
  const close = () => modal.classList.add('hidden');

  if (btn) btn.addEventListener('click', open);
  closeBtn?.addEventListener('click', close);
  modal.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); close(); } });
  modal.addEventListener('mousedown', (e) => { if (e.target === modal) close(); });

  // --- 'list' rows ---
  // Read every pair out of the DOM, sanitize, persist the survivors, then re-render
  // the row from the stored value. Re-rendering (rather than leaving the typed DOM
  // alone) is what makes a dropped row VISIBLE: the bad line disappears and the
  // feedback slot says why, instead of the value quietly not taking.
  const commitList = (def, rowEl, { rerender = true } = {}) => {
    const rows = [...rowEl.querySelectorAll('.setting-pair')].map((el) => ({
      label: el.querySelector('.setting-pair-label').value,
      id: el.querySelector('.setting-pair-id').value,
    }));
    const sanitize = def.sanitize || ((r) => ({ environments: r, dropped: [] }));
    const { environments, dropped } = sanitize(rows);
    setSetting(def.id, environments);
    if (rerender) {
      rowEl.querySelector('.setting-pairs').innerHTML =
        environments.map((it, i) => listItemHtml(def, it, i)).join('');
    }
    const msg = rowEl.querySelector('.setting-pairs-msg');
    msg.textContent = dropped.length
      ? dropped.map((d) => `Dropped "${d.label || d.id || '(blank)'}" — ${d.reason}.`).join(' ')
      : '';
    msg.classList.toggle('hidden', !dropped.length);
  };

  body.addEventListener('click', (e) => {
    const add = e.target.closest('.setting-pairs-add');
    if (add) {
      const rowEl = add.closest('.setting-row');
      const def = byId.get(rowEl?.dataset.id);
      if (!def) return;
      const list = rowEl.querySelector('.setting-pairs');
      // Appended as a blank pair, not persisted yet — sanitize treats a fully-blank
      // row as the empty add-form rather than an error, so nothing is reported
      // until the user actually types something.
      list.insertAdjacentHTML('beforeend', listItemHtml(def, { label: '', id: '' }, list.children.length));
      list.lastElementChild.querySelector('.setting-pair-label').focus();
      return;
    }
    const remove = e.target.closest('.setting-pair-remove');
    if (remove) {
      const rowEl = remove.closest('.setting-row');
      const def = byId.get(rowEl?.dataset.id);
      remove.closest('.setting-pair').remove();
      if (def) commitList(def, rowEl);
      return;
    }
    const themeRow = e.target.closest('.theme-row');
    if (themeRow) {
      appearanceBridge.onThemeSelect(themeRow.dataset.id);
      body.querySelectorAll('.theme-row').forEach((r) => r.classList.toggle('active', r === themeRow));
      return;
    }
    const fontOpt = e.target.closest('.fontsize-opt');
    if (fontOpt) {
      appearanceBridge.onFontSize(Number(fontOpt.dataset.size));
      body.querySelectorAll('.fontsize-opt').forEach((r) => r.classList.toggle('active', r === fontOpt));
      return;
    }
    const toggle = e.target.closest('.setting-toggle');
    if (!toggle) return;
    const row = toggle.closest('.setting-row');
    const def = byId.get(row?.dataset.id);
    if (!def || def.type !== 'toggle') return;
    const next = !getSetting(def.id);
    setSetting(def.id, next);
    toggle.classList.toggle('on', next);
    toggle.setAttribute('aria-checked', next ? 'true' : 'false');
  });

  // Commit a list on blur (focusout), not on every keystroke: a half-typed id
  // ("env") would otherwise be reported as invalid on the way to a valid one, and
  // a re-render mid-typing would steal focus. `rerender: false` on focusout for the
  // same reason — the row the user just left must not be rebuilt under the cursor
  // that has already moved into the next field; the next open renders from store.
  body.addEventListener('focusout', (e) => {
    const item = e.target.closest?.('.setting-pair');
    if (!item) return;
    const rowEl = item.closest('.setting-row');
    const def = byId.get(rowEl?.dataset.id);
    // Still inside the same list ⇒ tab between the two fields, not a commit-worthy
    // exit… but commit anyway (cheap, idempotent) so a closed modal can't lose it.
    if (def) commitList(def, rowEl, { rerender: false });
  });
}
