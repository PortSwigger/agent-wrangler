// The deck action each control message the board sends maps to. The board
// keeps its own table rather than reading the deck's, because it is the
// board that decides what it calls; deck-actions.test.js checks every row
// against the names the deck advertises.
export const BOARD_ACTIONS = {
  'dispatch': 'session.dispatch',
  'validate-worktree': 'session.validate-worktree',
  'message': 'session.message',
  'resume': 'session.resume',
  'fork': 'session.fork',
  'archive': 'session.archive',
  'stop-container': 'session.stop-container',
  'worktree-remove': 'session.worktree-remove',
  'branch-delete': 'session.branch-delete',
  'remove': 'session.remove',
  'rename': 'session.rename',
  'detach': 'session.detach',
  'attach': 'session.attach',
  'snooze-set': 'session.snooze-set',
  'snooze-clear': 'session.snooze-clear',
  'auto-fix-pr-checks': 'session.auto-fix-pr-checks',
  'auto-merge-on-pass': 'session.auto-merge-on-pass',
  'set-child-full-view': 'session.set-child-full-view',
  'set-session-model': 'session.set-model',
  'open-terminal-for-session': 'session.open-terminal',
  'view-diff': 'session.view-diff',
  'diff-comments': 'session.diff-comments',
  'subagent-detail': 'session.subagent-detail',
  'chat': 'session.chat',
  'interrupt': 'session.interrupt',
  'paste-image': 'session.paste-image',
  'adopt-conversation': 'session.adopt-conversation',

  'task-create': 'task.create',
  'task-rename': 'task.rename',
  'task-archive': 'task.archive',
  'task-delete': 'task.delete',
  'task-unarchive': 'task.unarchive',
  'task-assign': 'task.assign',
  'task-reorder': 'task.reorder',
  'task-reorder-sessions': 'task.reorder-sessions',

  'schedule-create': 'schedule.create',
  'schedule-update': 'schedule.update',
  'schedule-delete': 'schedule.delete',
  'schedule-toggle': 'schedule.toggle',
  'schedule-run-now': 'schedule.run-now',

  'browse-folders': 'deck.browse-folders',
  'usage': 'deck.usage',
  'search': 'deck.search',
  'search-status': 'deck.search-status',
  'search-reindex': 'deck.search-reindex',

  'set-auto-fix-pr-checks-default': 'admin.set-auto-fix-pr-checks-default',
  'set-trust-codex-launch-cwd': 'admin.set-trust-codex-launch-cwd',
  'set-trust-claude-launch-cwd': 'admin.set-trust-claude-launch-cwd',
  'set-mail-wakes-dormant': 'admin.set-mail-wakes-dormant',
  'set-pr-model-footer': 'admin.set-pr-model-footer',
  'set-default-session-cwd': 'admin.set-default-session-cwd',
  'set-default-runtime': 'admin.set-default-runtime',
  'set-background-model': 'admin.set-background-model',
  'set-codex-policy-default': 'admin.set-codex-policy-default',
  'set-auto-update-mode': 'admin.set-auto-update-mode',
  'set-refresh-sessions-after-update': 'admin.set-refresh-sessions-after-update',
  'restart-server': 'admin.restart-server',
  'restart-tmux': 'admin.restart-tmux',
  'update-check': 'admin.update-check',
  'update-apply': 'admin.update-apply',
  'extension-enabled': 'admin.extension-enabled',
  'ext-setting-set': 'admin.ext-setting-set',
  'ext-install': 'admin.ext-install',
  'ext-consent': 'admin.ext-consent',
  'ext-uninstall': 'admin.ext-uninstall',
  'ext-check-updates': 'admin.ext-check-updates',
  'ext-set-auto-update': 'admin.ext-set-auto-update',
  'ext-set-early-adopter': 'admin.ext-set-early-adopter',
  'ext-browse': 'admin.ext-browse',
};

// A frame's action: a core type through the table, an extension's own type
// as ext.<id>.<type>.
export function actionFor(frame, extId = null) {
  const type = frame && typeof frame === 'object' ? frame.type : null;
  if (typeof type !== 'string' || !type) return null;
  if (extId) return `ext.${extId}.${type}`;
  return Object.hasOwn(BOARD_ACTIONS, type) ? BOARD_ACTIONS[type] : null;
}

// Adopting takes the id of a conversation that is not a session yet, so the
// deck must not look it up as one.
const NOT_A_SESSION = new Set(['session.adopt-conversation']);

// A control message as an action call: a session.* action acts on the
// message's sessionId, and every other field is passed on as args.
export function toActionCall(frame, extId = null) {
  const action = actionFor(frame, extId);
  if (!action) return null;
  const { type: _type, ...args } = frame;
  const session = action.startsWith('session.') && !NOT_A_SESSION.has(action) && typeof args.sessionId === 'string' ? args.sessionId : null;
  return { action, session, args };
}
