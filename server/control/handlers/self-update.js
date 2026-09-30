import { writeConfig, AUTO_UPDATE_MODES } from '../../config-store.js';

async function replyingErrors(ctx, fn) {
  try {
    await fn();
  } catch (err) {
    ctx.reply({ type: 'update-error', message: String(err?.message || err) });
  }
}

export const updateCheckHandler = {
  type: 'update-check',
  async handler(msg, ctx) {
    await replyingErrors(ctx, () => ctx.updates.check());
  },
};

export const updateApplyHandler = {
  type: 'update-apply',
  async handler(msg, ctx) {
    await replyingErrors(ctx, () => ctx.updates.apply());
  },
};

export const autoUpdateModeHandler = {
  type: 'set-auto-update-mode',
  async handler(msg, ctx) {
    if (!AUTO_UPDATE_MODES.includes(msg.mode)) throw new Error(`Unknown auto-update mode ${msg.mode}`);
    writeConfig({ autoUpdate: msg.mode });
    await ctx.rebuild();
  },
};

export const refreshSessionsAfterUpdateHandler = {
  type: 'set-refresh-sessions-after-update',
  async handler(msg, ctx) {
    writeConfig({ refreshSessionsAfterUpdate: Boolean(msg.enabled) });
    await ctx.rebuild();
  },
};
