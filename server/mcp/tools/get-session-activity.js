import { z } from 'zod';
import { adapterFor } from '../../agents/index.js';

const DAY_MS = 86_400_000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Local-day boundaries (this machine's timezone — the wrangler runs on the
// user's own Mac, so that's the timezone the user means by "date X").
function dayRangeMs(date, endDate) {
  const startMs = new Date(`${date}T00:00:00`).getTime();
  const endMs = new Date(`${endDate || date}T00:00:00`).getTime() + DAY_MS;
  return { startMs, endMs };
}

// mappings.json holds a persistent record of every session ever created —
// active, suspended, AND archived — unlike list_sessions, which only sees
// the current board (archived sessions drop out entirely). This is the whole
// reason this tool exists: reconstruct real history from disk, not the live
// snapshot. Transcript reading is agent-specific (Claude .jsonl under
// ~/.claude/projects vs Codex rollout .jsonl under ~/.codex/sessions), so it
// goes through each agent's own adapter (activityInRange) rather than branching
// here — mirrors how analyze()/listResumable() are already split per adapter.
export const getSessionActivityTool = {
  name: 'get_session_activity',
  description:
    'Find what was actually worked on for a given date (or date range) by scanning session '
    + 'transcripts for real timestamped activity — not just the live board snapshot. Covers '
    + 'currently-live sessions AND archived/suspended ones (list_sessions only sees the live '
    + 'board), and both Claude and Codex sessions. For each session with any activity in range, '
    + 'returns: session id, label, task, cwd, agent, whether it is archived, message count that '
    + 'day, and first/last activity timestamp. Use this instead of Chrome history or '
    + 'hand-parsing mappings.json/transcripts to answer "what did I work on on date X". Dates '
    + 'are local (this machine\'s timezone). Read-only.',
  inputSchema: {
    date: z.string().regex(DATE_RE).describe('Start date, YYYY-MM-DD, local time on this machine.'),
    endDate: z.string().regex(DATE_RE).optional()
      .describe('End date, YYYY-MM-DD, inclusive. Defaults to `date` for a single day.'),
  },
  async handler({ deps }, args = {}) {
    const { startMs, endMs } = dayRangeMs(args.date, args.endDate);
    const entries = [...deps.sessionManager.activeEntries(), ...deps.sessionManager.archivedEntries()];
    const results = [];
    for (const entry of entries) {
      // Safe prefilter: a session's transcript activity can never fall outside
      // its own lifetime, so this can only skip sessions with zero chance of
      // overlap — never one whose window merely LOOKS like it doesn't overlap
      // (missing fields just disable the check for that entry).
      if (typeof entry.createdAt === 'number' && entry.createdAt >= endMs) continue;
      const lifetimeEnd = entry.archivedAt ?? entry.suspendedAt;
      if (typeof lifetimeEnd === 'number' && lifetimeEnd < startMs) continue;

      // Every conversation the card has owned, not just the current one: `/clear`
      // starts a fresh conversation in the same pane, so a single day's work under one
      // card routinely straddles two transcripts (the abandoned ids are recorded on
      // the entry). Reading only the live id would drop whichever half of the day fell
      // on the other side of the clear.
      const dir = entry.agent === 'codex' ? deps.codexSessionsDir : deps.projectsDir;
      const ids = [entry.liveSessionId || entry.sessionId, ...(entry.priorLiveSessionIds || [])];
      const parts = [];
      for (const id of ids) {
        const a = await adapterFor(entry.agent).activityInRange(id, startMs, endMs, dir);
        if (a && a.messageCount > 0) parts.push(a);
      }
      if (!parts.length) continue;
      const activity = {
        messageCount: parts.reduce((n, a) => n + a.messageCount, 0),
        firstActivity: Math.min(...parts.map((a) => a.firstActivity)),
        lastActivity: Math.max(...parts.map((a) => a.lastActivity)),
      };

      results.push({
        sessionId: entry.sessionId,
        label: entry.name || null,
        task: deps.taskStore.taskFor(entry.sessionId) ?? null,
        cwd: entry.cwd ?? null,
        agent: entry.agent || 'claude',
        archived: Boolean(entry.archivedAt),
        messageCount: activity.messageCount,
        firstActivity: new Date(activity.firstActivity).toISOString(),
        lastActivity: new Date(activity.lastActivity).toISOString(),
      });
    }
    results.sort((a, b) => Date.parse(b.lastActivity) - Date.parse(a.lastActivity));
    const structuredContent = {
      range: { start: args.date, end: args.endDate || args.date },
      sessions: results,
    };
    return {
      content: [{ type: 'text', text: JSON.stringify(structuredContent, null, 2) }],
      structuredContent,
    };
  },
};
