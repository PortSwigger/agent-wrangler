// The telemetry vocabulary: what a manifest may declare under `telemetry` (the
// event catalogue it emits) and how a value is checked against a declared
// field type. A LEAF like the rest of server/extensions/**:
// the loader validates a manifest's declarations at load time with it, and
// server/telemetry.js checks every event with the same functions, so the two
// cannot disagree about what a type allows.
//
// There is deliberately no string type. Every type is a closed enum, a bounded
// number, a boolean, a version, a model id from the price catalogue, or a ref /
// repo value core makes itself, so free text (a prompt, a title, a path) has no
// type to travel in and an emitter bug fails at emit instead of leaking.

export const EVENT_NAME_RE = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*){0,3}$/;
export const FIELD_KEY_RE = /^[a-z][a-zA-Z0-9]{0,39}$/;
export const ENUM_VALUE_RE = /^[a-z0-9][a-z0-9._-]{0,39}$/;
export const REF_RE = /^[0-9a-f]{16}$/;
export const REPO_RE = /^[a-z0-9][a-z0-9_.-]{0,38}\/[a-z0-9_.][a-z0-9_.-]{0,99}$/;
export const VERSION_RE = /^\d{1,4}\.\d{1,4}\.\d{1,6}(-[0-9a-z.-]{1,20})?$/;

// A year and a day, as the collector bounds it: a card or a job can live for weeks.
export const MAX_MS = 366 * 24 * 60 * 60 * 1000;
export const MAX_USD = 10_000;
export const MAX_EVENTS = 100;
export const MAX_FIELDS = 40;
// Names an emitter may not use for a field: the envelope core stamps itself.
export const ENVELOPE_FIELDS = ['eventId', 'ts', 'type', 'v', 'install', 'awVersion', 'emitterVersion'];
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

const SIMPLE = new Set(['bool', 'ms', 'usd', 'ref', 'model', 'version']);

function isInt(n) {
  return Number.isSafeInteger(n);
}

function enumList(values, where) {
  if (!Array.isArray(values) || !values.length || values.length > 60) return `${where} must be a non-empty array of at most 60 values`;
  for (const v of values) {
    if (typeof v !== 'string' || !ENUM_VALUE_RE.test(v)) return `${where} value ${JSON.stringify(v)} must match ${ENUM_VALUE_RE}`;
  }
  if (new Set(values).size !== values.length) return `${where} has a duplicate value`;
  return null;
}

// A declared field type, in any of its written forms, to one canonical object:
//   'bool' | 'ms' | 'usd' | 'ref' | 'model' | 'version'
//   { int: [min, max] } | { enum: [...] } | { repo: true } | { list: { enum: [...] }, max }
// each optionally `{ ..., nullable: true }` (a simple type then as { type: 'ms', nullable: true }).
// Returns { type } or { error }.
export function normaliseFieldType(raw) {
  if (typeof raw === 'string') {
    return SIMPLE.has(raw) ? { type: { t: raw, nullable: false } } : { error: `unknown type ${JSON.stringify(raw)}` };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'must be a type name or a type object' };
  const nullable = raw.nullable === true;
  if (raw.nullable != null && typeof raw.nullable !== 'boolean') return { error: 'nullable must be a boolean' };
  const kinds = ['type', 'int', 'enum', 'repo', 'list'].filter((k) => raw[k] != null);
  if (kinds.length !== 1) return { error: 'must name exactly one of type, int, enum, repo or list' };
  const [kind] = kinds;
  const extra = Object.keys(raw).filter((k) => k !== kind && k !== 'nullable' && !(kind === 'list' && k === 'max'));
  if (extra.length) return { error: `unknown key ${JSON.stringify(extra[0])}` };
  if (kind === 'type') {
    return SIMPLE.has(raw.type) ? { type: { t: raw.type, nullable } } : { error: `unknown type ${JSON.stringify(raw.type)}` };
  }
  if (kind === 'int') {
    const r = raw.int;
    if (!Array.isArray(r) || r.length !== 2 || !isInt(r[0]) || !isInt(r[1]) || r[0] > r[1]) return { error: 'int must be [min, max] integers with min <= max' };
    return { type: { t: 'int', min: r[0], max: r[1], nullable } };
  }
  if (kind === 'enum') {
    const bad = enumList(raw.enum, 'enum');
    return bad ? { error: bad } : { type: { t: 'enum', values: [...raw.enum], nullable } };
  }
  if (kind === 'repo') {
    return raw.repo === true ? { type: { t: 'repo', nullable } } : { error: 'repo must be true' };
  }
  const of = raw.list;
  if (!of || typeof of !== 'object' || Array.isArray(of) || Object.keys(of).join() !== 'enum') return { error: 'list must be { enum: [...] }' };
  const bad = enumList(of.enum, 'list.enum');
  if (bad) return { error: bad };
  if (!isInt(raw.max) || raw.max < 1 || raw.max > 60) return { error: 'list needs max, an integer from 1 to 60' };
  return { type: { t: 'list', values: [...of.enum], max: raw.max, nullable } };
}

