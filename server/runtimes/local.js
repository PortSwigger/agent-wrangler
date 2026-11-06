import { sourceSecretEnv } from '../launch-secrets.js';

// The default runtime: the agent runs directly on the host, exactly as the
// wrangler has always worked. wrapLaunch is the identity — the inner command
// the agent built IS the command tmux runs — and there is no path/URL
// translation and no state-read override (state-reader/adapters read the host
// filesystem as before). Kept as an explicit module so `runtime` absent can map
// to a real object rather than a scatter of null checks.
// No readLive/analyze: state-reader falls through to the agent adapter (host FS).
// `secretEnv: true`: it takes the launch's secret variables as a file
// (launch-secrets.js), sourced and deleted by the pane before the agent runs.
export const local = {
  id: 'local',
  label: 'Local (host)',
  skipsHostResumeGuard: false,
  secretEnv: true,
  async wrapLaunch({ inner, secretEnvFile = null }) {
    return sourceSecretEnv(secretEnvFile) + inner;
  },
};
