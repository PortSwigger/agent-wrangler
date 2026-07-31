import { z } from 'zod';

// Create a schedule from inside a session: a saved action + a when, fired by the
// wrangler's tick (the single-instance-per-DATA_DIR owner). Two action kinds,
// mirroring the UI: `dispatch` (launch a brand-new session at the time) and
// `session` (act on an EXISTING session — by default YOURSELF — resuming it if it's
// dormant, with `message` as the relaunch prompt, or injecting `message` into its
// terminal if it's live; the wrangler decides by liveness at fire time). The kind is
// inferred when omitted: an `intent` means dispatch, otherwise session. The target
// for a session action defaults to the caller, so an agent can schedule its own
// wake-up ("resume me at 3pm to check CI"). Writes through the same ScheduleStore
// the /ws handlers use, then rebuilds so the Schedules panel reflects it live.
export const scheduleSessionTool = {
  name: 'schedule_session',
  description:
    'Schedule an action to fire later, once (at a date/time) or on a recurring cron cadence. '
    + 'Two kinds: "dispatch" launches a brand-new session from `intent`; "session" acts on an existing '
    + 'session (defaults to YOU, the caller) — if it\'s dormant it\'s resumed with `message` as its first '
    + 'prompt, if it\'s live `message` is injected into its terminal. Use the session kind to schedule '
    + 'your own wake-up, e.g. resume me at 3pm to check CI. Provide exactly one of `at` (ISO 8601 instant) '
    + 'or `cron` (5-field expression). The kind is inferred if omitted (an `intent` ⇒ dispatch, else '
    + 'session). Returns the created schedule id and its next run time.',
  inputSchema: {
    name: z.string().optional().describe('Label shown on the Schedules panel. Defaults to a generic name.'),
    at: z.string().optional().describe('One-off run time as an ISO 8601 date/time (e.g. "2026-06-25T15:00:00"). Mutually exclusive with `cron`.'),
    cron: z.string().optional().describe('Recurring cadence as a 5-field cron expression (e.g. "0 9 * * 1-5" = weekdays 09:00). Mutually exclusive with `at`.'),
    tz: z.string().optional().describe('IANA timezone for a `cron` schedule (e.g. "Europe/London"). Defaults to the server zone.'),
    kind: z.enum(['dispatch', 'session']).optional().describe('Action kind. Inferred when omitted: `intent` ⇒ dispatch, otherwise session.'),
    // dispatch fields
    intent: z.string().optional().describe('dispatch: the new session\'s launch prompt. Required for a dispatch schedule.'),
    cwd: z.string().optional().describe('dispatch: working directory to launch in. Defaults to a fresh scratch dir.'),
    model: z.string().optional().describe('dispatch: model override for the new session.'),
    agent: z.string().optional().describe('dispatch: agent to launch (claude or codex). Defaults to claude.'),
    into: z.string().optional().describe('dispatch: task id to put the new session on. Defaults to your current task.'),
    worktree: z.boolean().optional().describe('dispatch: launch in a fresh git worktree (auto-suffixed for recurring schedules).'),
    workflow: z.boolean().optional().describe('dispatch: run the issue→PR autopilot on `intent` as the issue.'),
    // session fields
    target_session: z.string().optional().describe('session: target session id (card id from list_sessions). Defaults to YOU, the caller.'),
    message: z.string().optional().describe('session: optional text — the relaunch prompt if the target is dormant, or the text injected into its terminal if it\'s live.'),
  },
  async handler({ deps, caller }, args = {}) {
    // When: exactly one of at / cron.
    const hasAt = typeof args.at === 'string' && args.at.trim();
    const hasCron = typeof args.cron === 'string' && args.cron.trim();
    if (hasAt && hasCron) return errorResult('Provide either `at` (one-off) or `cron` (recurring), not both.');
    if (!hasAt && !hasCron) return errorResult('A schedule needs a time: pass `at` (ISO 8601 instant) or `cron`.');
    let when;
    if (hasAt) {
      const ms = Date.parse(args.at);
      if (Number.isNaN(ms)) return errorResult(`Could not parse \`at\` as a date/time: ${args.at}`);
      when = { kind: 'once', runAt: new Date(ms).toISOString() };
    } else {
      when = { kind: 'cron', cron: args.cron.trim() };
      if (args.tz) when.tz = args.tz;
    }

    // Action: explicit kind, else inferred (an intent ⇒ dispatch, otherwise session).
    const kind = args.kind || (typeof args.intent === 'string' && args.intent.trim() ? 'dispatch' : 'session');
    let action;
    if (kind === 'dispatch') {
      const intent = (args.intent ?? '').trim();
      if (!intent) return errorResult('A dispatch schedule needs an `intent` (the launch prompt).');
      // Default the task to the caller's current task, like spawn_session.
      const taskId = args.into ?? deps.taskStore.taskFor(caller)?.id ?? null;
      action = {
        kind: 'dispatch',
        dispatch: {
          cwd: args.cwd,
          intent,
          model: args.model,
          agent: args.agent || 'claude',
          taskId: taskId || undefined,
          worktree: Boolean(args.worktree) || undefined,
          workflow: Boolean(args.workflow) || undefined,
        },
      };
    } else {
      // session: target defaults to the caller (self-scheduled wake-up); message is
      // optional — the runner resumes-or-messages by the target's liveness at fire time.
      const sessionId = (args.target_session ?? caller ?? '').trim();
      if (!sessionId) return errorResult('No target session: pass `target_session` (no caller to default to).');
      const message = (args.message ?? '').trim();
      action = { kind: 'session', sessionId, message };
    }

    let created;
    try {
      created = deps.scheduleStore.create({ name: args.name, when, action }, Date.now());
    } catch (e) {
      return errorResult(e?.message || 'Could not create the schedule.');
    }
    await deps.rebuild();

    const structuredContent = {
      id: created.id,
      name: created.name,
      kind: created.action.kind,
      enabled: created.enabled,
      when: created.when,
      nextRunAt: created.nextRunAt,
      target: created.action.sessionId ?? null,
    };
    return {
      content: [{ type: 'text', text: JSON.stringify(structuredContent, null, 2) }],
      structuredContent,
    };
  },
};

function errorResult(message) {
  return { content: [{ type: 'text', text: message }], isError: true };
}
