import { z } from 'zod';

export const stopStatusNoticesTool = {
  name: 'stop_status_notices',
  description:
    'Stop the status notices you get for a session you spawned with notify_status or nest. '
    + 'Use it when you no longer need to supervise that session, for example because a person is now '
    + 'working with it directly. Accepts the full session id or the 8-character id shown in a notice. '
    + 'Nesting and mail are unaffected.',
  inputSchema: {
    session_id: z.string().min(1).describe('The spawned session to stop hearing about: its full id or the 8-character id from a status notice.'),
  },
  async handler({ deps, caller }, args = {}) {
    const wanted = (args.session_id ?? '').trim();
    if (!wanted) return errorResult('session_id is required.');
    if (caller == null) return errorResult('Only a board session can stop its status notices.');
    const subscribed = deps.sessionManager.activeEntries().filter((e) => e.statusNotify?.to === caller);
    const exact = subscribed.find((e) => e.sessionId === wanted);
    const matches = exact ? [exact] : subscribed.filter((e) => e.sessionId.startsWith(wanted));
    if (matches.length > 1) return errorResult(`"${wanted}" matches more than one session you get status notices for; pass the full session id.`);
    if (!matches.length) return errorResult(`You are not getting status notices for "${wanted}".`);
    const sessionId = matches[0].sessionId;
    deps.sessionManager.clearStatusNotify(sessionId);
    const structuredContent = { session_id: sessionId, notices: 'stopped' };
    return { content: [{ type: 'text', text: JSON.stringify(structuredContent, null, 2) }], structuredContent };
  },
};

function errorResult(message) {
  return { content: [{ type: 'text', text: message }], isError: true };
}
