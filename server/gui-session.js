// macOS only: is this install's tmux server stuck in an old login session?
//
// The tmux server outlives a logout. Logging out stops the launchd service but
// not the daemonised tmux server, so after logging back in the restarted wrangler
// reattaches to a server still in the PREVIOUS login session — and every agent,
// and every GUI app an agent starts, inherits it. Windows from that session still
// draw on screen, but the Dock and app activation belong to the new session: a
// Playwright Chrome gets no Dock icon, never comes to the front, and keystrokes
// typed into it go to whichever app is really active. Restarting the wrangler
// doesn't help; only a fresh tmux server does.
//
// The probe: `lsappinfo` lists only the apps in the caller's own login session,
// so finding the Dock means "this process is in the session the user is logged
// in to". It runs once in the wrangler itself and once inside the tmux server
// (`run-shell` executes as a child of the server, so it inherits the server's
// session). Only "the wrangler sees the Dock but tmux doesn't" is reported: if
// the wrangler can't see it either (a dev instance started from a stale pane,
// say), a tmux restart from here would land in the same session and fix nothing.

const DOCK_PROBE = 'lsappinfo find bundleid=com.apple.dock';

// true / false when the probe ran, null when it couldn't (no tmux server on the
// socket, lsappinfo missing): an unknown answer never raises a warning.
async function seesDock(run) {
  try {
    const { stdout } = await run();
    return String(stdout).trim().length > 0;
  } catch {
    return null;
  }
}

// `exec(file, args)` resolves to `{ stdout }` (promisified execFile) and
// `tmux(args)` runs tmux against this install's socket. Returns `{ socket }` when
// the tmux server is in a stale session, else null.
export async function checkGuiSession({ platform = process.platform, socket, exec, tmux }) {
  if (platform !== 'darwin' || !socket) return null;
  const [cmd, ...args] = DOCK_PROBE.split(' ');
  if ((await seesDock(() => exec(cmd, args))) !== true) return null;
  if ((await seesDock(() => tmux(['run-shell', DOCK_PROBE]))) !== false) return null;
  return { socket };
}