// One value against one canonical type. Returns null when it fits, otherwise
// why not. `isModel` says whether a string is a model id core knows.
export function checkValue(type, value, { isModel = () => false } = {}) {
  if (value === null) return type.nullable ? null : 'is null but not nullable';
  if (value === undefined) return 'is missing';
  switch (type.t) {
    case 'bool': return typeof value === 'boolean' ? null : 'must be a boolean';
    case 'ms': return isInt(value) && value >= 0 && value <= MAX_MS ? null : `must be an integer from 0 to ${MAX_MS}`;
    case 'usd': return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_USD && Math.round(value * 100) / 100 === value
      ? null : `must be a number from 0 to ${MAX_USD} with at most 2 decimal places`;
    case 'int': return isInt(value) && value >= type.min && value <= type.max ? null : `must be an integer from ${type.min} to ${type.max}`;
    case 'enum': return type.values.includes(value) ? null : `must be one of ${type.values.join(', ')}`;
    case 'ref': return typeof value === 'string' && REF_RE.test(value) ? null : 'must be a ref made by telemetry.ref()';
    case 'repo': return typeof value === 'string' && (value === 'other' || value === 'none' || REPO_RE.test(value)) ? null : 'must be a repo made by telemetry.repo()';
    case 'model': return typeof value === 'string' && (value === 'default' || value === 'other' || isModel(value)) ? null : 'must be a price-catalogue model id, default or other (use telemetry.model())';
    case 'version': return typeof value === 'string' && VERSION_RE.test(value) ? null : 'must be a version like 1.2.3';
    case 'list': {
      if (!Array.isArray(value) || value.length > type.max) return `must be an array of at most ${type.max} values`;
      const bad = value.find((v) => !type.values.includes(v));
      return bad === undefined ? null : `holds ${JSON.stringify(bad)}, not one of ${type.values.join(', ')}`;
    }
    default: return 'has an unknown type';
  }
}

