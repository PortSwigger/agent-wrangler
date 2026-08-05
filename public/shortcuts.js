import { esc } from './util.js';

// Static reference for the settings modal's Shortcuts section. Hand-maintained —
// not wired to the actual key listeners (app.js, diff-view.js, history.js) — so
// keep this in sync by hand whenever a binding changes there.
const SHORTCUTS = [
  {
    group: 'Board',
    rows: [
      ['Shift+⌘+←/→/↑/↓', 'Switch task / session (axes flip with "Flip navigating task / session hotkeys")'],
      ['Enter', 'Open the dispatch dialog for the selected new-session slot'],
      ['⌃⌘N', 'New session'],
      ['⌃⌘T', 'Toggle a shell terminal in the selected session'],
      ['⌃⌘B', 'Fork (branch) the selected session'],
      ['⌃⌘R', 'Restart the selected session'],
      ['⌃⌘P', 'Peer review the selected session'],
      ['⌃⌘M', 'Maximize / restore the panel'],
      ['⌃⌘S', 'Snooze / unsnooze the selected session'],
      ['⌃⌘G', 'Toggle the working-tree diff panel'],
      ['⌃⌘⌫ / Delete', 'Archive the selected session'],
      ['Escape', 'Close the open dialog or panel'],
    ],
  },
  {
    group: 'History',
    rows: [
      ['/', 'Focus the history search field'],
    ],
  },
  {
    group: 'Diff panel',
    rows: [
      ['⌘/⌃+Enter', 'Send all draft comments to the agent'],
      ['Escape', 'Close the comment editor, then the panel'],
    ],
  },
  {
    group: 'Terminal',
    rows: [
      ['Shift+Enter', 'Send a literal Alt+Enter to the agent'],
      ['⌘+←/→', 'Move cursor by word'],
      ['⌘+⌫', 'Clear the current line'],
    ],
  },
];

export function shortcutsHtml() {
  return SHORTCUTS.map(({ group, rows }) => `
    <div class="shortcuts-group">
      <div class="shortcuts-group-title">${esc(group)}</div>
      ${rows.map(([keys, desc]) => `
        <div class="shortcut-row">
          <span class="shortcut-desc">${esc(desc)}</span>
          <span class="shortcut-keys">${esc(keys)}</span>
        </div>`).join('')}
    </div>`).join('');
}
