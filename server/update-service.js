import { checkForUpdate, applyUpdate, writeRollbackMarker, clearRollbackMarker } from './self-update.js';

export class UpdateBusyError extends Error {
  constructor() {
    super('An update check or install is already running.');
    this.name = 'UpdateBusyError';
  }
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
  supervised = () => false,
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
    latest = { ...status, canApply: supervised(), rolledBack, checkedAt: Date.now() };
    onStatus(latest);
    return latest;
  }

  const runCheck = () => exclusive(async () => publish(await check()));

  const runApply = ({ automatic = false } = {}) => exclusive(async () => {
    if (!supervised()) {
      throw new Error('This wrangler was not started by a supervisor, so it cannot restart onto new code. Pull and restart it the way you launched it.');
    }
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
    rolledBack: () => rolledBack,
  };
}
