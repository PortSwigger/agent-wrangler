import { deliverMailNotification } from './mailbox-delivery.js';
import { composeMailNotification } from './mail-notification.js';
import { log as defaultLog } from './log.js';

// A held notification is silent by design, so one stuck for good looks exactly
// like one waiting out a long turn. After this long, say why — once.
export const DEFER_LOG_AFTER_MS = 60_000;
// A recipient not deferred for this long has been delivered, read or dropped by
// some other path, so its next deferral starts a fresh episode. Comfortably
// above the ~10s settle retry so a live episode is never split.
const DEFER_EPISODE_GAP_MS = 30_000;

// Per-recipient deferral episodes, logged once each when they outlast
// DEFER_LOG_AFTER_MS. In memory: a restart starts the clock again, which only
// delays a log line.
export function createDeferralTracker({ log = defaultLog } = {}) {
  const episodes = new Map();
  return {
    deferred(to, reason, now) {
      let ep = episodes.get(to);
      if (!ep || now - ep.lastAt > DEFER_EPISODE_GAP_MS) {
        ep = { since: now, lastAt: now, logged: false };
        episodes.set(to, ep);
      }
      ep.lastAt = now;
      if (!ep.logged && now - ep.since >= DEFER_LOG_AFTER_MS) {
        ep.logged = true;
        log(`[mail] notification to ${to} deferred ${Math.round((now - ep.since) / 1000)}s: ${reason || 'unknown reason'}`);
      }
    },
    resolved(to) { episodes.delete(to); },
    prune(now) {
      for (const [to, ep] of episodes) if (now - ep.lastAt > DEFER_EPISODE_GAP_MS) episodes.delete(to);
    },
  };
}

// Process every due settle window and deliver only to live, idle recipients.
// Dormant mail stays unread and is retried until the session is resumed.
// `takeDueSettles` durably marks attempts in progress and load recovery re-opens
// them after a server restart. The in-flight guard prevents overlapping sweeps.
// Isolates failures per recipient so one bad delivery can't abort the sweep.
export async function sweepDueSettles(deps, now = Date.now()) {
  const { mailStore, onError, deferrals } = deps;
  let notified = 0;
  const reopen = new Set();
  for (const to of mailStore.takeDueSettles(now)) {
    try {
      const pending = mailStore.unreadMessages(to);
      if (!pending.length) {
        mailStore.clearSettle(to);
        deferrals?.resolved(to);
        continue;
      }
      const mode = await deliverMailNotification(to, composeMailNotification(pending), deps);
      if (mode.mode === 'skip') {
        mailStore.markUndeliverable(to);
        deferrals?.resolved(to);
      } else if (mode.mode === 'error') {
        // Re-arm a fresh settle window after failed delivery.
        reopen.add(to);
        onError?.(to, new Error(mode.error || 'mail delivery failed'));
      } else if (mode.mode === 'deferred') {
        reopen.add(to);
        deferrals?.deferred(to, mode.reason, now);
      } else {
        mailStore.markNotified(to, now);
        deferrals?.resolved(to);
        notified += 1;
      }
    } catch (err) {
      reopen.add(to);
      try { onError?.(to, err); } catch { /* surfacing must never crash the sweep */ }
    }
  }
  mailStore.reopenSettles([...reopen], now);
  deferrals?.prune(now);
  return notified;
}

// Build the guarded tick. A recent-resume MCP readiness wait can outlast the
// poll cadence, so overlapping sweeps are skipped.
export function createMailSettleSweeper(deps) {
  let sweeping = false;
  deps = { deferrals: createDeferralTracker({ log: deps.log }), ...deps };
  return async function sweep(now = Date.now()) {
    if (sweeping) return { skipped: true };
    sweeping = true;
    try {
      const notified = await sweepDueSettles(deps, now);
      return { skipped: false, notified };
    } finally {
      sweeping = false;
    }
  };
}
