import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readJsonOrLoud, writeJsonAtomic } from './atomic-json.js';
import { fetchPrObservation, fetchUnresolvedThreads } from './pr-status.js';

function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

export function createPrObservationStore({ directory, events, onError = () => {} } = {}) {
  const observations = new Map();
  const filenameFor = (url) => `${createHash('sha256').update(url).digest('hex')}.json`;
  if (directory) {
    try {
      for (const name of fs.readdirSync(directory)) {
        if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
        const value = readJsonOrLoud(path.join(directory, name), 'PR observation');
        if (typeof value?.url === 'string' && filenameFor(value.url) === name) observations.set(value.url, freeze(value));
      }
    } catch (err) {
      if (err.code !== 'ENOENT') onError('[pr-observations] loading failed', err);
    }
  }
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
      try {
        if (directory) writeJsonAtomic(path.join(directory, filenameFor(url)), next);
      } catch (err) {
        onError('[pr-observations] saving failed', err);
        return false;
      }
      observations.set(url, next);
      events?.emit('pr:observation', next);
      return true;
    },
  };
}

export function createPrObservationPoller({ observations, fetchStatus = fetchPrObservation, fetchUnresolved = fetchUnresolvedThreads }) {
  const inFlight = new Map();
  function fetch(url) {
    if (inFlight.has(url)) return inFlight.get(url);
    const pending = (async () => {
      const result = await fetchStatus(url);
      const fetchedAt = new Date().toISOString();
      const durable = observations.record(url, result, fetchedAt);
      if (!durable && result.status?.state !== 'OPEN') return { status: null };
      const unresolvedThreads = result.status?.state === 'OPEN' ? await fetchUnresolved(url) : null;
      return { status: result.status, fetchedAt, unresolvedCount: unresolvedThreads?.length ?? null, unresolvedThreads };
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
