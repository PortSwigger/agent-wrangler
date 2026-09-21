import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../data-dir.js';
import { writeJsonAtomic, readJsonOrLoud } from '../atomic-json.js';

// Where an INSTALLED ("external") extension came from, kept deliberately OUTSIDE
// config.json: config.json owns the `extensions.<id>` enable/disable flags, which
// a human edits by hand, while this file is machine-written install metadata whose
// only readers are the installer and the update check. Mixing them would put a
// hand-edited file in the path of an atomic whole-file rewrite on every install.
//
// A record is `{ id, originUrl, sha, installedAt, requires, dependencies }`, and
// the last two are the whole point of persisting anything: `requires` is the
// CONSENTED capability set (a later version's `requires` is diffed against it to
// decide whether the human must consent again), and `dependencies` is the
// flattened `name@version` list taken from the extension's package-lock.json at
// consent time, so an update can show what changed underneath it. Neither is
// recoverable from the installed tree — the tree is whatever the new version
// ships, so without the record an update has nothing to diff against.
//
// This module is a LEAF (see index.js's header): fs/path plus the two state-file
// leaves, nothing else. It also does no logging — callers own the event lines, and
// nothing here runs per-tick anyway.

// The same id shape the manifest validator enforces. Exported because install.js
// checks a third-party manifest's id before it builds any path from it, and two
// copies of this regex would be two chances to disagree about what a safe
// filesystem segment is.
export const ID_RE = /^[a-z][a-z0-9-]*$/;

export const isValidExtensionId = (id) => typeof id === 'string' && ID_RE.test(id);

// Computed per call, never frozen into a module const: test-setup.js redirects
// AW_DATA_DIR, and schedule-store's module-level path only gets away with it
// because data-dir.js is imported after that redirect in every test process.
// Recomputing costs one path.join and removes the ordering dependency entirely.
export const externalDir = () => path.join(DATA_DIR, 'extensions');

// Install staging: a download is unpacked, validated and `npm ci`'d here and only
// then renamed into place, so a failed or malicious install never leaves a
// half-populated `extensions/<id>/` for the boot loader to find. Dot-prefixed so
// it can live inside externalDir() (one filesystem, so the rename is atomic)
// without the loader mistaking it for an extension — no id may start with `.`.
export const tmpDir = () => path.join(externalDir(), '.tmp');

const provenanceFile = () => path.join(DATA_DIR, 'extensions.json');

// `{ [id]: record }`, `{}` for a missing or corrupt file. readJsonOrLoud already
// owns the corrupt-file backup (and the loud line), so don't re-implement it here;
// a non-object parse (a hand-edited `[]` or `null`) is treated the same as absent,
// since "no provenance" is a legitimate state — a hand-dropped extension directory
// has none and must still load.
export function readProvenance() {
  const raw = readJsonOrLoud(provenanceFile(), 'extensions.json');
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  // Per-ENTRY tolerance, not all-or-nothing: one hand-mangled record must not cost
  // every other installed extension its update-diff baseline (the same
  // quarantine-one-not-all shape the builtin loader uses).
  for (const [id, rec] of Object.entries(raw)) {
    if (isValidExtensionId(id) && rec && typeof rec === 'object' && !Array.isArray(rec)) out[id] = normalise(id, rec);
  }
  return out;
}

export function recordFor(id) {
  if (!isValidExtensionId(id)) return null;
  return readProvenance()[id] ?? null;
}

// Plain read-modify-write, NOT the synchronous-mutator shape mailbox-store and
// schedule-store use. Those stores have several independent in-process writers
// (send, drain, sweeper, eviction) and an `await` between a read and its write is
// where two of them clobber each other; this file is only ever written by the
// install handler, which serialises installs behind an in-memory one-at-a-time
// lock — so there is no second writer to race, and the atomic rename is enough.
export function putRecord(record) {
  const id = record?.id;
  // Refused rather than coerced: the id arrives from a third-party manifest and is
  // used to build `extensions/<id>/`, so anything but a single safe path segment
  // must fail the install loudly instead of writing a record that later resolves
  // somewhere unintended.
  if (!isValidExtensionId(id)) throw new Error(`Extension id must match ${ID_RE} (got ${JSON.stringify(id)})`);
  const all = readProvenance();
  all[id] = normalise(id, record);
  writeJsonAtomic(provenanceFile(), all, { trailingNewline: true });
  return all[id];
}

export function removeRecord(id) {
  if (!isValidExtensionId(id)) return false;
  const all = readProvenance();
  if (!(id in all)) return false;
  delete all[id];
  writeJsonAtomic(provenanceFile(), all, { trailingNewline: true });
  return true;
}

// Fixed shape on the way in AND on the way out, so a reader never has to guard
// `requires`/`dependencies` before diffing them — a missing or non-array value
// reads as an empty consent/dependency set, which is the conservative direction
// (it makes an update look like it ADDS capabilities, prompting re-consent, rather
// than silently inheriting one that was never recorded).
function normalise(id, rec) {
  const strings = (v) => (Array.isArray(v) ? v.filter((s) => typeof s === 'string') : []);
  return {
    id,
    originUrl: typeof rec.originUrl === 'string' ? rec.originUrl : null,
    sha: typeof rec.sha === 'string' ? rec.sha : null,
    installedAt: typeof rec.installedAt === 'string' ? rec.installedAt : null,
    requires: strings(rec.requires),
    dependencies: strings(rec.dependencies),
  };
}

// Convenience for the installer's staging step; kept here because the two paths
// above are this module's, and a caller building them by hand would be a third
// place that has to know `.tmp` lives inside externalDir().
export function ensureDirs() {
  fs.mkdirSync(tmpDir(), { recursive: true });
}
