// Notification snooze: silence toasts, browser Notifications and cues for one
// source (a session or a PR) or for everything, for a few minutes. Client-only
// and unrelated to session snooze (snooze.js), which hides a card. Expiry is
// always judged against `now` at check time; timers only refresh the indicator.
// Notifications that arrive while snoozed are dropped, not replayed.

export const SNOOZE_MINUTES = [5, 10, 30];
export const DEFAULT_SNOOZE_MINUTES = 10;
export const NOTIFICATION_SNOOZE_KEY = 'aw.notificationSnooze';
const MINUTE = 60e3;

export function emptySnoozes() {
  return { all: null, sources: {}, minutes: DEFAULT_SNOOZE_MINUTES };
}

export const sessionSource = (sessionId) => `session:${sessionId}`;
export const prSource = (url) => `pr:${url}`;

// The sources an event belongs to. A session-scope PR event is silenced by
// snoozing either its PR or its session; a task-scope one only by its PR.
export function snoozeKeysFor(scope, ownerId, prUrl) {
  const keys = [];
  if (scope === 'session' && ownerId) keys.push(sessionSource(ownerId));
  if (prUrl) keys.push(prSource(prUrl));
  return keys;
}

const validMinutes = (m) => (SNOOZE_MINUTES.includes(m) ? m : DEFAULT_SNOOZE_MINUTES);
const live = (until, now) => typeof until === 'number' && until > now;

export function pruneSnoozes(state, now) {
  const sources = {};
  for (const [key, entry] of Object.entries(state?.sources || {})) {
    if (entry && live(entry.until, now)) sources[key] = { until: entry.until, label: String(entry.label || key) };
  }
  return { all: live(state?.all, now) ? state.all : null, sources, minutes: validMinutes(state?.minutes) };
}

export function parseSnoozes(raw, now) {
  if (!raw) return emptySnoozes();
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? pruneSnoozes(parsed, now) : emptySnoozes();
  } catch {
    return emptySnoozes();
  }
}

export function snoozeSource(state, key, label, minutes, now) {
  const next = pruneSnoozes(state, now);
  next.sources[key] = { until: now + validMinutes(minutes) * MINUTE, label: label || key };
  return next;
}

export function snoozeAll(state, minutes, now) {
  return { ...pruneSnoozes(state, now), all: now + validMinutes(minutes) * MINUTE };
}

export function cancelSource(state, key, now) {
  const next = pruneSnoozes(state, now);
  delete next.sources[key];
  return next;
}

export function cancelAll(state, now) {
  return { ...pruneSnoozes(state, now), all: null };
}

export function setSnoozeMinutes(state, minutes, now) {
  return { ...pruneSnoozes(state, now), minutes: validMinutes(minutes) };
}

export function isSnoozed(state, keys, now) {
  if (live(state?.all, now)) return true;
  return keys.some((k) => live(state?.sources?.[k]?.until, now));
}

// Active snoozes, "all" first, then sources soonest-expiring first.
export function activeSnoozes(state, now) {
  const pruned = pruneSnoozes(state, now);
  const list = Object.entries(pruned.sources)
    .map(([key, e]) => ({ key, label: e.label, until: e.until }))
    .sort((a, b) => a.until - b.until);
  return pruned.all ? [{ key: 'all', label: 'All notifications', until: pruned.all }, ...list] : list;
}

export function remainingLabel(until, now) {
  const ms = until - now;
  if (ms <= 0) return '0m';
  if (ms < MINUTE) return '<1m';
  return `${Math.ceil(ms / MINUTE)}m`;
}

// Persistence wrapper. Every storage access is guarded: a private window or
// blocked site data just means snoozes don't survive a reload.
export function createSnoozeStore({ storage, now = () => Date.now(), key = NOTIFICATION_SNOOZE_KEY }) {
  let state = load();
  const listeners = new Set();

  function load() {
    try { return parseSnoozes(storage?.getItem(key), now()); } catch { return emptySnoozes(); }
  }
  function commit(next) {
    state = next;
    try { storage?.setItem(key, JSON.stringify(state)); } catch {}
    for (const fn of listeners) fn(state);
  }

  return {
    get: () => pruneSnoozes(state, now()),
    isSnoozed: (keys) => isSnoozed(state, keys, now()),
    active: () => activeSnoozes(state, now()),
    minutes: () => validMinutes(state.minutes),
    snoozeSource: (k, label, minutes = state.minutes) => commit(snoozeSource(state, k, label, minutes, now())),
    snoozeAll: (minutes = state.minutes) => commit(snoozeAll(state, minutes, now())),
    cancelSource: (k) => commit(cancelSource(state, k, now())),
    cancelAll: () => commit(cancelAll(state, now())),
    setMinutes: (minutes) => commit(setSnoozeMinutes(state, minutes, now())),
    reload: () => { state = load(); for (const fn of listeners) fn(state); },
    subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
  };
}

// The toast buttons: snooze this source (when it has one) or everything, for
// the chosen length.
export function snoozeToastActions(store, key, label) {
  const all = { label: 'Snooze all', onClick: () => store.snoozeAll() };
  if (!key) return [all];
  return [{ label: `Snooze ${store.minutes()}m`, onClick: () => store.snoozeSource(key, label) }, all];
}
