import { addRepos, answerRepoRequest } from '../../locations/repo-access.js';

export const addReposHandler = {
  type: 'add-repos',
  async handler(msg, ctx) {
    try {
      const { added } = await addRepos(ctx, msg.sessionId, Array.isArray(msg.repos) ? msg.repos : []);
      ctx.reply({ type: 'repos-added', sessionId: msg.sessionId, added });
    } catch (err) {
      ctx.reply({ type: 'error', message: err?.message || 'Could not add the repos.' });
    }
    await ctx.rebuild();
  },
};

export const repoRequestHandler = {
  type: 'repo-request',
  async handler(msg, ctx) {
    try {
      await answerRepoRequest(ctx, msg.sessionId, msg.requestId, msg.allow === true);
    } catch (err) {
      ctx.reply({ type: 'error', message: err?.message || 'Could not answer the request.' });
    }
    await ctx.rebuild();
  },
};
