import { log } from '../../log.js';

// "Restart the wrangler to finish" is the answer to every extension install and
// uninstall, and without this the board could only ask a human to go and type a
// launchctl/systemctl command — which is why an uninstall looked like it had
// done nothing at all.
//
// Offered ONLY where the process is supervised. Exiting under `npm start` or a
// bare `node server/index.js` is not a restart, it is a shutdown with nothing to
// bring the board back, and a button that kills the board is worse than no
// button. `AW_SUPERVISED=1` is exported by scripts/wrangler-start.sh, which is
// what BOTH the launchd plist and the systemd unit exec — so the flag means
// "something will restart me", never "I am on macOS". A dev instance started any
// other way simply doesn't get the button, and the restart note still says what
// to do by hand.
export const restartSupported = () => process.env.AW_SUPERVISED === '1';

export const restartHandler = {
  type: 'restart-server',
  async handler(msg, ctx) {
    if (!restartSupported()) {
      throw new Error('This wrangler was not started by a supervisor, so it cannot restart itself — stop and start it the way you launched it.');
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
