import { readLaunchStatus } from '../../runtimes/launch-status.js';

// Read-only board snapshot, caller-aware. Reads the already-maintained graph
// (no rescan) and resolves each session's current task via taskStore. `caller`
// is the requesting session's card id (or null when the request carried no
// identity); the matching row is flagged isCaller.
export const listSessionsTool = {
  name: 'list_sessions',
  description:
    'List the Agent Wrangler sessions currently on the board (id, label, agent, status, '
    + 'managed, working dir, assigned task), flagging which one is you. `managed` is true when '
    + 'the session has a live terminal. Mail-capable dormant sessions keep queued mail until '
    + 'explicitly resumed; legacy recipients must have a live terminal. `parentSession` and '
    + '`spawnedBy` are two DIFFERENT, independently-nullable relations: `parentSession` is who '
    + 'this session is nested under on the board (opt-in, changeable later via attach_session/'
    + 'detach_session); `spawnedBy` is who actually called spawn_session/spawn_workflow to launch '
    + 'it (set once at launch, only when launched that way — null for a session dispatched '
    + 'directly from the board UI). Either can be set with the other null. `autoCompactTokens` is '
    + 'the session\'s auto-compaction working-context ceiling. Prefer `label` over '
    + '`sessionId` when telling the user about a session — but labels aren\'t guaranteed unique '
    + '(often intent-derived, so a session and one it spawned can share the same displayed label; '
    + 'see the `session-hierarchy` skill), so when presenting more than one row pair the label '
    + 'with a short id, e.g. `(<first 8 chars>, "<label>")`, rather than the label alone. '
    + 'A session on a runtime whose launch can fail after it was created (e.g. `cloud`) also '
    + 'carries `launch` (`state`: ok, failed with `error`, pending or unknown). Read-only.',
  inputSchema: {},
  async handler({ deps, caller }) {
    const rows = (deps.graph()?.sessions ?? []).map((s) => ({
      sessionId: s.sessionId,
      label: s.label ?? null,
      agent: s.agent ?? null,
      status: s.status ?? null,
      managed: Boolean(s.managed),
      cwd: s.cwd ?? null,
      task: deps.taskStore.taskFor(s.sessionId) ?? null,
      parentSession: s.parentSession ?? null,
      spawnedBy: s.spawnedBy ?? null,
      autoCompactTokens: s.autoCompactTokens ?? null,
      isCaller: caller != null && s.sessionId === caller,
    }));
    // Only on rows whose runtime answers, so every other row keeps its shape.
    const sessions = await Promise.all(rows.map(async (row) => {
      const launch = await readLaunchStatus(deps.sessionManager?.entryFor?.(row.sessionId));
      return launch ? { ...row, launch } : row;
    }));
    const callerRow = sessions.find((s) => s.isCaller);
    const callerBlock = caller == null
      ? null
      : {
        sessionId: caller,
        task: callerRow?.task ?? deps.taskStore.taskFor(caller) ?? null,
        parentSession: callerRow?.parentSession ?? null,
        spawnedBy: callerRow?.spawnedBy ?? null,
      };
    const structuredContent = { caller: callerBlock, sessions };
    return {
      content: [{ type: 'text', text: JSON.stringify(structuredContent, null, 2) }],
      structuredContent,
    };
  },
};
