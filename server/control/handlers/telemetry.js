// Settings › Telemetry. The switch and the team are written through core
// telemetry (server/telemetry.js), which owns what turning it off means: the
// queue is dropped. The preview is request/reply over the control socket, so
// the queued events never ride the graph.
export const telemetrySetHandler = {
  type: 'set-telemetry',
  async handler(msg, ctx) {
    if (typeof msg.enabled === 'boolean') ctx.telemetry.setEnabled(msg.enabled);
    if ('team' in msg) ctx.telemetry.setTeam(typeof msg.team === 'string' && msg.team ? msg.team : null);
    await ctx.rebuild();
  },
};

export const telemetryPreviewHandler = {
  type: 'telemetry-preview',
  async handler(msg, ctx) {
    ctx.reply({ type: 'telemetry-preview', events: ctx.telemetry.preview(50) });
  },
};

export const telemetryClearHandler = {
  type: 'telemetry-clear-queue',
  async handler(msg, ctx) {
    ctx.telemetry.clearQueue();
    await ctx.rebuild();
    ctx.reply({ type: 'telemetry-preview', events: [] });
  },
};
