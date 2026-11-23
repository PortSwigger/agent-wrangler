// The collapsed "minimised" card for the dispatch dialog: what it shows, and
// when a fresh open should bring the minimised draft back rather than replace it.
// Pure, so the rules unit-test without the DOM.

export const SNIPPET_MAX = 90;

// Collapse whitespace and cut to `max` characters with an ellipsis.
export function snippet(text, max = SNIPPET_MAX) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

// { title, task, intent } for the card. `task` is null when no task is picked
// (the select's empty "no task" option), `intent` null when nothing is typed yet.
export function minimizedSummary({ title, taskId, taskName, intent }) {
  return {
    title: title || 'Dispatch a new session',
    task: taskId ? (taskName || null) : null,
    intent: snippet(intent) || null,
  };
}

// A plain "new session" open (button, shortcut, task menu) while a launch draft
// is minimised restores that draft instead of wiping it — unless the open asks
// for something the draft is not: another task, or prefilled options.
export function shouldRestoreMinimized({ minimized, mode, draftTaskId, taskId, opts }) {
  if (!minimized || mode !== 'launch') return false;
  if (opts && Object.keys(opts).length) return false;
  return taskId == null || taskId === draftTaskId;
}
