import { listSessionsTool } from './list-sessions.js';
import { getSessionInfoTool } from './get-session-info.js';
import { getSessionCostTool } from './get-session-cost.js';
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
import { renameSessionTool } from './rename-session.js';
import { scheduleSessionTool } from './schedule-session.js';
import { createTerminalTool } from './create-terminal.js';
import { readMailTool } from './read-mail.js';
import { listMailTool } from './list-mail.js';
import { addChecklistItemTool } from './add-checklist-item.js';
import { updateChecklistItemTool } from './update-checklist-item.js';
import { removeChecklistItemTool } from './remove-checklist-item.js';
import { listChecklistTool } from './list-checklist.js';
import { CHECKLIST_TOOLS } from '../client-config.js';
import { checklistEnabled } from '../../config-store.js';
import { getExtensions } from '../../extensions/index.js';

// The CORE MCP tool registry. Adding a core capability = adding a module here.
// Each tool: { name, description, inputSchema (zod raw shape),
// handler({deps, caller}, args) }. A new CORE tool must ALSO be added to
// client-config.js's ALLOWED_TOOLS — registering here without allow-listing
// there ships a tool that passes tests and dies silently in a real launch
// (CLAUDE.md; asserted by client-config.test.js for read_mail/list_mail). An
// EXTENSION's tools (server/extensions/*/index.js `tools`) are exempt from that
// two-place rule: the loader derives their launch grant from the same list it
// registers, so they exist in exactly one place.
export const TOOLS = [listSessionsTool, getSessionInfoTool, getSessionCostTool, listTasksTool, assignSessionTool, getSessionActivityTool, spawnSessionTool, spawnWorkflowTool, getLinksTool, setLinksTool, removeLinksTool, workflowPhaseTool, nameBranchTool, sendMessageTool, archiveSessionTool, detachSessionTool, attachSessionTool, renameSessionTool, scheduleSessionTool, createTerminalTool, readMailTool, listMailTool, addChecklistItemTool, updateChecklistItemTool, removeChecklistItemTool, listChecklistTool];

// The tools a request actually gets: the core set (less the four checklist tools
// when `checklistEnabled: false` — the one core feature flag that can remove
// some) plus every ENABLED extension's tools. Either way the removal is genuine
// unregistration, not a mere un-grant, so a disabled install doesn't advertise a
// capability its UI won't render. TOOLS itself stays the full, unfiltered core
// registry — that is what client-config.test.js's two-place assertion reads.
// `checklist` and `ext` are injectable (defaulting to the live read and the
// boot-loaded extensions) so tests never touch config.json or the memo.
export function activeTools({ checklist = checklistEnabled(), ext = getExtensions() } = {}) {
  const core = checklist ? TOOLS : TOOLS.filter((t) => !CHECKLIST_TOOLS.includes(t.name));
  return [...core, ...ext.tools];
}
