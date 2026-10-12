import { esc } from './util.js';
import { keybindings } from './keybindings.js';

// The settings modal's Shortcuts section, rendered from the keybinding
// registry (keybindings.js): core groups first, then one group per extension
// that bound keys. `registry` is overridable for tests.
export function shortcutsHtml(registry = keybindings) {
  return registry.describe().map(({ group, rows }) => `
    <div class="shortcuts-group">
      <div class="shortcuts-group-title">${esc(group)}</div>
      ${rows.map(({ keys, description }) => `
        <div class="shortcut-row">
          <span class="shortcut-desc">${esc(description)}</span>
          <span class="shortcut-keys">${esc(keys)}</span>
        </div>`).join('')}
    </div>`).join('');
}
