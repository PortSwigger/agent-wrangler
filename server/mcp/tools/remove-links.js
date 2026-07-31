import { z } from 'zod';
import { linkMatches } from '../links.js';

// Drop specific links from one scope, matched by selector (Jira key/url or PR
// url). The surgical counterpart to set_links: no get-filter-rewrite round-trip
// needed. Removal is idempotent — a selector that matches nothing comes back
// under `notFound`, not as an error.
export const removeLinksTool = {
  name: 'remove_links',
  description:
    'Remove specific links from your current task or your session, matched by Jira key '
    + 'or url (jira) or pull-request url (pr). This is the surgical counterpart to '
    + 'set_links: drop individual links without resending the full list. Each selector '
    + 'is {type:"jira"|"pr", key?, url?} with at least one of key/url. scope is required '
    + '("task" or "session"). Selectors that match no stored link are returned under '
    + '"notFound" (removal is idempotent, not an error).',
  inputSchema: {
    scope: z.enum(['task', 'session']).describe('Which scope to remove from: "task" (shared) or "session".'),
    links: z.array(z.object({
      type: z.string().describe('Link type to match: "jira" or "pr".'),
      key: z.string().optional().describe('Jira issue key to match, e.g. ENT-10904 (jira only).'),
      url: z.string().optional().describe('Jira url or GitHub pull-request url to match.'),
    })).describe('Selectors for the links to remove; each needs type plus at least one of key/url.'),
  },
  async handler({ deps, caller }, args = {}) {
    const selectors = Array.isArray(args.links) ? args.links : [];
    // Selectors are match-only (never stored), so the only validation is that
    // each carries something to match on. An unknown `type` is NOT rejected —
    // linkMatches returns false on a type mismatch, so it lands in notFound.
    if (selectors.some((s) => !(s.key && s.key.trim()) && !(s.url && s.url.trim()))) {
      return errorResult('Each selector needs a key or url.');
    }
    let store;
    let ownerId;
    if (args.scope === 'task') {
      const task = caller != null ? deps.taskStore.taskFor(caller) : null;
      if (!task) return errorResult('You have no task assigned, so there is no task to remove links from. Use scope "session" instead, or ask the user to assign this session to a task.');
      store = deps.taskStore;
      ownerId = task.id;
    } else {
      if (caller == null) return errorResult('This request carried no session identity, so session links cannot be removed.');
      store = deps.sessionManager;
      ownerId = caller;
    }
    const current = store.getLinks(ownerId);
    const removed = current.filter((l) => selectors.some((s) => linkMatches(l, s)));
    const remaining = current.filter((l) => !selectors.some((s) => linkMatches(l, s)));
    const notFound = selectors.filter((s) => !current.some((l) => linkMatches(l, s)));
    store.setLinks(ownerId, remaining);
    // No onPrLinksChanged: removal stores no new pr link, so there is nothing to
    // fetch — the board drops the link on its normal reconcile.
    const structuredContent = { scope: args.scope, removed, links: remaining, notFound };
    return {
      content: [{ type: 'text', text: JSON.stringify(structuredContent, null, 2) }],
      structuredContent,
    };
  },
};

function errorResult(message) {
  return { content: [{ type: 'text', text: message }], isError: true };
}
