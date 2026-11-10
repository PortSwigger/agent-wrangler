import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { checkEventData, accepts, REPO_RE } from './extensions/telemetry-schema.js';

// Core telemetry: the one queue every emitter (core itself, and each extension
// declaring `telemetry:emit`) writes to, and the transport to every sink an
// extension contributes (`telemetry:sink`). This repository holds no endpoint:
// with no sink installed nothing is queued and nothing is sent.
//
// Off until the human switches it on in Settings › Telemetry. While off, emit
// is a no-op; switching off drops whatever was queued.
//
// Every event is checked three times: at emit against the emitter's declared
// catalogue (an undeclared or ill-typed field throws), again before each send
// against the catalogue as it stands then (undeclared fields are stripped, an
// event that no longer fits is dropped), and at the collector.
//
// State lives in <DATA_DIR>/telemetry.json (0600): the install id, the secret
// refs are keyed with (never sent), the queue and per-sink counters. The switch
// and the team live in config.json beside every other setting.

export const QUEUE_MAX = 5000;
export const QUEUE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const BODY_MAX_BYTES = 64 * 1024;
export const BACKOFF_START_MS = 15_000;
export const BACKOFF_MAX_MS = 60 * 60 * 1000;
export const FLUSH_EVERY_MS = 15_000;
const FLUSH_SOON_MS = 1_000;
const SAVE_DELAY_MS = 500;
const SEND_TIMEOUT_MS = 15_000;
const BATCHES_PER_FLUSH = 10;
const RETRY_STATUS = new Set([404, 408, 429]);

export const CORE_EMITTER = 'core';

function tsOf(ms) {
  return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace('.000Z', 'Z');
}

function writePrivate(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function readState(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

// `owner/name` from a slug or a git remote (https, ssh, scp-like), lowercased,
// `.git` dropped; null when it is neither.
export function repoSlug(raw) {
  if (typeof raw !== 'string') return null;
  let s = raw.trim();
  if (!s) return null;
  const scp = /^[\w.-]+@[\w.-]+:(.+)$/.exec(s);
  if (scp) s = scp[1];
  else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    try { s = new URL(s).pathname; } catch { return null; }
  }
  s = s.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/i, '');
  const parts = s.split('/');
  if (parts.length !== 2) return null;
  const slug = parts.join('/').toLowerCase();
  return REPO_RE.test(slug) ? slug : null;
}

