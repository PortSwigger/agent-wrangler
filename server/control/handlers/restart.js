import { log } from '../../log.js';
import { INSTALL_ENV } from '../../install-env.js';

// "Restart the wrangler to finish" is the answer to every extension install and
// uninstall, and without this the board could only ask a human to go and type a
// launchctl/systemctl command — which is why an uninstall looked like it had
// done nothing at all.
//
// Offered ONLY where the process is supervised. Exiting under `npm start` or a
// bare launcher (`bin/agent-wrangler`) is not a restart, it is a shutdown with nothing to
// bring the board back, and a button that kills the board is worse than no
// button. `AW_SUPERVISED=1` is set by whatever brings the process back: the
// checkout's scripts/wrangler-start.sh (what both the launchd plist and the
// systemd unit exec) and a Homebrew service. So the flag means "something will
// restart me", never "I am on macOS", and never "I can apply a Git update" (that
// is AW_GIT_UPDATES, see update-service.js). It is read once at startup and kept
// out of tmux panes (install-env.js), so a dev instance started from a new pane
// doesn't inherit the button, and the restart note still says what to do by hand.
// A pane that predates that cleanup still carries the flag, so a dev instance
// (AW_DEV) never offers Restart either, matching the updater and the tmux PATH
// refresh.
export const restartSupported = ({ supervised = INSTALL_ENV.supervised, dev = Boolean(process.env.AW_DEV) } = {}) => supervised && !dev;

export const restartHandler = {
  type: 'restart-server',
  async handler(msg, ctx) {
    if (!ctx.canRestart) {
      throw new Error('Nothing restarts this wrangler (it was not started by a supervisor, or it is a dev instance), so it cannot restart itself — stop and start it the way you launched it.');
    }
    // A state change a human would ask about afterwards, and the one line that
    // explains an otherwise unexplained restart in the log. The shutdown line's
    // own reason is set by ctx.restart (shutdownLog.noteReason), so this does not
    // duplicate it.
    log('[agent-wrangler] restart requested from the board');
    // Replied BEFORE the exit is armed: the socket dies with the process, and the
    // client needs the ack to switch to "Restarting…" and start reconnecting.
    ctx.reply({ type: 'restart-ack' });
    ctx.restart();
  },
};
