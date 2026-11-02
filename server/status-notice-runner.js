import { composeStatusNotice } from './status-notice-format.js';
import { lastAssistantText } from './last-assistant.js';

export function createStatusNoticeRunner(deps) {
  const { watcher, mailStore, sessionManager, deliver, log = () => {} } = deps;
  const failed = new Set();
  const held = new Map();
  const deliveries = new Map();
  const subscriberGone = (id) => {
    const entry = sessionManager.entryFor(id);
    return !entry || Boolean(entry.archivedAt);
  };
  return {
    blocked(id, now = Date.now()) {
      if (!deps.pending?.(id)) { held.delete(id); return false; }
      return held.has(id) && now - held.get(id) >= 120000;
    },
    async run(graph, now = Date.now()) {
      for (const id of held.keys()) if (!deps.pending?.(id)) held.delete(id);
      const events = watcher.tick(graph.sessions, (id) => sessionManager.entryFor(id), {
        now, mailSince: (c, s, since) => mailStore.sentSince(c, s, since),
      });
      for (const node of graph.sessions) {
        const to = sessionManager.entryFor(node.sessionId)?.statusNotify?.to;
        if (to && subscriberGone(to)) sessionManager.clearStatusNotify(node.sessionId);
      }
      const groups = new Map();
      for (const event of events) {
        const kind = event.kind === 'idle' ? 'idle-held' : event.kind;
        deps.events?.emit(`session-status:${kind}`, {
          sid: event.child.sessionId, kind, at: now,
          waitingFor: event.child.waitingFor ?? null,
          idleMs: event.idleMs, quietMs: event.quietMs, exitReason: event.exitReason,
        });
        if (event.to === null) continue;
        if (subscriberGone(event.to)) {
          if (sessionManager.entryFor(event.child.sessionId)?.statusNotify) sessionManager.clearStatusNotify(event.child.sessionId);
          continue;
        }
        if (!groups.has(event.to)) groups.set(event.to, []);
        groups.get(event.to).push(event);
      }
      const pending = [];
      for (const [to, group] of groups) {
        const job = (deliveries.get(to) ?? Promise.resolve()).then(async () => {
          try {
            if (subscriberGone(to)) return;
            const detail = new Map();
            for (const event of group) {
              const id = event.child.sessionId;
              if (event.kind === 'idle') detail.set(id, {
                unread: mailStore.unreadInfo(id).unread,
                lastSaid: await lastAssistantText({ ...sessionManager.entryFor(id), sessionId: id }, deps),
              });
            }
            const result = await deliver(to, composeStatusNotice(group, detail));
            if (result?.mode === 'deferred' || deps.pending?.(to)) {
              if (!held.has(to)) held.set(to, now);
            } else held.delete(to);
            failed.delete(to);
            if (result?.mode === 'dormant') await deps.onWoken?.(to);
          } catch (error) {
            if (!failed.has(to)) log(`[status-notice] delivery failed for ${to}:`, error?.message || error);
            failed.add(to);
          }
        });
        deliveries.set(to, job);
        pending.push(job.finally(() => {
          if (deliveries.get(to) === job) deliveries.delete(to);
        }));
      }
      await Promise.all(pending);
      for (const event of events) {
        if (event.kind !== 'exited') continue;
        sessionManager.clearStatusNotify(event.child.sessionId);
        watcher.forget(event.child.sessionId);
      }
    },
  };
}
