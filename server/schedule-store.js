import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from './data-dir.js';
import { writeJsonAtomic, readJsonOrLoud } from './atomic-json.js';
import { nextRunAt, isValidCron } from './cron-next.js';

const SCHEDULES_FILE = path.join(DATA_DIR, 'schedules.json');

const isoOrNull = (ms) => (ms == null || Number.isNaN(ms) ? null : new Date(ms).toISOString());

// Validate + normalise a schedule's `when`, returning a fresh object or throwing.
// Split out so validateSchedule can ask "is this recurring?" before validating the
// action (the recurring+worktree rule below depends on it).
function validateWhen(when) {
  if (!when || typeof when !== 'object') throw new Error('Schedule needs a "when".');
  if (when.kind === 'once') {
    const ms = Date.parse(when.runAt);
    if (Number.isNaN(ms)) throw new Error('One-off schedule needs a valid date/time.');
    return { kind: 'once', runAt: new Date(ms).toISOString() };
  }
  if (when.kind === 'cron') {
    if (!isValidCron(when.cron)) throw new Error(`Invalid cron expression: ${when.cron}`);
    const w = { kind: 'cron', cron: String(when.cron).trim() };
    if (when.tz) w.tz = when.tz;
    return w;
  }
  throw new Error(`Unknown schedule kind: ${when.kind}`);
}

// Validate + normalise a schedule's ACTION — what fires at the chosen time. Two
// kinds: `dispatch` (launch a brand-new session, the original behaviour) and
// `session` (act on an EXISTING session by card id — the runner branches on the
// target's liveness at fire time: resume it if dormant, deliver into its pane if
// live). The `message` is optional either way — the relaunch prompt for a dormant
// target, the pane text for a live one; there is deliberately NO message-required
// rule, since a live no-message fire is a harmless no-op. A bare/legacy action (no
// kind, just a dispatch bag) is treated as a dispatch. Pure (no `now`), shared by
// create/update. `isCron` carries the recurring-ness so a recurring worktree
// dispatch is forced to auto suffixes (a fixed branch would hit `branch-in-use` on
// the 2nd fire; workflow mode already forces auto inside runDispatch).
function validateAction(action, { isCron }) {
  const a = action && typeof action === 'object' && action.kind ? action : { kind: 'dispatch', dispatch: action };
  if (a.kind === 'dispatch') {
    const d = { ...(a.dispatch && typeof a.dispatch === 'object' ? a.dispatch : {}) };
    if (isCron && d.worktree && !d.workflow) d.worktreeAuto = true;
    return { kind: 'dispatch', dispatch: d };
  }
  if (a.kind === 'session') {
    const sessionId = String(a.sessionId || '').trim();
    if (!sessionId) throw new Error('A session schedule needs a target session.');
    const message = typeof a.message === 'string' ? a.message.trim() : '';
    return { kind: 'session', sessionId, message };
  }
  throw new Error(`Unknown schedule action: ${a.kind}`);
}

// Validate + normalise a schedule's { when, action }, returning fresh objects or
// throwing a clear Error (the control router wraps a handler throw into the
// {type:'error'} frame the client surfaces). Accepts a legacy bare `dispatch` (a
// pre-action schedule) as the action for back-compat. This is the one gate even
// though the control socket is localhost/advisory — a malformed `when` would break
// cron-next.
export function validateSchedule(when, action) {
  const normalisedWhen = validateWhen(when);
  const normalisedAction = validateAction(action, { isCron: normalisedWhen.kind === 'cron' });
  return { when: normalisedWhen, action: normalisedAction };
}

// Old on-disk / caller shape stored the dispatch bag at the top level with no
// `action`. Lift it into a dispatch action so everything downstream is uniform.
function normaliseAction(payload) {
  if (payload.action !== undefined) return payload.action;
  if (payload.dispatch !== undefined) return { kind: 'dispatch', dispatch: payload.dispatch };
  return undefined; // validateAction defaults a missing action to an empty dispatch
}

function migrateStored(s) {
  if (s && typeof s === 'object' && !s.action && s.dispatch) {
    const { dispatch, ...rest } = s;
    return { ...rest, action: { kind: 'dispatch', dispatch } };
  }
  return s;
}

// Durable store of scheduled actions — a schedule is "a saved action + a when".
// Mirrors TaskStore exactly: load once in the constructor, rewrite the whole
// snapshot on every `_save()` via writeJsonAtomic, one file in DATA_DIR.
// `nextRunAt` is PERSISTED (not derived per render) so a fire is dedup-safe across
// ticks and restarts; it's recomputed on create/edit/enable and advanced on fire.
// On disk: { schedules: [{ id, name, enabled, when, action, createdAt, lastRunAt,
//   lastSessionId, nextRunAt, missed }] }.
export class ScheduleStore {
  constructor(file = SCHEDULES_FILE) {
    this.file = file;
    this.schedules = [];
    this._load();
  }

