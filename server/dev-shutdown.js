// Dev instances leak: the run-dev skill backgrounds `node server/index.js` and
// relies on a teardown that's easily skipped (the agent session ends, a crash, a
// forgotten kill), so the server reparents to launchd and runs forever. This lets
// a *dev* instance reap itself — never the production service, which doesn't set
// AW_DEV. Two triggers: its data dir was wiped out from under it (the exact case
// that defeats the per-DATA_DIR lock and spawns a zombie), or it's been idle with
// no control client for long enough to be abandoned.

// Read the dev-shutdown config from the env. Opt-in via AW_DEV (the skill sets it);
// AW_DEV_IDLE_SHUTDOWN_MIN tunes the idle window (default 30 min, 0 disables the idle timer
// but the data-dir-removed trigger still fires).
export function devShutdownConfig(env = process.env) {
  const enabled = Boolean(env.AW_DEV);
  const min = Number(env.AW_DEV_IDLE_SHUTDOWN_MIN);
  const idleMin = Number.isFinite(min) && min >= 0 ? min : 30;
  return { enabled, idleMs: idleMin === 0 ? null : idleMin * 60 * 1000 };
}

// Pure decision: should this instance shut itself down, and why. Returns a reason
// string ('data-dir-removed' | 'idle') or null to keep running. Production
// (enabled false) always returns null. A wiped data dir wins outright — the state
// is gone, so a live client doesn't matter. Otherwise only an idle instance with
// no control client connected, past the idle window, exits. `lastClientActivity`
// is seeded to the start time, so a dev server launched and never driven still
// exits once the window elapses.
export function devShutdownDecision({ enabled, idleMs, now, lastClientActivity, clientsConnected, dataDirExists }) {
  if (!enabled) return null;
  if (!dataDirExists) return 'data-dir-removed';
  if (clientsConnected > 0) return null;
  if (idleMs == null) return null;
  if (now - lastClientActivity >= idleMs) return 'idle';
  return null;
}
