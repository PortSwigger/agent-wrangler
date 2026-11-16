import { analyzeLines, usageSince } from '../transcript-reader.js';
import { diffFromText } from '../git-diff.js';
import { adapterFor } from '../agents/index.js';
import { logWarn } from '../log.js';

// A runtime's `location` (contract in server/runtimes/index.js and
// docs/extensions.md) runs its sessions somewhere core cannot see. Core never
// reads, writes or runs anything there: every fact about a location card comes
// back from one of the runtime's hooks, and this module is where each answer is
// size-capped and shape-checked before core uses it.

export const MAX_REF_BYTES = 16 * 1024;
export const MAX_CWD_LENGTH = 4096;
export const MAX_TRANSCRIPT_CHARS = 64 * 1024 * 1024;
export const MAX_DIFF_CHARS = 8 * 1024 * 1024;
export const MAX_DIFF_META_LENGTH = 4096;
const CODEX_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function hasLocation(rt) {
  return Boolean(rt?.location);
}

export function atLocation(entry) {
  return entry?.location !== undefined;
}

export function sameLocation(a, b) {
  return atLocation(a) && atLocation(b) && a.runtime === b.runtime
    && JSON.stringify(a.location) === JSON.stringify(b.location);
}

const warned = new Set();
function warnOnce(key, message) {
  if (warned.has(key)) return;
  warned.add(key);
  logWarn(`[location] ${message}`);
}

function label(rt) {
  return rt?.label || rt?.id || 'location';
}

// The stored form of what `provision` returned: a JSON round-trip, so the card
// holds exactly what mappings.json will.
export function checkRef(ref, rt) {
  let json;
  try { json = ref === undefined ? undefined : JSON.stringify(ref); } catch { json = undefined; }
  if (json === undefined || ref === null) throw new Error(`The "${label(rt)}" runtime's location.provision returned no JSON-able ref.`);
  if (Buffer.byteLength(json) > MAX_REF_BYTES) throw new Error(`The "${label(rt)}" runtime's location ref is larger than ${MAX_REF_BYTES} bytes.`);
  return JSON.parse(json);
}

function checkCwd(cwd, rt) {
  if (typeof cwd !== 'string' || !cwd.startsWith('/') || cwd.length > MAX_CWD_LENGTH || /[\0\n\r]/.test(cwd)) {
    throw new Error(`The "${label(rt)}" runtime's location.open returned an unusable cwd.`);
  }
  return cwd;
}

// Readies the location for a launch ('dispatch', 'resume' or 'fork'), or for
// the card's grown `entry.repos` ('repos'). Its answer may name the folder the
// agent starts in there.
export async function openLocation(rt, entry, phase) {
  if (typeof rt.location.open !== 'function') return {};
  let out;
  try {
    out = await rt.location.open({ ref: entry.location, entry, phase });
  } catch (err) {
    throw new Error(`The "${label(rt)}" runtime could not open this session's location: ${err?.message || err}`);
  }
  if (out == null) return {};
  if (typeof out !== 'object') throw new Error(`The "${label(rt)}" runtime's location.open must return an object or nothing.`);
  return out.cwd == null ? {} : { cwd: checkCwd(out.cwd, rt) };
}

// The idle-suspend threshold in ms for a card on `rt`: its location's own
// `suspendIdleHours` when it gives one, else `fallbackMs`. Null turns it off.
export function locationIdleMs(rt, entry, fallbackMs) {
  const own = rt?.location?.suspendIdleHours;
  if (own == null) return fallbackMs;
  let hours;
  try { hours = typeof own === 'function' ? own({ ref: entry?.location, entry }) : own; } catch { return fallbackMs; }
  if (hours === 0) return null;
  return typeof hours === 'number' && Number.isFinite(hours) && hours > 0 ? hours * 60 * 60 * 1000 : fallbackMs;
}

export function checkTranscript(text, rt) {
  if (text == null) return null;
  if (typeof text !== 'string') {
    warnOnce(`transcript-shape:${rt?.id}`, `${label(rt)} location.transcript answered with a ${typeof text}, not a string; ignored`);
    return null;
  }
  if (text.length > MAX_TRANSCRIPT_CHARS) {
    warnOnce(`transcript-size:${rt?.id}`, `${label(rt)} location.transcript answered with ${text.length} characters, over the ${MAX_TRANSCRIPT_CHARS} cap; ignored`);
    return null;
  }
  return text;
}

