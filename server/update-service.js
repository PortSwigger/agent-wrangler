import { checkForUpdate, applyUpdate, writeRollbackMarker, clearRollbackMarker } from './self-update.js';

export class UpdateBusyError extends Error {
  constructor() {
    super('An update check or install is already running.');
    this.name = 'UpdateBusyError';
  }
}

const NOT_STARTED_BY_SERVICE = 'This wrangler was not started by the checkout service (scripts/wrangler-start.sh under launchd or systemd), which rolls back a failed update and installs new dependencies. Pull and restart it the way you launched it.';

function managedReason(manager) {
  if (manager === 'homebrew') return 'This install is managed by Homebrew. Update it with `brew upgrade agent-wrangler`, then `brew services restart agent-wrangler` if it runs as a service.';
  return `This install is managed by ${manager}. Update it with ${manager}, not from the board.`;
}

// What the board's Git updater may do in this process, decided once at startup.
// `available` gates every check (manual or scheduled); `canApply` additionally
// gates every apply, manual or automatic. Restart support is a separate
// question: a supervised process can be restarted without being able to apply
// an update, because applying one also needs a start path that rolls back a
// failed update and syncs dependencies. Only scripts/wrangler-start.sh provides
// that, and only it sets AW_GIT_UPDATES. A dev instance (AW_DEV) never applies,
// whatever it inherited from the pane it was started in.
export function updateSupport({ installManager = null, checkout = false, supervised = false, gitUpdates = false, dev = false } = {}) {
  if (installManager) return { available: false, canApply: false, reason: managedReason(installManager) };
  if (!checkout) return { available: false, canApply: false, reason: 'This install is not a Git checkout of agent-wrangler, so it cannot update from the board.' };
  const canApply = supervised && gitUpdates && !dev;
  return { available: true, canApply, reason: canApply ? null : NOT_STARTED_BY_SERVICE };
}

export function canAutoApply(status, rolledBack) {
  if (!status || status.behind <= 0 || status.blocked || !status.canApply) return false;
  return !(rolledBack && rolledBack.target === status.remote);
}

export function createUpdateService({
  check = checkForUpdate,
  apply = applyUpdate,
  writeMarker = writeRollbackMarker,
  clearMarker = clearRollbackMarker,
  support = { available: true, canApply: false, reason: NOT_STARTED_BY_SERVICE },
  mode = () => 'notify',
  isQuiet = () => true,
  rolledBack = null,
  onStatus = () => {},
  onApplied = () => {},
  log = () => {},
} = {}) {
  let busy = false;
  let latest = null;

  async function exclusive(fn) {
    if (busy) throw new UpdateBusyError();
    busy = true;
    try { return await fn(); } finally { busy = false; }
  }

  function publish(status) {
    latest = { ...status, canApply: support.canApply, rolledBack, checkedAt: Date.now() };
    onStatus(latest);
    return latest;
  }

  const runCheck = () => exclusive(async () => {
    if (!support.available) throw new Error(support.reason);
    return publish(await check());
  });

  const runApply = ({ automatic = false } = {}) => exclusive(async () => {
    if (!support.canApply) throw new Error(support.reason);
    let markerWritten = false;
    let result;
    try {
      result = await apply({ beforeMerge: (s) => { writeMarker({ previous: s.head, target: s.remote }); markerWritten = true; } });
    } catch (err) {
      if (markerWritten) clearMarker();
      throw err;
    }
    if (!result.updated) {
      publish(result);
      return result;
    }
    log(`[agent-wrangler] ${automatic ? 'auto-updated' : 'updated from the board'} to ${result.head}; restarting`);
    onApplied(result);
    return result;
  });

  async function tick() {
    // An unavailable updater makes no check at all: a Notify or Auto mode
    // carried over in config.json must not fetch, and must not log a failed
    // check every interval.
    if (!support.available) return null;
    const current = mode();
    if (current === 'off' || busy) return null;
    let status;
    try {
      status = await runCheck();
    } catch (err) {
      log(`[agent-wrangler] update check failed: ${err?.message || err}`);
      return null;
    }
    if (current !== 'auto' || !canAutoApply(status, rolledBack) || !isQuiet()) return status;
    try {
      return await runApply({ automatic: true });
    } catch (err) {
      log(`[agent-wrangler] auto-update failed: ${err?.message || err}`);
      return null;
    }
  }

  return {
    check: runCheck,
    apply: runApply,
    tick,
    latest: () => latest,
    unavailable: () => (support.available ? null : support.reason),
    rolledBack: () => rolledBack,
  };
}
