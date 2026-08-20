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
];

let serverBridge = { get: () => undefined, set: () => {} };
// { themeRowsHtml(), fontSizeRowHtml(), onThemeSelect(id), onFontSize(n) } — supplied
// by app.js, which owns both the live theme and the live terminal.
let appearanceBridge = { themeRowsHtml: () => '', fontSizeRowHtml: () => '', onThemeSelect: () => {}, onFontSize: () => {} };

const byId = new Map(SETTINGS.map((s) => [s.id, s]));

function readStored(def) {
  if (def.scope === 'server') {
    const v = serverBridge.get(def.id);
    return v == null ? def.default : v;
  }
  const raw = localStorage.getItem(STORE_PREFIX + def.id);
  if (raw == null) return def.default;
  if (def.type === 'toggle') return raw === '1';
  return raw;
}

function writeStored(def, value) {
  if (def.scope === 'server') { serverBridge.set(def.id, value); return; }
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

function rowHtml(def) {
  const on = readStored(def);
  // type dispatch: only 'toggle' today, but the switch keeps the door open for
  // select/number rows without touching the open/close/escape wiring below.
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

  body.addEventListener('click', (e) => {
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
}