export async function locationTranscript(rt, entry, liveSid) {
  if (typeof rt?.location?.transcript !== 'function' || !atLocation(entry)) return null;
  let text;
  try { text = await rt.location.transcript({ ref: entry.location, entry, liveSid: liveSid || null }); } catch { return null; }
  return checkTranscript(text, rt);
}

// Cost, activity and title from a Claude transcript the runtime hands over. A
// Codex card's comes from the runtime's own `analyze`.
export async function analyzeAtLocation(rt, entry, liveSid) {
  if (!adapterFor(entry?.agent ?? 'claude').presetsSessionId) return null;
  const text = await locationTranscript(rt, entry, liveSid);
  if (text == null) return null;
  return analyzeLines(text.split('\n').filter(Boolean), { since: usageSince(entry) });
}

// A location runtime's graph reads. Both are always defined, so the graph
// never falls back to reading host files that name a different machine's paths.
// A suspended card answers with the values recorded when it was suspended.
export function withLocationReads(rt) {
  if (!hasLocation(rt)) return rt;
  return {
    ...rt,
    readLive: async (args) => (rt.readLive ? rt.readLive(args) : null),
    analyze: async (args) => {
      const recorded = args?.entry?.suspendedAt ? args.entry.suspendedCard : null;
      if (recorded) return recorded;
      if (rt.analyze) return rt.analyze(args);
      return analyzeAtLocation(rt, args?.entry, args?.liveSid);
    },
  };
}

export function checkCodexId(id, excludeIds, rt) {
  if (id == null || id === '') return null;
  if (typeof id !== 'string' || !CODEX_ID.test(id)) {
    warnOnce(`codex-id:${rt?.id}`, `${label(rt)} location.codexId answered with something that is not a conversation id; ignored`);
    return null;
  }
  return excludeIds?.has(id) ? null : id;
}

export async function locationCodexId(rt, entry, { since = 0, excludeIds = new Set() } = {}) {
  if (typeof rt?.location?.codexId !== 'function' || !atLocation(entry)) return null;
  let id;
  try { id = await rt.location.codexId({ ref: entry.location, entry, since, excludeIds: [...excludeIds] }); } catch { return null; }
  return checkCodexId(id, excludeIds, rt);
}

function shortMeta(v) {
  return typeof v === 'string' && v && v.length <= MAX_DIFF_META_LENGTH && !/[\0\n\r]/.test(v) ? v : undefined;
}

// The diff panel's reply for what location.diff answered: null is "no repo", a
// diff over MAX_DIFF_CHARS is cut at a line and the rest counted as dropped.
export function checkDiff(out, { lineCap } = {}) {
  if (out == null) return { state: 'not-a-repo' };
  if (typeof out !== 'object' || typeof out.diff !== 'string') {
    return { state: 'error', error: 'The runtime answered with a malformed diff.' };
  }
  let text = out.diff;
  let cutLines = 0;
  if (text.length > MAX_DIFF_CHARS) {
    const at = text.lastIndexOf('\n', MAX_DIFF_CHARS);
    const keep = at > 0 ? at + 1 : MAX_DIFF_CHARS;
    cutLines = text.slice(keep).split('\n').filter(Boolean).length;
    text = text.slice(0, keep);
  }
  const result = diffFromText(text, { lineCap });
  if (cutLines) {
    result.truncated = { droppedLines: (result.truncated?.droppedLines || 0) + cutLines, droppedFiles: result.truncated?.droppedFiles || 0 };
  }
  const baseRef = shortMeta(out.baseRef);
  const dir = shortMeta(out.dir);
  return { ...result, ...(baseRef ? { baseRef } : {}), ...(dir ? { location: { dir } } : {}) };
}

export async function locationDiff(rt, entry, mode, opts) {
  if (typeof rt?.location?.diff !== 'function') {
    return { state: 'error', error: `The "${label(rt)}" runtime does not show diffs of its sessions.` };
  }
  let out;
  try {
    out = await rt.location.diff({ ref: entry.location, entry, mode });
  } catch (err) {
    return { state: 'error', error: `The "${label(rt)}" runtime could not read this session's diff: ${err?.message || err}` };
  }
  return checkDiff(out, opts);
}
