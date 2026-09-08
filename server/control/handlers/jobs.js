export const jobCreateHandler = {
  type: 'job-create',
  async handler(msg, ctx) {
    const job = ctx.jobStore.create(msg.job);
    await ctx.rebuild();
    ctx.reply({ type: 'job-created', jobId: job.id });
  },
};
export const jobActionHandler = {
  type: 'job-action',
  async handler(msg, ctx) {
    ctx.jobStore.action(msg.id, msg.action, msg);
    await ctx.rebuild();
    ctx.reply({ type: 'job-action-complete', jobId: msg.id });
    ctx.runJobs().catch((e) => ctx.reply({ type: 'error', message: e.message }));
  },
};
export const jobSettingsHandler = {
  type: 'job-settings',
  async handler(msg, ctx) {
    ctx.jobStore.settings(msg.patch);
    await ctx.rebuild();
  },
};
