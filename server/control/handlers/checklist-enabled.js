import { writeConfig } from '../../config-store.js';

export const checklistEnabledHandler = {
  type: 'set-checklist-enabled',
  async handler(msg, ctx) {
    // Global (per-install) kill switch for the whole checklist feature — the four
    // MCP tools, the always-on nudge, and the board panel. Stored lists are left
    // untouched, so re-enabling restores every one of them. Turning it back ON
    // does not retrofit the tools onto an ALREADY-RUNNING session: --allowedTools
    // is baked into launch argv, so that session gets them at its next
    // resume/relaunch (accepted for v1, per the design spec).
    writeConfig({ checklistEnabled: Boolean(msg.enabled) });
    await ctx.rebuild();
  },
};
