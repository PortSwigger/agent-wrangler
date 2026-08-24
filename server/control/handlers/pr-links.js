import { linkMatches } from '../../mcp/links.js';

export function linkedPrs(sessionId, ctx) {
  const links = [];
  if (ctx.sessionManager?.getLinks) links.push(...(ctx.sessionManager.getLinks(sessionId) || []));
  const task = ctx.taskStore?.taskFor?.(sessionId);
  if (task && ctx.taskStore?.getLinks) links.push(...(ctx.taskStore.getLinks(task.id) || []));
  return links.filter((l) => l?.type === 'pr' && typeof l.url === 'string');
}

export function linkedPrForUrl(sessionId, url, ctx) {
  return linkedPrs(sessionId, ctx).find((l) => linkMatches(l, { type: 'pr', url })) || null;
}
