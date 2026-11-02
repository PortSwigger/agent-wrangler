import { z } from 'zod';
import { scheduleSessionTool, prepareSchedule, scheduleResult, errorResult } from './schedule-session.js';

const dispatchFields = {
  intent: 'intent', cwd: 'cwd', model: 'model', agent: 'agent', into: 'taskId',
  worktree: 'worktree', workflow: 'workflow', auto_compact_tokens: 'autoCompactTokens',
};
const actionFields = ['kind', ...Object.keys(dispatchFields), 'target_session', 'message'];

export const updateScheduleTool = {
  name: 'update_schedule',
  description: 'Edit a schedule by id, retaining omitted values. Uses the same fields as schedule_session. '
    + 'Provide at or cron to replace timing; tz alone edits a cron timezone. Action fields edit the existing '
    + 'action; use kind to switch action type. Timing edits recompute nextRunAt; other edits retain it. '
    + 'Returns the existing id and updated schedule. Use cancel_schedule to delete it.',
  inputSchema: {
    ...scheduleSessionTool.inputSchema,
    id: z.string().describe('The existing schedule id returned by schedule_session.'),
    kind: z.enum(['dispatch', 'session']).optional().describe('Action kind. Omit to retain the existing kind.'),
  },
  async handler({ deps, caller }, args = {}) {
    const id = (args.id ?? '').trim();
    const existing = deps.scheduleStore.schedules.find(s => s.id === id);
    if (!existing) return errorResult(`No schedule with id ${id}.`);
    const timingChanged = ['at', 'cron', 'tz'].some(key => args[key] !== undefined);
    const actionChanged = actionFields.some(key => args[key] !== undefined);
    const merged = { name: existing.name, kind: args.kind ?? existing.action.kind };
    if (args.at === undefined && args.cron === undefined) {
      if (existing.when.kind === 'once') merged.at = existing.when.runAt;
      else merged.cron = existing.when.cron;
    }
    if (args.at === undefined && existing.when.kind === 'cron') merged.tz = existing.when.tz;
    if (merged.kind === existing.action.kind) {
      if (merged.kind === 'dispatch') {
        for (const [key, stored] of Object.entries(dispatchFields)) merged[key] = existing.action.dispatch[stored];
      } else {
        merged.target_session = existing.action.sessionId;
        merged.message = existing.action.message;
      }
    }
    Object.assign(merged, args);
    if (args.tz !== undefined) {
      if (merged.at !== undefined) return errorResult('A timezone edit needs a cron schedule.');
      try { new Intl.DateTimeFormat('en', { timeZone: args.tz }); }
      catch { return errorResult(`Invalid timezone: ${args.tz}`); }
    }
    const prepared = prepareSchedule({ deps, caller }, merged);
    if (prepared.isError) return prepared;
    const patch = {};
    if (args.name !== undefined) patch.name = args.name;
    if (timingChanged) patch.when = prepared.when;
    if (actionChanged) {
      patch.action = merged.kind === existing.action.kind
        ? { ...existing.action, ...prepared.action }
        : prepared.action;
      if (merged.kind === 'dispatch' && merged.kind === existing.action.kind) {
        patch.action.dispatch = { ...existing.action.dispatch };
        for (const [key, stored] of Object.entries(dispatchFields)) {
          if (args[key] !== undefined) patch.action.dispatch[stored] = prepared.action.dispatch[stored];
        }
      }
    }
    let updated;
    try { updated = deps.scheduleStore.update(id, patch, Date.now()); }
    catch (e) { return errorResult(e?.message || 'Could not update the schedule.'); }
    await deps.rebuild();
    return scheduleResult(updated);
  },
};
