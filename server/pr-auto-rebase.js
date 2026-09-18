export function statusAfterAutoRebase(status, result) {
  if (result?.kind !== 'rebased') return status;
  const reviewStatus = status.checkStatus === 'changes-requested' || status.checkStatus === 'awaiting-review';
  return { ...status, checkStatus: reviewStatus ? status.checkStatus : 'pending', dirty: false };
}

export async function applyFetchedStatusBeforeAutoRebase(updateFetchedStatus, scheduleRebase) {
  updateFetchedStatus();
  return scheduleRebase();
}

export function createPrAutoRebaser({
  attempt,
  checkoutKey = async (cwd) => cwd,
  checkoutIdleGuard = async () => () => true,
  isEligible = () => true,
  onResult = () => {},
  sessionFor,
  rememberFailure,
  rememberBlocked = () => {},
  notify,
}) {
  const failures = new Map();
  const completed = new Map();
  const inFlight = new Map();

  function canStart({ link, entry, status }) {
    if (link.scope !== 'session' || !entry?.autoRebaseLinkedPr || !status?.rebase
        || status.checkStatus === 'passing' || !isEligible(link)) return null;
    const session = sessionFor(link.ownerId);
    if (session?.status !== 'idle' || !session.managed || session.hasBackgroundShell) return null;
    const cwd = session.cwd || entry.cwd;
    return cwd ? { session, cwd } : null;
  }

  async function prepare({ link, entry, status }) {
    if (link.scope !== 'session' || !status?.rebase) return null;
    const fingerprint = `${status.rebase.head.oid}:${status.rebase.base.oid}`;
    const key = `${link.ownerId}:${link.url}`;
    const prior = completed.get(key);
    if (prior?.fingerprint === fingerprint) return { completed: prior };
    if (link.rebaseBlockedKey === fingerprint) return { completed: { fingerprint, rebased: false } };
    const start = canStart({ link, entry, status });
    if (!start) return null;
    const { cwd } = start;
    const lockKey = await checkoutKey(cwd);
    if (!lockKey) return null;
    const checkoutIsIdle = await checkoutIdleGuard({ cwd, lockKey, ownerId: link.ownerId });
    const currentSession = sessionFor(link.ownerId);
    if (currentSession?.status !== 'idle' || !currentSession.managed || currentSession.hasBackgroundShell || !isEligible(link)
        || !await checkoutIsIdle()) return null;

    const operationId = JSON.stringify([
      link.url,
      status.rebase.head.repo,
      status.rebase.head.ref,
      status.rebase.head.oid,
      status.rebase.base.repo,
      status.rebase.base.ref,
      status.rebase.base.oid,
    ]);
    const active = inFlight.get(lockKey);
    if (active && active.operationId !== operationId) return null;
    return { cwd, lockKey, checkoutIsIdle, fingerprint, key, operationId, active };
  }

  async function execute({ link, entry, status }, prepared) {
    if (prepared.completed) return prepared.completed.rebased ? { kind: 'rebased', repeated: true } : null;
    const { cwd, lockKey, checkoutIsIdle, fingerprint, key, operationId } = prepared;
    const currentActive = inFlight.get(lockKey);
    if (currentActive) {
      if (currentActive.operationId !== operationId) return null;
      const sharedResult = await currentActive.promise;
      if (sharedResult.kind === 'rebased') completed.set(key, { fingerprint, rebased: true });
      return sharedResult;
    }

    const promise = (async () => {
      try {
        return await attempt({
          cwd,
          rebase: status.rebase,
          isIdle: async () => {
            const current = sessionFor(link.ownerId);
            return current?.status === 'idle' && current.managed && !current.hasBackgroundShell && isEligible(link)
              && await checkoutIsIdle();
          },
        });
      } catch (err) {
        return {
          kind: 'failed',
          reason: 'unexpected-error',
          detail: err instanceof Error ? err.message : String(err),
        };
      }
    })();
    inFlight.set(lockKey, { operationId, promise });
    let result;
    try {
      result = await promise;
    } finally {
      if (inFlight.get(lockKey)?.promise === promise) inFlight.delete(lockKey);
    }
    if (result.kind === 'failed' || result.kind === 'conflict') {
      if (result.kind === 'conflict' || result.reason?.endsWith('-local-rewrite')) {
        completed.set(key, { fingerprint, rebased: false });
        rememberBlocked(link.ownerId, link.url, fingerprint);
      }
      const pairSensitive = result.kind === 'conflict' || result.reason?.endsWith('-local-rewrite');
      const notificationKey = pairSensitive
        ? `${result.reason}:${status.rebase.head.oid}:${status.rebase.base.oid}`
        : `${result.reason}:${status.rebase.head.oid}`;
      const alreadyNotified = link.rebaseFailureKey === notificationKey || failures.get(key) === notificationKey;
      failures.set(key, notificationKey);
      if (!alreadyNotified) {
        rememberFailure(link.ownerId, link.url, notificationKey);
        notify(link, result, entry);
      }
    } else if (result.kind === 'rebased'
        || (result.kind === 'deferred' && result.reason === 'already-current')) {
      completed.set(key, { fingerprint, rebased: result.kind === 'rebased' });
    }
    return result;
  }

  async function consider(candidate) {
    const prepared = await prepare(candidate);
    return prepared ? execute(candidate, prepared) : null;
  }

  async function schedule(candidate) {
    const prepared = await prepare(candidate);
    if (!prepared) return false;
    if (prepared.completed) {
      if (prepared.completed.rebased) {
        await onResult(candidate, { kind: 'rebased', repeated: true });
      }
      return false;
    }
    execute(candidate, prepared)
      .then((result) => onResult(candidate, result))
      .catch((err) => onResult(candidate, {
        kind: 'failed',
        reason: 'unexpected-error',
        detail: err instanceof Error ? err.message : String(err),
      }));
    return true;
  }

  return { consider, schedule };
}
