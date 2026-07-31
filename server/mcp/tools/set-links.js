import { z } from 'zod';
import { normaliseLinks } from '../links.js';

// Replace the caller's links for one scope. The agent sends the FULL desired
// list (get_links first). URL is resolved per link: explicit url > jiraBaseUrl +
// key > key only. Returns the canonical stored list (urls filled in).
export const setLinksTool = {
  name: 'set_links',
  description:
    'Replace the links on your current task or your session. Send the FULL list you '
    + 'want (call get_links first so you do not drop existing links). Each link is '
    + '{type:"jira", key?, url?} with at least one of key/url; url is auto-built from '
    + 'the configured Jira base + key when omitted. scope is required: default to '
    + '"session" (the link belongs to this session); use "task" (shared across every '
    + 'session of the task) only when the user explicitly says so. Record the Jira issue this work belongs to here.'
    + ' PR links are {type:"pr", url:"https://github.com/owner/repo/pull/N"}; the board polls their CI status.'
    + ' To drop individual links without resending the full list, use remove_links instead.',
  inputSchema: {
    scope: z.enum(['task', 'session']).describe('Which scope to write: "session" (default; this session) or "task" (shared; only when the user says the link belongs to the whole task).'),
    links: z.array(z.object({
      type: z.string().describe('Link type: "jira" or "pr".'),
      key: z.string().optional().describe('Jira issue key, e.g. ENT-10904 (jira only).'),
      url: z.string().optional().describe('Jira url (optional) or the GitHub pull-request url (required for pr).'),
    })).describe('The full replacement list of links.'),
  },
  async handler({ deps, caller }, args = {}) {
    const baseUrl = deps.config.jiraBaseUrl();
    let links;
    try {
      links = normaliseLinks(args.links, baseUrl);
    } catch (e) {
      return errorResult(e.message);
    }
    let ownerId;
    if (args.scope === 'task') {
      const task = caller != null ? deps.taskStore.taskFor(caller) : null;
      if (!task) return errorResult('You have no task assigned, so there is no task to attach links to. Use scope "session" instead, or ask the user to assign this session to a task.');
      deps.taskStore.setLinks(task.id, links);
      ownerId = task.id;
    } else {
      if (caller == null) return errorResult('This request carried no session identity, so session links cannot be written.');
      deps.sessionManager.setLinks(caller, links);
      ownerId = caller;
    }
    // Kick an immediate status fetch for any pr link just stored (the server
    // wires this; absent in unit tests with no hook).
    if (links.some((l) => l.type === 'pr')) deps.onPrLinksChanged?.(args.scope, ownerId);
    const structuredContent = { scope: args.scope, links };
    return {
      content: [{ type: 'text', text: JSON.stringify(structuredContent, null, 2) }],
      structuredContent,
    };
  },
};

function errorResult(message) {
  return { content: [{ type: 'text', text: message }], isError: true };
}
