// Thin schedule handlers, mirroring handlers/tasks.js: mutate the store → rebuild.
// create/update validate inside ScheduleStore and throw on a bad `when` — the
// control router wraps the throw into the {type:'error'} frame the client shows,
// so these stay validation-free. Date.now() is threaded in so the store seeds /
// recomputes nextRunAt deterministically (and tests can inject a fixed clock).

export const scheduleCreateHandler = {
  type: 'schedule-create',
  async handler(msg, ctx) {
    // `action` is the discriminated payload (dispatch / session); a legacy client may
    // still send a bare `dispatch` — the store normalises either.
    ctx.scheduleStore.create({ name: msg.name, when: msg.when, action: msg.action, dispatch: msg.dispatch }, Date.now());
    await ctx.rebuild();
  },
};

export const scheduleUpdateHandler = {
  type: 'schedule-update',
  async handler(msg, ctx) {
    ctx.scheduleStore.update(msg.id, msg.patch || {}, Date.now());
    await ctx.rebuild();
  },
};

export const scheduleDeleteHandler = {
  type: 'schedule-delete',
  async handler(msg, ctx) {
    ctx.scheduleStore.delete(msg.id);
    await ctx.rebuild();
  },
};

export const scheduleToggleHandler = {
  type: 'schedule-toggle',
  async handler(msg, ctx) {
    ctx.scheduleStore.setEnabled(msg.id, Boolean(msg.enabled), Date.now());
    await ctx.rebuild();
  },
};

export const scheduleRunNowHandler = {
  type: 'schedule-run-now',
  async handler(msg, ctx) {
    // Fire immediately, ignoring `when`, through the SAME firing routine the tick
    // uses (injected as ctx.runSchedule like rebuild) so run-now and the tick share
    // one path. `manual` skips the recurring advance so a run-now never disturbs a
    // recurring schedule's nextRunAt. It rebuilds itself, so no rebuild here.
    await ctx.runSchedule(msg.id, { manual: true });
  },
};