// A manifest's `telemetry.events` to `{ [name]: { v, fields: { [key]: type } } }`,
// or { error }. Names are relative: core prefixes the emitter id on the wire.
export function normaliseCatalogue(events) {
  if (!events || typeof events !== 'object' || Array.isArray(events)) return { error: 'telemetry.events must be an object of event definitions' };
  const names = Object.keys(events);
  if (names.length > MAX_EVENTS) return { error: `telemetry.events declares more than ${MAX_EVENTS} events` };
  const out = {};
  for (const name of names) {
    if (!EVENT_NAME_RE.test(name)) return { error: `telemetry event name ${JSON.stringify(name)} must match ${EVENT_NAME_RE}` };
    const def = events[name];
    if (!def || typeof def !== 'object') return { error: `telemetry event ${name} must be { v, fields }` };
    if (!isInt(def.v) || def.v < 1 || def.v > 99) return { error: `telemetry event ${name} v must be an integer from 1 to 99` };
    if (!def.fields || typeof def.fields !== 'object' || Array.isArray(def.fields)) return { error: `telemetry event ${name} fields must be an object` };
    const keys = Object.keys(def.fields);
    if (keys.length > MAX_FIELDS) return { error: `telemetry event ${name} has more than ${MAX_FIELDS} fields` };
    const fields = {};
    for (const key of keys) {
      if (!FIELD_KEY_RE.test(key)) return { error: `telemetry event ${name} field ${JSON.stringify(key)} must match ${FIELD_KEY_RE}` };
      if (ENVELOPE_FIELDS.includes(key)) return { error: `telemetry event ${name} field ${key} is set by core on every event` };
      const r = normaliseFieldType(def.fields[key]);
      if (r.error) return { error: `telemetry event ${name} field ${key} ${r.error}` };
      fields[key] = r.type;
    }
    out[name] = { v: def.v, fields };
  }
  return { catalogue: out };
}

// The collector URL, built in or overridden: https, or http to this machine
// only (a local stub). No
// credentials, query or fragment, so nothing secret or variable rides in it.
export function checkEndpoint(raw) {
  if (typeof raw !== 'string' || raw.length > 500) return 'endpoint must be a URL string';
  let u;
  try { u = new URL(raw); } catch { return 'endpoint must be an absolute URL'; }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && LOOPBACK.has(u.hostname))) return 'endpoint must use https (http only to localhost)';
  if (u.username || u.password) return 'endpoint must not carry credentials';
  if (u.search || u.hash || raw.includes('?') || raw.includes('#')) return 'endpoint must not carry a query or fragment';
  return null;
}

// A manifest's whole `telemetry` block, checked against its `requires`.
// Returns { events } (null when absent) or { error }. Where events go is core's
// alone: there is no way for a manifest to name a destination.
export function normaliseTelemetryDecl(telemetry, requires = []) {
  if (telemetry == null) return { events: null };
  if (typeof telemetry !== 'object' || Array.isArray(telemetry)) return { error: 'telemetry must be an object' };
  if (telemetry.sinks != null) return { error: 'telemetry.sinks is not supported: core sends every event to its built-in collector' };
  const extra = Object.keys(telemetry).find((k) => k !== 'events');
  if (extra) return { error: `telemetry has unknown key ${JSON.stringify(extra)}` };
  if (telemetry.events == null) return { events: null };
  if (!requires.includes('telemetry:emit')) return { error: 'telemetry.events needs the telemetry:emit capability in requires' };
  const r = normaliseCatalogue(telemetry.events);
  return r.error ? { error: r.error } : { events: r.catalogue };
}

// Event data against its declared spec.
//   strict (emit): any undeclared key, missing key or ill-typed value throws.
//   lenient (send): undeclared keys are stripped; a missing or ill-typed
//   declared value drops the event (returns null).
export function checkEventData(spec, data, { strict = true, isModel, where = 'event' } = {}) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    if (strict) throw new TypeError(`${where}: data must be an object`);
    return null;
  }
  if (strict) {
    const extra = Object.keys(data).find((k) => !Object.hasOwn(spec.fields, k));
    if (extra) throw new TypeError(`${where}: field ${JSON.stringify(extra)} is not declared`);
  }
  const out = {};
  for (const [key, type] of Object.entries(spec.fields)) {
    const value = Object.hasOwn(data, key) ? data[key] : undefined;
    const bad = checkValue(type, value, { isModel });
    if (bad) {
      if (strict) throw new TypeError(`${where}: field ${key} ${bad}`);
      return null;
    }
    out[key] = Array.isArray(value) ? [...value] : value;
  }
  return out;
}