  _load() {
    const raw = readJsonOrLoud(this.file, 'schedules.json');
    if (!raw) return; // missing/empty = first run; corrupt already logged + backed up
    this.schedules = (Array.isArray(raw.schedules) ? raw.schedules : []).map(migrateStored);
  }

  _save() {
    writeJsonAtomic(this.file, { schedules: this.schedules });
  }

  snapshot() {
    return { schedules: this.schedules.map((s) => structuredClone(s)) };
  }

  // Compute the initial nextRunAt from `when` + `now`, assign id/createdAt, persist.
  create({ name, when, ...rest }, now) {
    const v = validateSchedule(when, normaliseAction(rest));
    const schedule = {
      id: `sch_${crypto.randomBytes(4).toString('hex')}`,
      name: (name || '').trim() || 'Untitled schedule',
      enabled: true,
      when: v.when,
      action: v.action,
      createdAt: new Date(now).toISOString(),
      lastRunAt: null,
      lastSessionId: null,
      nextRunAt: isoOrNull(nextRunAt(v.when, now)),
      missed: false,
    };
    this.schedules.push(schedule);
    this._save();
    return structuredClone(schedule);
  }

  // Merge a patch ({ name?, when?, action? }); re-validate (so a changed action
  // re-applies the recurring+worktree rule) and, only if `when` changed, recompute
  // nextRunAt from `now` and clear a prior stale-skip. Returns null for an unknown id.
  update(id, patch = {}, now) {
    const s = this.schedules.find((x) => x.id === id);
    if (!s) return null;
    const whenChanged = patch.when !== undefined;
    const when = whenChanged ? patch.when : s.when;
    const actionGiven = patch.action !== undefined || patch.dispatch !== undefined;
    const action = actionGiven ? normaliseAction(patch) : s.action;
    const v = validateSchedule(when, action);
    if (patch.name !== undefined) s.name = (patch.name || '').trim() || s.name;
    s.when = v.when;
    s.action = v.action;
    if (whenChanged) {
      s.nextRunAt = isoOrNull(nextRunAt(v.when, now));
      s.missed = false;
    }
    this._save();
    return structuredClone(s);
  }

  // On enable, recompute nextRunAt from `now` (so a long-disabled schedule doesn't
  // try to fire for the whole gap it slept through) and clear a stale-skip. Returns
  // null for an unknown id.
  setEnabled(id, enabled, now) {
    const s = this.schedules.find((x) => x.id === id);
    if (!s) return null;
    s.enabled = Boolean(enabled);
    if (s.enabled) {
      s.nextRunAt = isoOrNull(nextRunAt(s.when, now));
      s.missed = false;
    }
    this._save();
    return structuredClone(s);
  }

  delete(id) {
    const i = this.schedules.findIndex((x) => x.id === id);
    if (i < 0) return false;
    this.schedules.splice(i, 1);
    this._save();
    return true;
  }

  // Enabled schedules whose persisted nextRunAt is now due (<= now). Deep-copied so
  // the firing loop can't mutate stored state out from under _save().
  due(now) {
    return this.schedules
      .filter((s) => s.enabled && s.nextRunAt != null && Date.parse(s.nextRunAt) <= now)
      .map((s) => structuredClone(s));
  }

  // Record a fire, then (when `advance`) ADVANCE: a cron jumps nextRunAt to the
  // next occurrence STRICTLY AFTER `now` (so a slot missed during downtime fires
  // exactly once, no backlog); a one-off disables itself and clears nextRunAt.
  // run-now passes `advance:false` to log the run without disturbing nextRunAt
  // (so it never advances/disables the schedule). Returns null for an unknown id.
  markFired(id, { at, sessionId } = {}, now, { advance = true } = {}) {
    const s = this.schedules.find((x) => x.id === id);
    if (!s) return null;
    s.lastRunAt = at || new Date(now).toISOString();
    s.lastSessionId = sessionId || null;
    if (advance) {
      if (s.when.kind === 'cron') {
        s.nextRunAt = isoOrNull(nextRunAt(s.when, now));
      } else {
        s.enabled = false;
        s.nextRunAt = null;
      }
    }
    this._save();
    return structuredClone(s);
  }

  // A one-off so overdue it's skipped rather than fired (the staleness rule lives
  // in index.js, which owns the threshold): disable, flag missed, clear nextRunAt.
  markMissed(id) {
    const s = this.schedules.find((x) => x.id === id);
    if (!s) return null;
    s.enabled = false;
    s.missed = true;
    s.nextRunAt = null;
    this._save();
    return structuredClone(s);
  }
}
