import { z } from 'zod';
import { requestRepos } from '../../locations/repo-access.js';
import { MAX_REPO_REQUEST_WHY } from '../../session-manager.js';

export const requestRepoTool = {
  name: 'request_repo',
  description:
    'For a session running at a remote location (a runtime with a location): ask the human to let THIS session '
    + 'reach more GitHub repos, including any withheld when you were spawned. There you can clone and fetch only the repos your session was given, so '
    + 'when you need another one, ask here instead of working around a refused clone. The human sees the '
    + 'repos and your reason and allows or declines; you get mail either way, and an allowed request\'s '
    + 'mail says where to clone. Carry on with what you can meanwhile. Returns the request, or '
    + '`request: null` when you already have or have asked for every repo named.',
  inputSchema: {
    repos: z.array(z.string().min(1).max(200)).min(1).max(10).describe('Each repo as owner/name, e.g. "acme/widgets".'),
    why: z.string().min(1).max(MAX_REPO_REQUEST_WHY).describe('One sentence for the human: what you need the repos for.'),
  },
  async handler({ deps, caller }, args = {}) {
    if (caller == null) return errorResult('This request carried no session identity, so there is no session to add repos to.');
    try {
      const { request } = requestRepos(deps, caller, args.repos, args.why);
      if (request) await deps.rebuild?.();
      const structuredContent = request
        ? { request: { id: request.id, repos: request.repos }, note: 'Asked the human. You will get mail when they answer; carry on with what you can meanwhile.' }
        : { request: null, note: 'This session already has, or has already asked for, every repo named.' };
      return { content: [{ type: 'text', text: JSON.stringify(structuredContent, null, 2) }], structuredContent };
    } catch (e) {
      return errorResult(e?.message || 'Could not ask for the repos.');
    }
  },
};

function errorResult(message) {
  return { content: [{ type: 'text', text: message }], isError: true };
}
