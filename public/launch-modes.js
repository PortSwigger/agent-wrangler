import { esc } from './util.js';

const STORAGE_KEY = 'aw.dispatch.launchModes';
const quote = (value) => `'${String(value).replace(/'/g, "'\\''")}'`;
const icons = { lock: '▣', shield: '◇', unlock: '↗', edit: '✎' };

export function readModePreferences(storage) {
  try {
    const value = JSON.parse(storage.getItem(STORAGE_KEY));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}

export function saveModePreference(storage, agent, mode) {
  try { storage.setItem(STORAGE_KEY, JSON.stringify({ ...readModePreferences(storage), [agent]: mode })); } catch {}
}

export function chooseLaunchMode(section, preferred, ownLaunch = false) {
  const modes = section?.modes || [];
  const fallback = modes.find((m) => m.default) || modes[0] || null;
  if (ownLaunch && section?.field === 'permissionMode') return fallback;
  return modes.find((m) => m.id === preferred) || fallback;
}

export function launchPreview(agent, mode, dirs = []) {
  if (!mode) return '';
  return [agent, ...mode.flags.map(quote), ...(mode.folders ? dirs.flatMap((dir) => ['--add-dir', quote(dir)]) : [])].join(' ');
}

export function createLaunchModeChooser({ root, folders, preview, storage, dirs, onChange }) {
  let adapter = null;
  let ownLaunch = false;
  let choices = {};
  let savedChoice = null;
  const selected = () => chooseLaunchMode(adapter?.launchModes, choices[adapter?.id], ownLaunch);
  function renderPreview() {
    const mode = selected();
    preview.textContent = ownLaunch ? 'Runtime supplies its own launch command; adapter flags do not apply.' : launchPreview(adapter?.id, mode, dirs());
  }
  function render() {
    const section = adapter?.launchModes;
    const mode = selected();
    root.classList.toggle('hidden', !mode);
    folders.classList.toggle('hidden', !mode?.folders);
    if (!mode) { root.querySelector('.launch-mode-options').replaceChildren(); return; }
    root.querySelector('.launch-mode-label').textContent = section.label;
    const options = root.querySelector('.launch-mode-options');
    options.setAttribute('aria-label', `${adapter.label} ${section.label}`);
    options.innerHTML = section.modes.map((item) => {
      const unavailable = ownLaunch && section.field === 'permissionMode' && !item.default;
      return `<button type="button" class="launch-mode${item.id === mode.id ? ' selected' : ''}" data-launch-mode="${esc(item.id)}" aria-pressed="${item.id === mode.id}"${unavailable ? ' disabled aria-describedby="m-permission-runtime-note"' : ''}><span class="launch-mode-icon" aria-hidden="true">${icons[item.icon] || '◇'}</span><span><strong>${esc(item.name)}</strong><small>${esc(item.hint)}</small></span><span class="launch-mode-check" aria-hidden="true">${item.id === mode.id ? '✓' : ''}</span></button>`;
    }).join('');
    const note = root.querySelector('.launch-mode-runtime-note');
    note.textContent = ownLaunch ? (section.field === 'permissionMode' ? 'This runtime supplies its own launch command. Accept edits and Bypass are unavailable because it cannot apply Claude permission flags.' : 'This runtime supplies its own launch command; adapter sandbox flags do not apply.') : '';
    note.classList.toggle('hidden', !ownLaunch);
    root.querySelector('.launch-mode-preview-label').textContent = section.overridable ? 'Launches · core preview (extensions may override)' : 'Launches · permission flags';
    renderPreview();
  }
  root.addEventListener('click', (event) => {
    const button = event.target.closest('[data-launch-mode]');
    if (!button || button.disabled || !adapter) return;
    choices[adapter.id] = button.dataset.launchMode;
    saveModePreference(storage, adapter.id, button.dataset.launchMode);
    render();
    onChange();
    root.querySelector(`[data-launch-mode="${button.dataset.launchMode}"]`)?.focus();
  });
  return {
    open() { choices = readModePreferences(storage); savedChoice = null; },
    restore(saved) { savedChoice = saved; },
    sync(agent, runtimeOwnLaunch = false) {
      adapter = agent;
      ownLaunch = runtimeOwnLaunch;
      const section = adapter?.launchModes;
      if (savedChoice && section && adapter.id === (savedChoice.agent || 'claude')) {
        choices[adapter.id] = savedChoice[section.field] ?? section.modes.find((m) => m.default)?.id;
        savedChoice = null;
      }
      render();
    },
    fields() { const mode = selected(); return mode ? { [adapter.launchModes.field]: mode.id } : {}; },
    allowsFolders: () => selected()?.folders !== false,
    renderPreview,
  };
}

export function sessionPolicyHtml(session) {
  if (session.agent !== 'codex' || !session.codexPolicyFlags) return '';
  const source = session.codexPolicySource === 'core' ? 'core' : `extension: ${session.codexPolicySource}`;
  return `<span class="card-tag session-policy" title="${esc(session.codexPolicyFlags.map(quote).join(' '))}">Sandbox · ${esc(source)} <code>${esc(session.codexPolicyFlags.join(' '))}</code></span>`;
}
