import { z } from 'zod';
import { normaliseLinks } from '../links.js';

// Replace the caller's links for one scope. The agent sends the FULL desired
// list (get_links first). A link type other than `pr` is normalised by the
// extension that claims it (deps.claimLink); a stored link whose extension is
// now off passes through unchanged. Returns the canonical stored list.
export const setLinksTool = {
  name: 'set_links',
  description:
    'Replace the links on your current task or your session. Send the FULL list you '
    + 'want (call get_links first so you do not drop existing links). Each link is '
    + '{type, key?, url?}. scope is required: default to '
    + '"session" (the link belongs to this session); use "task" (shared across every '
    + 'session of the task) only when the user explicitly says so.'
    + ' PR links are {type:"pr", url:"https://github.com/owner/repo/pull/N"}; the board polls their CI status.'
    + ' Jira links are {type:"jira", key?, url?} with at least one of key/url (url is built from the configured Jira base URL when omitted); record the Jira issue this work belongs to here. Other types exist only while the extension that owns them is enabled.'
    + ' To drop individual links without resending the full list, use remove_links instead.',
  inputSchema: {
    scope: z.enum(['task', 'session']).describe('Which scope to write: "session" (default; this session) or "task" (shared; only when the user says the link belongs to the whole task).'),
    links: z.array(z.object({
      type: z.string().describe('Link type: "pr", or "jira" while the Jira extension is enabled.'),
      key: z.string().optional().describe('Jira issue key, e.g. ENT-10904 (jira only).'),
      url: z.string().optional().describe('Jira url (optional) or the GitHub pull-request url (required for pr).'),
      checkStatus: z.string().optional(),
      checkStatusFetchedAt: z.string().optional(),
      headSha: z.string().optional(),
      dirty: z.boolean().optional(),
      unresolvedCount: z.number().optional(),
    })).describe('The full replacement list of links.'),
  },
  async handler({ deps, caller }, args = {}) {
    let store;
    let ownerId;
    if (args.scope === 'task') {
      const task = caller != null ? deps.taskStore.taskFor(caller) : null;
      if (!task) return errorResult('You have no task assigned, so there is no task to attach links to. Use scope "session" instead, or ask the user to assign this session to a task.');
      store = deps.taskStore;
      ownerId = task.id;
    } else {
      if (caller == null) return errorResult('This request carried no session identity, so session links cannot be written.');
      store = deps.sessionManager;
      ownerId = caller;
    }
    let links;
    try {
      links = normaliseLinks(args.links, { claim: deps.claimLink, existing: store.getLinks?.(ownerId) || [] });
    } catch (e) {
      return errorResult(e.message);
    }
    store.setLinks(ownerId, links);
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
