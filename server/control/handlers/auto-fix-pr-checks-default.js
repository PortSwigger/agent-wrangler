import { writeConfig } from '../../config-store.js';

export const autoFixPrChecksDefaultHandler = {
  type: 'set-auto-fix-pr-checks-default',
  async handler(msg, ctx) {
    // Global (per-install) DEFAULT for the PR nudge, not a per-session override —
    // persists in config.json so every browser and every future PR transition
    // agrees. Deliberately does NOT touch any entry's own autoFixPrChecks: a card
    // toggled by hand keeps its explicit choice, and only cards with none follow
    // this. The rebuild re-broadcasts the graph carrying both the new flag (for
    // the settings modal) and each card's re-resolved effective value.
    writeConfig({ autoFixPrChecksDefault: Boolean(msg.enabled) });
    await ctx.rebuild();
  },
};
