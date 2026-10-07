// Install-scoped signals: env vars that describe how THIS process was installed
// and started (by a supervisor, by Homebrew, through the checkout start script),
// not anything a session or a child process should act on.
//
// The env-inheritance rule (docs/install-signals.md): each signal is read once,
// here, and then deleted from process.env. That matters because a tmux server
// takes its global environment from whichever process first starts it and keeps
// it across wrangler restarts, and every pane inherits that environment. Left in
// place, a dev instance started from a pane would inherit the board's identity:
// its Restart button, its Git-update capability, Homebrew's install root.
// Deleting them here, at import, comes before any tmux spawn; the copies already
// held by a running tmux server are removed by SessionManager.clearInstallEnv
// once the instance lock is held.
//
// index.js imports this module first, so the capture happens before any other
// module's top-level code runs. Readers use INSTALL_ENV, never process.env.

export const INSTALL_SCOPED_ENV = Object.freeze([
  'AW_SUPERVISED',
  'AW_INSTALL_MANAGER',
  'AW_GIT_UPDATES',
  'AW_LOGS_TRIMMED',
  'AW_NODE',
  'AW_INSTALL_ROOT',
]);

// Pure, so the parsing is testable without touching the real environment.
export function readInstallEnv(env) {
  return Object.freeze({
    // Something (launchd KeepAlive, systemd Restart=, brew services) brings the
    // process back after it exits. Enables the board's Restart button only.
    supervised: env.AW_SUPERVISED === '1',
    // A package manager owns this install (e.g. "homebrew"): it is updated by
    // that tool, never by the board's Git updater.
    installManager: (env.AW_INSTALL_MANAGER || '').trim() || null,
    // The start path re-runs update rollback and dependency sync before the
    // launcher (scripts/wrangler-start.sh), so a Git update can be applied.
    gitUpdates: env.AW_GIT_UPDATES === '1',
    installRoot: env.AW_INSTALL_ROOT || null,
  });
}

export function stripInstallEnv(env) {
  for (const name of INSTALL_SCOPED_ENV) delete env[name];
}

export const INSTALL_ENV = readInstallEnv(process.env);
stripInstallEnv(process.env);
