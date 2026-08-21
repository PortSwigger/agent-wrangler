import { dispatchHandler } from './dispatch.js';
import { validateWorktreeHandler } from './validate-worktree.js';
import { messageHandler } from './message.js';
import { resumeHandler } from './resume.js';
import { forkHandler } from './fork.js';
import { archiveHandler, stopContainerHandler } from './archive.js';
import { worktreeRemoveHandler, branchDeleteHandler } from './worktree.js';
import { removeHandler } from './remove.js';
import { renameHandler } from './rename.js';
import { detachHandler } from './detach.js';
import { attachHandler } from './attach.js';
import { snoozeSetHandler, snoozeClearHandler } from './snooze.js';
import { autoFixPrChecksHandler } from './auto-fix-pr-checks.js';
import { autoFixPrChecksDefaultHandler } from './auto-fix-pr-checks-default.js';
import { autoMergeOnPassHandler } from './auto-merge-on-pass.js';
import { taskMemoryEnabledHandler } from './task-memory-enabled.js';
import { subagentsExpandedByDefaultHandler } from './subagents-expanded-by-default.js';
import { trustCodexLaunchCwdHandler } from './trust-codex-launch-cwd.js';
import { childFullViewHandler } from './child-full-view.js';
import { childFullViewDefaultHandler } from './child-full-view-default.js';
import {
  taskCreateHandler,
  taskRenameHandler,
  taskArchiveHandler,
  taskUnarchiveHandler,
  taskAssignHandler,
  taskReorderHandler,
  taskReorderSessionsHandler,
} from './tasks.js';
import {
  todoAddHandler,
  todoEditHandler,
  todoDeleteHandler,
  todoMoveHandler,
} from './todos.js';
import { getMemoryHandler, setMemoryHandler } from './memory.js';
import {
  scheduleCreateHandler,
  scheduleUpdateHandler,
  scheduleDeleteHandler,
  scheduleToggleHandler,
  scheduleRunNowHandler,
} from './schedules.js';
import { refreshHandler } from './refresh.js';
import { openTerminalForSessionHandler } from './open-terminal-for-session.js';
import { viewDiffHandler } from './view-diff.js';
import { diffCommentsHandler } from './diff-comments.js';
import { subagentDetailHandler } from './subagent-detail.js';
import { usageHandler } from './usage.js';
import { searchHandler, searchStatusHandler, searchReindexHandler } from './search.js';
import { adoptConversationHandler } from './adopt.js';
import { cloudPreflightHandler } from './cloud-preflight.js';
import { cloudEnvironmentsHandler } from './cloud-environments.js';
import { teleportHandler } from './teleport.js';

// The control-WS handler registry, mirroring server/mcp/tools. Adding a message
// type = adding a module here. Each handler: { type, handler(msg, ctx) }, where
// ctx bundles sessionManager/taskStore/memoryStore/scheduleStore/rebuild/reply/graph
// + the graph-target resolvers (sessionFromGraph/tmuxFor/socketFor) and
// runSchedule (the shared schedule-firing routine).
export const CONTROL_HANDLERS = [
  dispatchHandler,
  validateWorktreeHandler,
  messageHandler,
  resumeHandler,
  forkHandler,
  archiveHandler,
  stopContainerHandler,
  worktreeRemoveHandler,
  branchDeleteHandler,
  removeHandler,
  renameHandler,
  detachHandler,
  attachHandler,
  snoozeSetHandler,
  snoozeClearHandler,
  autoFixPrChecksHandler,
  autoFixPrChecksDefaultHandler,
  autoMergeOnPassHandler,
  taskMemoryEnabledHandler,
  subagentsExpandedByDefaultHandler,
  trustCodexLaunchCwdHandler,
  childFullViewHandler,
  childFullViewDefaultHandler,
  taskCreateHandler,
  taskRenameHandler,
  taskArchiveHandler,
  taskUnarchiveHandler,
  taskAssignHandler,
  taskReorderHandler,
  taskReorderSessionsHandler,
  todoAddHandler,
  todoEditHandler,
  todoDeleteHandler,
  todoMoveHandler,
  getMemoryHandler,
  setMemoryHandler,
  scheduleCreateHandler,
  scheduleUpdateHandler,
  scheduleDeleteHandler,
  scheduleToggleHandler,
  scheduleRunNowHandler,
  refreshHandler,
  openTerminalForSessionHandler,
  viewDiffHandler,
  diffCommentsHandler,
  subagentDetailHandler,
  usageHandler,
  searchHandler,
  searchStatusHandler,
  searchReindexHandler,
  adoptConversationHandler,
  cloudPreflightHandler,
  cloudEnvironmentsHandler,
  teleportHandler,
];

export const HANDLER_BY_TYPE = Object.fromEntries(CONTROL_HANDLERS.map((h) => [h.type, h]));