export function createTelemetry({
  file,
  readConfig = () => ({}),
  writeConfig = () => {},
  fetchImpl = globalThis.fetch,
  now = Date.now,
  awVersion = '0.0.0',
  isModel = () => false,
  log = () => {},
  onChange = () => {},
  timers = { setTimeout, clearTimeout, setInterval, clearInterval },
} = {}) {
  const state = readState(file);
  let dirty = false;
  if (typeof state.install !== 'string') { state.install = crypto.randomUUID(); dirty = true; }
  if (typeof state.secret !== 'string' || state.secret.length !== 64) { state.secret = crypto.randomBytes(32).toString('hex'); dirty = true; }
  if (!Array.isArray(state.queue)) state.queue = [];
  if (!state.stats || typeof state.stats !== 'object') state.stats = {};
  if (dirty) writePrivate(file, state);

  // emitter id -> { version, catalogue }
  const emitters = new Map();
  // `${extId}/${sinkId}` -> { key, extId, extLabel, ...sink }
  const sinks = new Map();
  // sink key -> { failures, nextAt }
  const backoff = new Map();
  let saveTimer = null;
  let soonTimer = null;
  let interval = null;
  let flushing = null;

  const cfg = () => {
    const t = readConfig().telemetry;
    return t && typeof t === 'object' ? t : {};
  };
  const enabled = () => cfg().enabled === true;
  const teamChoice = () => (typeof cfg().team === 'string' ? cfg().team : null);

  function save() {
    if (saveTimer) return;
    saveTimer = timers.setTimeout(() => { saveTimer = null; saveNow(); }, SAVE_DELAY_MS);
    saveTimer.unref?.();
  }
  function saveNow() {
    if (saveTimer) { timers.clearTimeout(saveTimer); saveTimer = null; }
    try { writePrivate(file, state); } catch (err) { log('[telemetry] could not save the queue', err); }
  }
  function changed() {
    save();
    try { onChange(); } catch { /* a listener's failure is not the queue's */ }
  }
  function statsFor(key) {
    if (!state.stats[key]) state.stats[key] = { sent: 0, dropped: 0, lastSentAt: null, lastError: null, lastErrorAt: null };
    return state.stats[key];
  }

  // Drops what is too old or beyond the cap, oldest first, and entries no sink
  // is waiting on any more.
  function trim() {
    const cutoff = now() - QUEUE_MAX_AGE_MS;
    const before = state.queue.length;
    state.queue = state.queue.filter((q) => q.at >= cutoff && q.pending.length);
    if (state.queue.length > QUEUE_MAX) state.queue = state.queue.slice(state.queue.length - QUEUE_MAX);
    return before - state.queue.length;
  }

  function sinksFor(type) {
    return [...sinks.values()].filter((s) => accepts(s.accepts, type));
  }

  function on() {
    return enabled() && sinks.size > 0;
  }

  function emit(emitterId, name, data) {
    const em = emitters.get(emitterId);
    const where = `telemetry.emit(${JSON.stringify(name)})`;
    if (!em) throw new Error(`${where}: ${emitterId} declares no telemetry events`);
    if (typeof name !== 'string' || !Object.hasOwn(em.catalogue, name)) throw new TypeError(`${where}: not declared in telemetry.events`);
    const spec = em.catalogue[name];
    // Checked even when nothing will be sent, so an emitter's bug shows in
    // development rather than only on the machines that switched it on.
    const fields = checkEventData(spec, data, { strict: true, isModel, where });
    if (!enabled()) return false;
    const type = `${emitterId}.${name}`;
    const targets = sinksFor(type);
    if (!targets.length) return false;
    const at = now();
    state.queue.push({
      at,
      e: { eventId: crypto.randomUUID(), ts: tsOf(at), type, v: spec.v, emitter: emitterId, name, emitterVersion: em.version, data: fields },
      pending: targets.map((s) => s.key),
    });
    trim();
    changed();
    flushSoon();
    return true;
  }

  // The wire form for one sink: the envelope plus the fields the catalogue
  // declares NOW (anything else is stripped), with repo and team narrowed to
  // that sink's own allowlists. Null when it no longer fits.
  function render(entry, sink) {
    const { e } = entry;
    const em = emitters.get(e.emitter);
    const spec = em?.catalogue[e.name];
    if (!spec || spec.v !== e.v) return null;
    const data = checkEventData(spec, e.data, { strict: false, isModel });
    if (!data) return null;
    for (const [key, type] of Object.entries(spec.fields)) {
      if (type.t !== 'repo' || typeof data[key] !== 'string' || !data[key].includes('/')) continue;
      if (!sink.repoOwners.includes(data[key].split('/')[0])) data[key] = 'other';
    }
    const team = teamChoice();
    return {
      eventId: e.eventId,
      ts: e.ts,
      type: e.type,
      v: e.v,
      install: state.install,
      team: team && sink.teams.includes(team) ? team : null,
      awVersion,
      emitterVersion: e.emitterVersion,
      ...data,
    };
  }

  function settle(entries, key) {
    for (const q of entries) q.pending = q.pending.filter((k) => k !== key);
  }

  // One batch to one sink. Returns 'sent', 'retry', 'dropped' or 'idle'.
  async function sendBatch(sink) {
    const due = state.queue.filter((q) => q.pending.includes(sink.key));
    if (!due.length) return 'idle';
    const picked = [];
    const events = [];
    for (const q of due) {
      if (events.length >= sink.batchMax) break;
      const wire = render(q, sink);
      if (!wire) { settle([q], sink.key); statsFor(sink.key).dropped += 1; continue; }
      picked.push(q);
      events.push(wire);
    }
    while (events.length && Buffer.byteLength(JSON.stringify({ events })) > BODY_MAX_BYTES) {
      if (events.length === 1) {
        settle(picked, sink.key);
        statsFor(sink.key).dropped += 1;
        return 'dropped';
      }
      events.pop();
      picked.pop();
    }
    if (!events.length) return 'idle';
    const stats = statsFor(sink.key);
    let status = 0;
    let failure = null;
    const ctl = new AbortController();
    const timer = timers.setTimeout(() => ctl.abort(), SEND_TIMEOUT_MS);
    timer.unref?.();
    try {
      const res = await fetchImpl(sink.endpoint, {
        method: 'POST',
        headers: { ...sink.headers, 'content-type': 'application/json' },
        body: JSON.stringify({ events }),
        signal: ctl.signal,
        redirect: 'error',
      });
      status = res.status;
      try { await res.text(); } catch { /* the body is not ours to read */ }
    } catch (err) {
      failure = err?.name === 'AbortError' ? 'timed out' : String(err?.cause?.code || err?.message || err);
    } finally {
      timers.clearTimeout(timer);
    }
    // The sink may have been removed while the request was in flight.
    if (!sinks.has(sink.key)) return 'idle';
    if (status >= 200 && status < 300) {
      settle(picked, sink.key);
      stats.sent += picked.length;
      stats.lastSentAt = now();
      stats.lastError = null;
      backoff.delete(sink.key);
      return 'sent';
    }
    if (status && status < 500 && !RETRY_STATUS.has(status)) {
      settle(picked, sink.key);
      stats.dropped += picked.length;
      stats.lastError = `HTTP ${status}: batch of ${picked.length} refused and dropped`;
      stats.lastErrorAt = now();
      backoff.delete(sink.key);
      return 'dropped';
    }
    const b = backoff.get(sink.key) || { failures: 0, nextAt: 0 };
    b.failures += 1;
    const wait = Math.min(BACKOFF_START_MS * 2 ** (b.failures - 1), BACKOFF_MAX_MS);
    b.nextAt = now() + wait;
    backoff.set(sink.key, b);
    stats.lastError = `${failure || `HTTP ${status}`}: retrying in ${Math.round(wait / 1000)}s`;
    stats.lastErrorAt = now();
    return 'retry';
  }

  async function flushOnce() {
    if (!on()) return;
    const dropped = trim();
    if (dropped) log(`[telemetry] dropped ${dropped} queued events past the cap or age limit`);
    for (const sink of [...sinks.values()]) {
      for (let i = 0; i < BATCHES_PER_FLUSH; i += 1) {
        const b = backoff.get(sink.key);
        if (b && now() < b.nextAt) break;
        const r = await sendBatch(sink);
        if (r === 'idle' || r === 'retry') break;
      }
    }
    trim();
    changed();
  }

  // One flush at a time: a slow sink must not let the timer start a second
  // flush that sends the same batch again.
  function flush() {
    if (!flushing) flushing = flushOnce().finally(() => { flushing = null; });
    return flushing;
  }

  function flushSoon() {
    if (soonTimer || !interval) return;
    soonTimer = timers.setTimeout(() => { soonTimer = null; flush().catch((err) => log('[telemetry] flush failed', err)); }, FLUSH_SOON_MS);
    soonTimer.unref?.();
  }

  function dropSinkFromQueue(key) {
    settle(state.queue, key);
    backoff.delete(key);
    trim();
  }

  // What Settings › Telemetry shows. Never the headers or the secret.
  function status() {
    const team = teamChoice();
    return {
      enabled: enabled(),
      install: state.install,
      team,
      teams: [...new Set([...sinks.values()].flatMap((s) => s.teams))],
      queued: state.queue.length,
      sinks: [...sinks.values()].map((s) => {
        const st = state.stats[s.key] || {};
        const b = backoff.get(s.key);
        return {
          key: s.key,
          extId: s.extId,
          extLabel: s.extLabel,
          id: s.id,
          label: s.label,
          host: s.host,
          accepts: [...s.accepts],
          headerNames: Object.keys(s.headers),
          pending: state.queue.filter((q) => q.pending.includes(s.key)).length,
          sent: st.sent || 0,
          dropped: st.dropped || 0,
          lastSentAt: st.lastSentAt ?? null,
          lastError: st.lastError ?? null,
          lastErrorAt: st.lastErrorAt ?? null,
          retryAt: b ? b.nextAt : null,
        };
      }),
      emitters: [...emitters.entries()].map(([id, em]) => ({
        id,
        version: em.version,
        events: Object.entries(em.catalogue).map(([name, spec]) => ({ type: `${id}.${name}`, v: spec.v, fields: Object.keys(spec.fields) })),
      })),
    };
  }

  return {
    install: () => state.install,
    enabled,
    on,
    emit,
    flush,
    saveNow,

    // HMAC of `${kind}:${id}` under the install secret, cut to 16 hex: the
    // same local id always gives the same ref on this machine, and the ref
    // cannot be turned back into the id anywhere else.
    ref(kind, id) {
      if (typeof kind !== 'string' || !kind || id == null || id === '') throw new TypeError('telemetry.ref(kind, id): both are required');
      return crypto.createHmac('sha256', Buffer.from(state.secret, 'hex')).update(`${kind}:${id}`).digest('hex').slice(0, 16);
    },

    // `owner/name`, or 'none' for nothing. Each sink later narrows an owner it
    // does not list to 'other', so the queue holds the slug and the wire never
    // carries a name outside the sink's allowlist.
    repo(raw) {
      if (raw == null || raw === '') return 'none';
      return repoSlug(raw) ?? 'other';
    },

    model(raw) {
      if (raw == null || raw === '') return 'default';
      return isModel(raw) ? raw : 'other';
    },

    registerEmitter(id, { version = '0.0.0', events }) {
      emitters.set(id, { version, catalogue: events });
      onChange();
    },
    unregisterEmitter(id) {
      if (emitters.delete(id)) onChange();
    },
    registerSinks(extId, { label = extId, sinks: list = [] } = {}) {
      for (const s of list) {
        const key = `${extId}/${s.id}`;
        sinks.set(key, { ...s, key, extId, extLabel: label });
      }
      onChange();
    },
    unregisterSinks(extId) {
      let any = false;
      for (const key of [...sinks.keys()]) {
        if (sinks.get(key).extId !== extId) continue;
        sinks.delete(key);
        dropSinkFromQueue(key);
        any = true;
      }
      if (any) changed();
    },

    setEnabled(value) {
      const next = value === true;
      writeConfig({ telemetry: { ...cfg(), enabled: next } });
      if (!next) {
        state.queue = [];
        backoff.clear();
        saveNow();
      }
      onChange();
    },
    setTeam(team) {
      const offered = new Set([...sinks.values()].flatMap((s) => s.teams));
      const next = typeof team === 'string' && offered.has(team) ? team : null;
      writeConfig({ telemetry: { ...cfg(), team: next } });
      onChange();
    },
    clearQueue() {
      state.queue = [];
      saveNow();
      onChange();
    },

    // The newest queued events, as each would leave for its first pending sink.
    preview(limit = 50) {
      return state.queue.slice(-limit).reverse().map((q) => {
        const sink = sinks.get(q.pending[0]);
        return { sink: sink ? sink.host : null, event: sink ? render(q, sink) : null };
      }).filter((p) => p.event);
    },

    status,

    // This extension's own sinks, for `telemetry:sink`.
    sinkStatus(extId) {
      return status().sinks.filter((s) => s.extId === extId).map(({ id, host, pending, sent, dropped, lastSentAt, lastError }) => ({ id, host, pending, sent, dropped, lastSentAt, lastError }));
    },

    start() {
      if (interval) return;
      interval = timers.setInterval(() => { flush().catch((err) => log('[telemetry] flush failed', err)); }, FLUSH_EVERY_MS);
      interval.unref?.();
    },
    stop() {
      if (interval) timers.clearInterval(interval);
      if (soonTimer) timers.clearTimeout(soonTimer);
      interval = null;
      soonTimer = null;
      saveNow();
    },
  };
}
