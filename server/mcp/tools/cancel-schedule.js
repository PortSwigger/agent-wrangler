import { z } from 'zod';

// The counterpart to schedule_session: delete a schedule by id (the id
// schedule_session returned). One-offs delete themselves once fired, so this is for
// retracting a pending one-off or stopping a recurring cron.
export const cancelScheduleTool = {
  name: 'cancel_schedule',
  description:
    'Delete a schedule created with schedule_session, using the id it returned. Use it to retract a '
    + 'wake-up you no longer need or to stop a recurring (cron) schedule. One-off schedules delete '
    + 'themselves after they fire, so you only need this for ones still pending.',
  inputSchema: {
    id: z.string().describe('The schedule id returned by schedule_session.'),
  },
  async handler({ deps }, args = {}) {
    const id = (args.id ?? '').trim();
    const existing = deps.scheduleStore.schedules.find((s) => s.id === id);
    if (!existing) return { content: [{ type: 'text', text: `No schedule with id ${id}.` }], isError: true };
    deps.scheduleStore.delete(id);
    await deps.rebuild();
    const structuredContent = { id, name: existing.name, cancelled: true };
    return {
      content: [{ type: 'text', text: JSON.stringify(structuredContent, null, 2) }],
      structuredContent,
    };
  },
};
