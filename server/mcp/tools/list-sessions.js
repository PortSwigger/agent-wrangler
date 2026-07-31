// Read-only board snapshot, caller-aware. Reads the already-maintained graph
// (no rescan) and resolves each session's current task via taskStore. `caller`
// is the requesting session's card id (or null when the request carried no
// identity); the matching row is flagged isCaller.
export const listSessionsTool = {
  name: 'list_sessions',
  description:
    'List the Agent Wrangler sessions currently on the board (id, label, agent, status, '
    + 'managed, working dir, assigned task), flagging which one is you. `managed` is true when '
    + 'the session has a live terminal; a session with managed:false can still receive a '
    + 'send_message — it is dormant/suspended and gets woken to deliver it. Read-only.',
  inputSchema: {},
  async handler({ deps, caller }) {
    const sessions = (deps.graph()?.sessions ?? []).map((s) => ({
      sessionId: s.sessionId,
      label: s.label ?? null,
      agent: s.agent ?? null,
      status: s.status ?? null,
      managed: Boolean(s.managed),
      cwd: s.cwd ?? null,
      task: deps.taskStore.taskFor(s.sessionId) ?? null,
      isCaller: caller != null && s.sessionId === caller,
    }));
    const callerBlock = caller == null
      ? null
      : { sessionId: caller, task: deps.taskStore.taskFor(caller) ?? null };
    const structuredContent = { caller: callerBlock, sessions };
    return {
      content: [{ type: 'text', text: JSON.stringify(structuredContent, null, 2) }],
      structuredContent,
    };
  },
};
