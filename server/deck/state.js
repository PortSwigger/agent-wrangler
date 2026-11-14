// Session-record fields no board code reads (core board and extension board
// halves), so the session view leaves them out. Re-audit before adding one: a
// field dropped here silently disappears for every board.
export const SESSION_VIEW_DROPPED = [
  'pid',
  'socket',
  'jobId',
  'liveSessionId',
  'hasTranscript',
  'currentModel',
  'launchedCodeVersion',
  'autoBlockSeconds',
  'suspendedAt',
];

// What a board does read off a session record. The coverage test fails on any
// record field that is in neither list.
export const SESSION_VIEW_FIELDS = [
  'id', 'type', 'sessionId', 'label', 'agent', 'status', 'rawStatus', 'hasBackgroundShell',
  'waitingFor', 'waitingReason', 'kind', 'cwd', 'branch', 'repoSlug', 'addDirs', 'intent',
  'createdAt', 'updatedAt', 'lastActivity', 'model', 'effort', 'permissionMode', 'modelPill',
  'autoCompactTokens', 'modelContextWindow', 'snooze', 'runtime', 'workflow', 'parentSession',
  'spawnedBy', 'autoFixPrChecks', 'autoMergeOnPass', 'childFullView', 'offBoard', 'links',
  'worktree', 'tasks', 'tty', 'managed', 'restarting', 'tmux', 'dormant', 'exitOutput', 'usd',
  'advisorUsd', 'tokens', 'subAgents', 'teammates', 'mail', 'statusNoticeBlocked',
];

const DROPPED = new Set(SESSION_VIEW_DROPPED);

export function sessionView(session) {
  const out = {};
  for (const [k, v] of Object.entries(session)) if (!DROPPED.has(k)) out[k] = v;
  return out;
}

export const SETTINGS_KEYS = [
  'trustCodexLaunchCwd',
  'trustClaudeLaunchCwd',
  'autoFixPrChecksDefault',
  'mailWakesDormant',
  'prModelFooter',
  'defaultSessionCwd',
  'defaultRuntime',
  'backgroundModel',
  'codexPolicyDefaults',
  'autoUpdate',
  'refreshSessionsAfterUpdate',
  'legacyBoardSettings',
  'extensions',
];

export const STATUS_KEYS = ['codeVersion', 'quarantinedBuiltins', 'staleGuiSession'];

const pick = (obj, keys) => Object.fromEntries(keys.filter((k) => k in obj).map((k) => [k, obj[k]]));

// The deck API's view of one rebuilt graph. `ext` maps an extension id to the
// keys its graph contributor added this rebuild.
export function toState(graph, ext = {}) {
  return {
    sessions: (graph.sessions || []).map(sessionView),
    history: graph.history,
    nodes: (graph.nodes || []).map((n) => (n?.type === 'session' ? sessionView(n) : n)),
    edges: graph.edges || [],
    tasks: graph.tasks ?? null,
    schedules: graph.schedules ?? [],
    settings: pick(graph, SETTINGS_KEYS),
    ext,
    status: pick(graph, STATUS_KEYS),
    generatedAt: graph.generatedAt,
  };
}

// The state stream. `observe` records a rebuild; `next` turns the latest one
// into a frame, or null when nothing but generatedAt moved since the last frame,
// and history rides only on a frame where it changed. `rev` rises by one per
// frame, from a boot-time clock reading so it keeps rising across restarts.
// `snapshot` is the full current state for a new connection.
export function createStateStream({ startRev = Date.now() } = {}) {
  let rev = startRev;
  let latest = null;
  let lastBody = null;
  let lastHistory;
  const frame = (state, withHistory) => {
    const { history, ...rest } = state;
    return JSON.stringify({ type: 'state', rev, ...rest, ...(withHistory ? { history } : {}) });
  };
  return {
    rev: () => rev,
    observe(graph, ext) {
      latest = toState(graph, ext);
    },
    next() {
      if (!latest) return null;
      const { history, generatedAt, ...rest } = latest;
      const body = JSON.stringify(rest);
      const historyJson = JSON.stringify(history ?? null);
      const historyMoved = historyJson !== lastHistory;
      if (!historyMoved && body === lastBody) return null;
      lastBody = body;
      lastHistory = historyJson;
      rev += 1;
      return frame(latest, historyMoved);
    },
    snapshot() {
      return latest ? frame(latest, true) : null;
    },
  };
}
