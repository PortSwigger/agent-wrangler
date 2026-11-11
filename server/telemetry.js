import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { checkEventData, checkEndpoint, REPO_RE } from './extensions/telemetry-schema.js';

// Core telemetry: the one queue every emitter (core itself, and each extension
// declaring `telemetry:emit`) writes to, and the transport to the one collector
// core sends to. The collector is built in (BUILTIN_ENDPOINT) and takes no
// credentials: its ingress only admits the owning organisation's office
// network, so from anywhere else a send fails and the events wait in the queue.
// AW_TELEMETRY_URL, then `telemetry.url` in config.json, point it elsewhere (a
// dev collector or a local stub).
//
// Always on, with no switch: events queue from first run and send whenever the
// collector is reachable. The URL override is for development, not a way out.
//
// Every event is checked three times: at emit against the emitter's declared
// catalogue (an undeclared or ill-typed field throws), again before each send
// against the catalogue as it stands then (undeclared fields are stripped, an
// event that no longer fits is dropped), and at the collector.
//
// State lives in <DATA_DIR>/telemetry.json (0600): the install id, the secret
// refs are keyed with (never sent), the queue and the send counters. Any URL
// override lives in config.json beside every other setting.

export const BUILTIN_ENDPOINT = 'https://wrangler-telemetry.platform-prod.portswigger.io/v1/events';
export const ENDPOINT_ENV = 'AW_TELEMETRY_URL';
// Only these GitHub owners' repo names are sent; any other repo goes as `other`.
export const REPO_OWNERS = Object.freeze(['portswigger', 'portswigger-apps']);

