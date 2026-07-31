// The default runtime: the agent runs directly on the host, exactly as the
// wrangler has always worked. wrapLaunch is the identity — the inner command
// the agent built IS the command tmux runs — and there is no path/URL
// translation and no state-read override (state-reader/adapters read the host
// filesystem as before). Kept as an explicit module so `runtime` absent can map
// to a real object rather than a scatter of null checks.
// No readLive/analyze: state-reader falls through to the agent adapter (host FS).
export const local = {
  id: 'local',
  skipsHostResumeGuard: false,
  async wrapLaunch({ inner }) {
    return inner;
  },
};
