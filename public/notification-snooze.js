// Notification snooze: the clock on a notification toast hides it for a few
// minutes and then shows it again; "Snooze all" hides every notification on
// screen and holds new ones until it ends. A held notification comes back only
// if it is still true (the session still needs you, the PR is still in that
// state), and a newer notification for the same session or PR replaces it.
// Client-only and unrelated to session snooze (snooze.js), which hides a card.

export const SNOOZE_MINUTES = [5, 10, 30];
export const DEFAULT_SNOOZE_MINUTES = 10;
export const NOTIFICATION_SNOOZE_KEY = 'aw.notificationSnooze';
const MINUTE = 60e3;

export const NOTIFICATION_KINDS = ['notify', 'pr-checks', 'pr-merge', 'pr-dirty', 'pr-unresolved'];

export function emptySnoozes() {
  return { all: null, held: [] };
}

export function snoozeMinutes(value) {
  const m = Number(value);
  return SNOOZE_MINUTES.includes(m) ? m : DEFAULT_SNOOZE_MINUTES;
}

// What a notification is about: a newer one with the same key supersedes it.
export function notificationKey(msg) {
  if (msg?.type === 'notify') return `session:${msg.session?.sessionId}`;
  return `pr:${msg?.url || msg?.sessionId}`;
}

const live = (until, now) => typeof until === 'number' && until > now;
const validEntry = (e) => e && NOTIFICATION_KINDS.includes(e.msg?.type) && typeof e.until === 'number';

export function normalizeSnoozes(state, now) {
  const held = [];
  for (const e of Array.isArray(state?.held) ? state.held : []) {
    if (validEntry(e)) held.push({ key: notificationKey(e.msg), msg: e.msg, until: e.until });
  }
  return { all: live(state?.all, now) ? state.all : null, held };
}

export function parseSnoozes(raw, now) {
  if (!raw) return emptySnoozes();
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? normalizeSnoozes(parsed, now) : emptySnoozes();
  } catch {
    return emptySnoozes();
  }
}

export function holdNotification(state, msg, until) {
  const key = notificationKey(msg);
  return { ...state, held: [...state.held.filter((e) => e.key !== key), { key, msg, until }] };
}

export function supersede(state, msg) {
  const key = notificationKey(msg);
  return { ...state, held: state.held.filter((e) => e.key !== key) };
}

export function snoozeAll(state, msgs, minutes, now) {
  const all = now + snoozeMinutes(minutes) * MINUTE;
  let next = { ...state, all };
  for (const msg of msgs) next = holdNotification(next, msg, all);
  return next;
}

// Held notifications whose time is up. Snooze all keeps everything held.
export function takeDue(state, now) {
  if (live(state.all, now)) return { state, due: [] };
  const due = state.held.filter((e) => e.until <= now);
  return { state: { all: null, held: state.held.filter((e) => e.until > now) }, due: due.map((e) => e.msg) };
}

export function nextWake(state, now) {
  if (live(state.all, now)) return state.all;
  return state.held.length ? Math.min(...state.held.map((e) => e.until)) : null;
}

// Whether a held notification still describes the world. `lookup` answers from
// the board's latest state: session(id) and prLink(url). An unknown PR link
// (another deck, or no longer linked) can't be checked, so it comes back.
export function stillTrue(msg, { session, prLink }) {
  if (msg.type === 'notify') return session(msg.session?.sessionId)?.status === 'needs-you';
  if (msg.type === 'pr-merge') return true;
  const link = msg.url ? prLink(msg.url) : null;
  if (!link) return true;
  if (msg.type === 'pr-checks') return link.checkStatus === msg.status;
  if (msg.type === 'pr-dirty') return link.dirty === true;
  if (msg.type === 'pr-unresolved') return (link.unresolvedCount ?? 0) > 0;
  return true;
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
    get: () => normalizeSnoozes(state, now()),
    allActive: () => live(state.all, now()),
    hold: (msg, minutes) => commit(holdNotification(state, msg, now() + snoozeMinutes(minutes) * MINUTE)),
    holdForAll: (msg) => commit(holdNotification(state, msg, state.all)),
    supersede: (msg) => { if (state.held.some((e) => e.key === notificationKey(msg))) commit(supersede(state, msg)); },
    snoozeAll: (msgs, minutes) => commit(snoozeAll(state, msgs, minutes, now())),
    takeDue: () => {
      const { state: next, due } = takeDue(normalizeSnoozes(state, now()), now());
      if (due.length || next.all !== state.all) commit(next);
      return due;
    },
    nextWake: () => nextWake(state, now()),
    reload: () => { state = load(); for (const fn of listeners) fn(state); },
    subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
  };
}
