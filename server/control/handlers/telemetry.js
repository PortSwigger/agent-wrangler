// Settings › Telemetry. Telemetry is always on and has nothing to set, so the
// only request is the queue preview: request/reply over the control socket, so
// the queued events never ride the graph.
export const telemetryPreviewHandler = {
  type: 'telemetry-preview',
  async handler(msg, ctx) {
    ctx.reply({ type: 'telemetry-preview', events: ctx.telemetry.preview(50) });
  },
};
