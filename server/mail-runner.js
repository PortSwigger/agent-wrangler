import { deliverMailNotification } from './mailbox-delivery.js';
import { composeMailNotification } from './mail-notification.js';

// Process every due settle window: compose the terse notification from the
// recipient's currently-unread mail and deliver it (waking a dormant recipient
// first). `takeDueSettles` durably marks attempts in progress and load recovery
// re-opens them after a server restart. The in-flight guard prevents overlapping
// sweeps from selecting the same window twice.
//
// Archived re-check: `deliverMailNotification` re-checks archivedAt itself
// immediately before resuming a dormant recipient (the load-bearing race guard
// — see its own comment) and returns 'skip' for an archived/gone one. A LIVE
// recipient can't be simultaneously archived in this codebase (archive() kills
// every owned tmux before it stamps archivedAt — see control/handlers/archive.js),
// so no separate live-side check is needed here.
// Isolates failures per recipient (one bad delivery can't abort the sweep, same
// as fireDueSnoozeWakes). Returns the count actually notified so the caller can
// batch one rebuild.
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
        if (mode.mode === 'dormant') notified += 1;
      }
    } catch (err) {
      reopen.add(to);
      try { onError?.(to, err); } catch { /* surfacing must never crash the sweep */ }
    }
  }
  mailStore.reopenSettles([...reopen], now);
  return notified;
}

// Build the guarded tick: an overlapping sweep (a dormant wake inside
// sweepDueSettles can take seconds, well past the 2s poll cadence) is a no-op
// rather than resuming the same recipient concurrently. Mirrors
// createSnoozeWakeSweeper. `onWoken` (rebuild) fires only when a dormant wake
// actually happened — a live-only sweep never touched anything the board needs
// to refresh for.
export function createMailSettleSweeper(deps, { onWoken } = {}) {
  let sweeping = false;
  return async function sweep(now = Date.now()) {
    if (sweeping) return { skipped: true };
    sweeping = true;
    try {
      const woken = await sweepDueSettles(deps, now);
      if (woken && onWoken) await onWoken(woken);
      return { skipped: false, woken };
    } finally {
      sweeping = false;
    }
  };
}