export const QUEUE_MAX = 5000;
export const QUEUE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const BODY_MAX_BYTES = 64 * 1024;
export const BATCH_MAX = 100;
export const BACKOFF_START_MS = 15_000;
export const BACKOFF_MAX_MS = 60 * 60 * 1000;
export const FLUSH_EVERY_MS = 15_000;
const FLUSH_SOON_MS = 1_000;
const SAVE_DELAY_MS = 500;
const SEND_TIMEOUT_MS = 15_000;
const BATCHES_PER_FLUSH = 10;
// 403 is what an ingress allowlist answers off the office network: keep the
// events for when the machine is back on it.
const RETRY_STATUS = new Set([403, 404, 408, 429]);

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
  fetchImpl = globalThis.fetch,
  now = Date.now,
  env = process.env,
  builtinEndpoint = BUILTIN_ENDPOINT,
  repoOwners = REPO_OWNERS,
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
  state.queue = Array.isArray(state.queue) ? state.queue.filter((q) => q && typeof q.at === 'number' && q.e && typeof q.e === 'object').map(({ at, e }) => ({ at, e })) : [];
  if (!state.sink || typeof state.sink !== 'object') state.sink = { sent: 0, dropped: 0, lastSentAt: null, lastError: null, lastErrorAt: null };
  delete state.stats;
  if (dirty) writePrivate(file, state);

  // emitter id -> { version, catalogue }
  const emitters = new Map();
  // { url, failures, nextAt }: reset when the URL changes.
  let backoff = null;
  let saveTimer = null;
  let soonTimer = null;
  let interval = null;
  let flushing = null;
  // The invalid override last logged, so the flush timer logs it once.
  let warnedUrl = null;

  const cfg = () => {
    const t = readConfig().telemetry;
    return t && typeof t === 'object' ? t : {};
  };

  // Where events go now: AW_TELEMETRY_URL, then config.json `telemetry.url`,
  // then the built-in collector. An override that is not a valid endpoint is
  // not fallen back from (that would send to the collector it meant to avoid):
  // nothing is sent and the log says why, once per URL.
  function destination() {
    const fromEnv = typeof env?.[ENDPOINT_ENV] === 'string' ? env[ENDPOINT_ENV].trim() : '';
    const fromCfg = typeof cfg().url === 'string' ? cfg().url.trim() : '';
    const [url, source] = fromEnv ? [fromEnv, 'env'] : fromCfg ? [fromCfg, 'config'] : [builtinEndpoint, 'builtin'];
    return { url, source, error: checkEndpoint(url) };
  }

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

  // Drops what is too old or beyond the cap, oldest first.
  function trim() {
    const cutoff = now() - QUEUE_MAX_AGE_MS;
    const before = state.queue.length;
    state.queue = state.queue.filter((q) => q.at >= cutoff);
    if (state.queue.length > QUEUE_MAX) state.queue = state.queue.slice(state.queue.length - QUEUE_MAX);
    return before - state.queue.length;
  }

  // False only while a URL override is not a valid endpoint.
  function on() {
    return !destination().error;
  }

  function emit(emitterId, name, data) {
    const em = emitters.get(emitterId);
    const where = `telemetry.emit(${JSON.stringify(name)})`;
    if (!em) throw new Error(`${where}: ${emitterId} declares no telemetry events`);
    if (typeof name !== 'string' || !Object.hasOwn(em.catalogue, name)) throw new TypeError(`${where}: not declared in telemetry.events`);
    const spec = em.catalogue[name];
    // Checked even when nothing will be sent, so an emitter's bug shows
    // under a broken override too.
    const fields = checkEventData(spec, data, { strict: true, isModel, where });
    if (!on()) return false;
    const at = now();
    state.queue.push({
      at,
      e: { eventId: crypto.randomUUID(), ts: tsOf(at), type: `${emitterId}.${name}`, v: spec.v, emitter: emitterId, name, emitterVersion: em.version, data: fields },
    });
    trim();
    changed();
    flushSoon();
    return true;
  }

  // The wire form: the envelope plus the fields the catalogue declares NOW
  // (anything else is stripped), with repo narrowed to core's allowlist. Null when it no longer fits.
  function render(entry) {
    const { e } = entry;
    const em = emitters.get(e.emitter);
    const spec = em?.catalogue[e.name];
    if (!spec || spec.v !== e.v) return null;
    const data = checkEventData(spec, e.data, { strict: false, isModel });
    if (!data) return null;
    for (const [key, type] of Object.entries(spec.fields)) {
      if (type.t !== 'repo' || typeof data[key] !== 'string' || !data[key].includes('/')) continue;
      if (!repoOwners.includes(data[key].split('/')[0])) data[key] = 'other';
    }
    return {
      eventId: e.eventId,
      ts: e.ts,
      type: e.type,
      v: e.v,
      install: state.install,
      awVersion,
      emitterVersion: e.emitterVersion,
      ...data,
    };
  }

  function remove(entries) {
    const gone = new Set(entries);
    state.queue = state.queue.filter((q) => !gone.has(q));
  }

  // One batch, oldest first. Returns 'sent', 'retry', 'dropped' or 'idle'.
  async function sendBatch(dest) {
    const stats = state.sink;
    const picked = [];
    const events = [];
    const unfit = [];
    for (const q of state.queue) {
      if (events.length >= BATCH_MAX) break;
      const wire = render(q);
      if (!wire) { unfit.push(q); continue; }
      picked.push(q);
      events.push(wire);
    }
    if (unfit.length) { remove(unfit); stats.dropped += unfit.length; }
    while (events.length && Buffer.byteLength(JSON.stringify({ events })) > BODY_MAX_BYTES) {
      if (events.length === 1) {
        remove(picked);
        stats.dropped += 1;
        return 'dropped';
      }
      events.pop();
      picked.pop();
    }
    if (!events.length) return 'idle';
    let status = 0;
    let failure = null;
    const ctl = new AbortController();
    const timer = timers.setTimeout(() => ctl.abort(), SEND_TIMEOUT_MS);
    timer.unref?.();
    try {
      const res = await fetchImpl(dest.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
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
    if (status >= 200 && status < 300) {
      remove(picked);
      stats.sent += picked.length;
      stats.lastSentAt = now();
      stats.lastError = null;
      backoff = null;
      return 'sent';
    }
    if (status && status < 500 && !RETRY_STATUS.has(status)) {
      remove(picked);
      stats.dropped += picked.length;
      stats.lastError = `HTTP ${status}: batch of ${picked.length} refused and dropped`;
      stats.lastErrorAt = now();
      backoff = null;
      return 'dropped';
    }
    const failures = (backoff?.url === dest.url ? backoff.failures : 0) + 1;
    const wait = Math.min(BACKOFF_START_MS * 2 ** (failures - 1), BACKOFF_MAX_MS);
    backoff = { url: dest.url, failures, nextAt: now() + wait };
    stats.lastError = `${failure || `HTTP ${status}`}: retrying in ${Math.round(wait / 1000)}s`;
    stats.lastErrorAt = now();
    return 'retry';
  }

  async function flushOnce() {
    const dest = destination();
    if (dest.error) {
      if (warnedUrl !== dest.url) log(`[telemetry] not sending: ${ENDPOINT_ENV} or telemetry.url is not a valid endpoint (${dest.error})`);
      warnedUrl = dest.url;
      return;
    }
    warnedUrl = null;
    const dropped = trim();
    if (dropped) log(`[telemetry] dropped ${dropped} queued events past the cap or age limit`);
    for (let i = 0; i < BATCHES_PER_FLUSH; i += 1) {
      if (backoff && backoff.url === dest.url && now() < backoff.nextAt) break;
      const r = await sendBatch(dest);
      if (r === 'idle' || r === 'retry') break;
    }
    trim();
    changed();
  }

  // One flush at a time: a slow collector must not let the timer start a
  // second flush that sends the same batch again.
  function flush() {
    if (!flushing) flushing = flushOnce().finally(() => { flushing = null; });
    return flushing;
  }

  function flushSoon() {
    if (soonTimer || !interval) return;
    soonTimer = timers.setTimeout(() => { soonTimer = null; flush().catch((err) => log('[telemetry] flush failed', err)); }, FLUSH_SOON_MS);
    soonTimer.unref?.();
  }

  // Where events go and the send counters, for tests and debugging.
  function status() {
    const dest = destination();
    const st = state.sink;
    return {
      queued: state.queue.length,
      sink: {
        url: dest.url,
        source: dest.source,
        error: dest.error,
        builtin: builtinEndpoint,
        sent: st.sent || 0,
        dropped: st.dropped || 0,
        lastSentAt: st.lastSentAt ?? null,
        lastError: st.lastError ?? null,
        lastErrorAt: st.lastErrorAt ?? null,
      },
    };
  }

  return {
    install: () => state.install,
    on,
    emit,
    flush,
    saveNow,
    destination,

    // HMAC of `${kind}:${id}` under the install secret, cut to 16 hex: the
    // same local id always gives the same ref on this machine, and the ref
    // cannot be turned back into the id anywhere else.
    ref(kind, id) {
      if (typeof kind !== 'string' || !kind || id == null || id === '') throw new TypeError('telemetry.ref(kind, id): both are required');
      return crypto.createHmac('sha256', Buffer.from(state.secret, 'hex')).update(`${kind}:${id}`).digest('hex').slice(0, 16);
    },

    // `owner/name`, or 'none' for nothing. An owner outside REPO_OWNERS is
    // narrowed to 'other' at send, so the wire never carries one.
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


    status,

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
