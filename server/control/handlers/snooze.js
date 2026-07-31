import { SUSPEND_MIN_SNOOZE_MS, suspendEnabled } from '../../session-manager.js';
import { readConfig } from '../../config-store.js';
import { prefillPane } from '../../tmux-scraper.js';

export const snoozeSetHandler = {
  type: 'snooze-set',
  async handler(msg, ctx) {
    // Only sanity-check that the wake time is in the future; which durations
    // (presets or a custom date/time) are offered is the client's UX concern.
    const until = Number(msg.until);
    const now = Date.now(); // one reading: keeps the future-check and the 1h gate consistent
    if (Number.isFinite(until) && until > now) {
      const s = ctx.sessionFromGraph(msg.sessionId);
      ctx.sessionManager.setSnooze(msg.sessionId, until, { cwd: s?.cwd, intent: s?.intent, comment: msg.comment });
      // A long snooze (>= 1h) also reclaims RAM by suspending the session — but
      // never synchronously here. Just flag it pending and let the next
      // reconcileSuspend tick (<=60s) do the actual teardown through
      // suspendableSessions(), the single shared eligibility gate: it already
      // skips working/needs-you and a live background shell (never kill live
      // work, and never silently kill a background job — that's what leaves no
      // transcript trace and produces the "No completion record was found" noise
      // on the next resume), retrying every tick until both clear. An idle
      // session with nothing to wait for still suspends within that tick, which
      // reads as "immediate" to the user. A short snooze just hides the card.
      // needs-you is suspended too here — an explicit snooze means the human
      // chose "later". The global suspendEnabled kill switch skips this
      // entirely (the card still hides), so a disabled install never reclaims
      // RAM behind the user's back.
      if (until - now >= SUSPEND_MIN_SNOOZE_MS && suspendEnabled(readConfig())) {
        ctx.sessionManager.markSuspendPending(msg.sessionId);
      }
      await ctx.rebuild();
    }
  },
};

export const snoozeClearHandler = {
  type: 'snooze-clear',
  async handler(msg, ctx) {
    // Manual wake of a STILL-LIVE snoozed session routes here (the sun/Unsnooze
    // button and the card-open in selectSession both send snooze-clear). If the
    // snooze carried a note and the pane is still alive, prefill it into the prompt
    // WITHOUT Enter so the human reviews and submits it. A dormant session has no
    // live pane (node.tmux null) — its wake goes through `resume`, which delivers
    // the note after the fresh agent is ready; a comment-less snooze clears exactly
    // as before.
    //
    // clearSnooze is the atomic delivery CLAIM: read the note and claim it in the
    // SAME synchronous block — NO await between the read and the clear — so exactly
    // one actor delivers. The 30s auto-wake sweep can hit this same live session in
    // the async window; whoever's clearSnooze actually removes the snooze (returns
    // truthy) owns the single delivery. If the sweep already claimed + sendText'd it,
    // our clearSnooze returns false and we neither prefill (no double paste) nor bump.
    const node = ctx.sessionFromGraph(msg.sessionId);
    const comment = ctx.sessionManager.entryFor(msg.sessionId)?.snooze?.comment;
    const claimed = ctx.sessionManager.clearSnooze(msg.sessionId);
    if (claimed && comment && node?.tmux) {
      // ctx.prefillPane is a test seam (undefined in prod → the real tmux impl).
      await (ctx.prefillPane || prefillPane)(node.tmux, comment, ctx.socketFor(msg.sessionId)).catch(() => {});
    }
    // Waking drops the sink-to-bottom effect (sortAsleepLast in layout.js) — bump
    // its stored position to the end too, so it reappears where it visually was
    // (last among actives) instead of snapping back to whatever rank it held
    // before it fell asleep, which reads as the card jumping to the top on click.
    // Driven off the same claim so a no-op clear (already woken) never reorders.
    if (claimed) ctx.taskStore.bumpToEnd(msg.sessionId);
    await ctx.rebuild();
  },
};
