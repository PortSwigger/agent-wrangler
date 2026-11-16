import { COMPOSER_BLOCKED_REASON } from './pane-deferral.js';

export const BLOCKED_AFTER_MS = 5 * 60_000;

export function createNotificationBlocks({ entryFor, mailStore, events, isPending = () => true, log = () => {} }) {
  const episodes = new Map();
  return {
    deferred(id, reason, now = Date.now()) {
      if (!reason?.startsWith(COMPOSER_BLOCKED_REASON)) return;
      if (!episodes.has(id)) episodes.set(id, { since: now, reported: false, mailed: new Set() });
    },
    resolved(id) { episodes.delete(id); },
    blocked(id, now = Date.now()) {
      const ep = episodes.get(id);
      return Boolean(ep && now - ep.since >= BLOCKED_AFTER_MS);
    },
    sweep(now = Date.now()) {
      for (const [id, ep] of episodes) {
        const entry = entryFor(id);
        if (!entry || entry.archivedAt || entry.snooze || !isPending(id)) { episodes.delete(id); continue; }
        if (now - ep.since < BLOCKED_AFTER_MS) continue;
        if (!ep.reported) {
          events.emit('session-notification:blocked', { sid: id, reason: 'composer-not-empty', since: ep.since, at: now });
          ep.reported = true;
        }
        for (const to of new Set([entry.spawnedBy, entry.parentSession])) {
          if (!to || to === id || ep.mailed.has(to)) continue;
          const supervisor = entryFor(to);
          if (!supervisor || supervisor.archivedAt) continue;
          try {
            mailStore.append(to, { from: id, fromLabel: 'Agent Wrangler',
              body: `Automated notifications for [this session](#session=${id}) have been blocked by unsent text in its prompt box for at least five minutes. Review the draft in that session and submit or remove it when appropriate. Agent Wrangler has left the text untouched. Replies to this message go to the blocked session and may remain unread until its prompt box is clear.` }, now);
            ep.mailed.add(to);
          } catch (error) { log(`[notification-blocked] could not notify ${to}: ${error?.message || error}`); }
        }
      }
    },
  };
}
