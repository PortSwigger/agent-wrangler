// The board's own shortcuts, as registry definitions (see keybindings.js).
// Kept apart from app.js so the Shortcuts tab's content is testable: app.js
// supplies each binding's `run`/`when` by id, and an id with no handler is
// registered display-only (that is all a test needs, and also how bindings
// handled elsewhere — settings.js's ⌃⌘, the terminal's chords — are listed).

export const CORE_BINDINGS = [
  // ── Board ──
  {
    id: 'board.nav', group: 'Board', scope: 'board',
    combo: ['shift+cmd+left', 'shift+cmd+right', 'shift+cmd+up', 'shift+cmd+down'],
    description: 'Switch task / session (axes flip with "Flip navigating task / session hotkeys")',
  },
  { id: 'board.openSlot', group: 'Board', scope: 'board', combo: 'enter', description: 'Open the dispatch dialog for the selected new-session slot' },
  { id: 'board.cardActivate', group: 'Board', scope: 'board', combo: ['enter', 'space'], description: 'Open the focused session card' },
  { id: 'chord.new', group: 'Board', scope: 'global', capture: true, combo: 'ctrl+cmd+n', description: 'New session' },
  { id: 'chord.terminal', group: 'Board', scope: 'global', capture: true, combo: 'ctrl+cmd+t', description: 'Toggle a shell terminal in the selected session' },
  { id: 'chord.fork', group: 'Board', scope: 'global', capture: true, combo: 'ctrl+cmd+b', description: 'Fork (branch) the selected session' },
  { id: 'chord.restart', group: 'Board', scope: 'global', capture: true, combo: 'ctrl+cmd+r', description: 'Restart the selected session' },
  { id: 'chord.peerReview', group: 'Board', scope: 'global', capture: true, combo: 'ctrl+cmd+p', description: 'Peer review the selected session' },
  { id: 'chord.maximize', group: 'Board', scope: 'global', capture: true, combo: 'ctrl+cmd+m', description: 'Maximize / restore the panel' },
  { id: 'chord.snooze', group: 'Board', scope: 'global', capture: true, combo: 'ctrl+cmd+s', description: 'Snooze / unsnooze the selected session' },
  // preventAlways: the diff chord is swallowed even where it can't act (Search
  // view, a modal, a text input), as it was before the registry.
  { id: 'chord.diff', group: 'Board', scope: 'global', capture: true, preventAlways: true, combo: 'ctrl+cmd+g', description: 'Toggle the working-tree diff panel' },
  { id: 'chord.hints', group: 'Board', scope: 'global', capture: true, combo: 'ctrl+cmd+a', description: 'Jump to any session: label every card with a letter, then type it' },
  { id: 'settings.open', group: 'Board', scope: 'global', combo: 'ctrl+cmd+,', description: 'Open Settings' },
  {
    id: 'chord.archive', group: 'Board', scope: 'global', capture: true,
    combo: ['ctrl+cmd+backspace', 'ctrl+cmd+delete'],
    description: 'Archive the selected session',
  },
  { id: 'modal.close', group: 'Board', scope: 'modal', combo: 'escape', description: 'Close the open dialog or panel' },
  // ── Search ──
  { id: 'search.open', group: 'Search', scope: 'global', combo: '/', description: 'Open the Search view and focus its input' },
  // ── Dispatch dialog ──
  { id: 'dispatch.submit', group: 'Dispatch dialog', scope: 'dispatch', combo: ['mod+enter', 'ctrl+enter'], description: 'Launch the session' },
  {
    id: 'dispatch.quickLaunch', group: 'Dispatch dialog', scope: 'dispatch',
    combo: ['mod+1', 'mod+2', 'mod+3', 'ctrl+1', 'ctrl+2', 'ctrl+3'], display: '⌘1–⌘3',
    description: 'Quick-launch with the first, second or third model',
  },
  { id: 'dispatch.cancel', group: 'Dispatch dialog', scope: 'dispatch', combo: 'escape', description: 'Cancel the dialog' },
  // ── Diff panel (handled in diff-view.js) ──
  { id: 'diff.send', group: 'Diff panel', scope: 'global', combo: ['mod+enter', 'ctrl+enter'], description: 'Send all draft comments to the agent' },
  { id: 'diff.close', group: 'Diff panel', scope: 'global', combo: 'escape', description: 'Close the comment editor, then the panel' },
  // ── Terminal (handled by the xterm key handler in app.js) ──
  { id: 'term.newline', group: 'Terminal', scope: 'global', combo: 'shift+enter', description: 'Send a literal Alt+Enter to the agent' },
  { id: 'term.word', group: 'Terminal', scope: 'global', combo: ['cmd+left', 'cmd+right'], description: 'Move cursor by word' },
  { id: 'term.clearLine', group: 'Terminal', scope: 'global', combo: 'cmd+backspace', description: 'Clear the current line' },
];

// Registers every core binding; `handlers[id]` = { run, when } wires the live
// ones. Returns one function that unregisters them all.
export function registerCoreBindings(registry, handlers = {}) {
  const offs = CORE_BINDINGS.map((def) => {
    const h = handlers[def.id] || {};
    return registry.register({ ...def, run: h.run, when: h.when, owner: 'core' });
  });
  return () => offs.forEach((off) => off());
}
