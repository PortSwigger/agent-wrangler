import { readJsonOrLoud, writeJsonAtomic } from './atomic-json.js';
import { fetchPrObservation, fetchUnresolvedThreadCount } from './pr-status.js';

function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

function content({ fetchedAt, attemptedAt, ...rest }) {
  return JSON.stringify(rest);
}

export function createPrObservationStore({ file, events, onError = () => {} } = {}) {
  const saved = file ? readJsonOrLoud(file, 'PR observations') : null;
  const observations = new Map(Object.entries(saved?.observations || {}).map(([url, value]) => [url, freeze(value)]));
  return {
    get: (url) => observations.get(url) ?? null,
    all: () => Object.freeze(Object.fromEntries(observations)),
    record(url, { status, error }, at = new Date().toISOString()) {
      const previous = observations.get(url);
      const samePr = !status || !previous || previous.nodeId === status.nodeId;
      const next = freeze({
        ...((samePr && previous) || { url, nodeId: null, createdAt: null, state: null, title: null, number: null, isDraft: null, headSha: null,
          mergeStateStatus: null, statusCheckRollup: null, reviewDecision: null, checkStatus: null, dirty: null, fetchedAt: null }),
        ...(status ? { ...structuredClone(status), state: status.state.toLowerCase(), fetchedAt: at } : {}),
        attemptedAt: at, lastError: error,
      });
      const snapshot = new Map(observations).set(url, next);
      try {
        if (file) writeJsonAtomic(file, { observations: Object.fromEntries(snapshot) });
      } catch (err) {
        onError('[pr-observations] saving failed', err);
        return false;
      }
      observations.set(url, next);
      if (!previous || content(previous) !== content(next)) events?.emit('pr:observation', next);
      return true;
    },
  };
}

export function createPrObservationPoller({ observations, fetchStatus = fetchPrObservation, fetchUnresolved = fetchUnresolvedThreadCount }) {
  const inFlight = new Map();
  function fetch(url) {
    if (inFlight.has(url)) return inFlight.get(url);
    const pending = (async () => {
      const result = await fetchStatus(url);
      const fetchedAt = new Date().toISOString();
      if (!observations.record(url, result, fetchedAt)) return { status: null };
      const unresolvedCount = result.status?.state === 'OPEN' ? await fetchUnresolved(url) : null;
      return { status: result.status, fetchedAt, unresolvedCount };
    })().finally(() => inFlight.delete(url));
    inFlight.set(url, pending);
    return pending;
  }
  return async function* (links) {
    const byUrl = new Map();
    for (const link of links) {
      if (!byUrl.has(link.url)) byUrl.set(link.url, []);
      byUrl.get(link.url).push(link);
    }
    for (const [url, owners] of byUrl) {
      const result = await fetch(url);
      for (const link of owners) yield { ...link, ...result, previousUnresolvedCount: link.unresolvedCount };
    }
  };
}
