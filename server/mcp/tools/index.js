import { listSessionsTool } from './list-sessions.js';
import { listTasksTool } from './list-tasks.js';
import { assignSessionTool } from './assign-session.js';
import { getSessionActivityTool } from './get-session-activity.js';
import { spawnSessionTool } from './spawn-session.js';
import { spawnWorkflowTool } from './spawn-workflow.js';
import { getLinksTool } from './get-links.js';
import { setLinksTool } from './set-links.js';
import { removeLinksTool } from './remove-links.js';
import { workflowPhaseTool } from './workflow-phase.js';
import { nameBranchTool } from './name-branch.js';
import { sendMessageTool } from './send-message.js';
import { archiveSessionTool } from './archive-session.js';
import { detachSessionTool } from './detach-session.js';
import { attachSessionTool } from './attach-session.js';
import { scheduleSessionTool } from './schedule-session.js';
import { createTerminalTool } from './create-terminal.js';

// The MCP tool registry. Adding a capability = adding a module here. Each tool:
// { name, description, inputSchema (zod raw shape), handler({deps, caller}, args) }.
export const TOOLS = [listSessionsTool, listTasksTool, assignSessionTool, getSessionActivityTool, spawnSessionTool, spawnWorkflowTool, getLinksTool, setLinksTool, removeLinksTool, workflowPhaseTool, nameBranchTool, sendMessageTool, archiveSessionTool, detachSessionTool, attachSessionTool, scheduleSessionTool, createTerminalTool];
