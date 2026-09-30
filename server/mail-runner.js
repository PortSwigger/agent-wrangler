import { deliverMailNotification } from './mailbox-delivery.js';
import { composeMailNotification } from './mail-notification.js';

// Process every due settle window and deliver only to live, idle recipients.
// Dormant mail stays unread and is retried until the session is resumed.
// `takeDueSettles` durably marks attempts in progress and load recovery re-opens
// them after a server restart. The in-flight guard prevents overlapping sweeps.
// Isolates failures per recipient so one bad delivery can't abort the sweep.
export async function sweepDueSettles(deps, now = Date.now()) {
  const { mailStore, onError } = deps;
  let notified = 0;
  const reopen = new Set();
  for (const to of mailStore.takeDueSettles(now)) {
    try {
      const pending = mailStore.unreadMessages(to);
      if (!pending.length) {
        mailStore.clearSettle(to);
        continue;
      }
      const mode = await deliverMailNotification(to, composeMailNotification(pending), deps);
      if (mode.mode === 'skip') {
        mailStore.markUndeliverable(to);
      } else if (mode.mode === 'error') {
        // Re-arm a fresh settle window after failed delivery.
        reopen.add(to);
        onError?.(to, new Error(mode.error || 'mail delivery failed'));
      } else if (mode.mode === 'deferred') {
        reopen.add(to);
      } else {
        mailStore.markNotified(to, now);
        notified += 1;
      }
    } catch (err) {
      reopen.add(to);
      try { onError?.(to, err); } catch { /* surfacing must never crash the sweep */ }
    }
  }
  mailStore.reopenSettles([...reopen], now);
  return notified;
}

// Build the guarded tick. A recent-resume MCP readiness wait can outlast the
// poll cadence, so overlapping sweeps are skipped.
export function createMailSettleSweeper(deps) {
  let sweeping = false;
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
