import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { externalDir, readProvenance } from './provenance.js';

// Discovery of INSTALLED ("external") extensions: one immediate subdirectory of
// <DATA_DIR>/extensions/ per extension, each with an index.js default-exporting
// a manifest. DATA_DIR-relative on purpose — a run-dev isolated instance (fresh
// AW_DATA_DIR) starts with no installed extensions the same way it starts with
// no sessions, and server/test-setup.js redirects AW_DATA_DIR so the tests
// inherit that isolation for free.
//
// NOTHING here throws. Every failure becomes a `quarantine` reason carried on
// the returned entry, which loadExtensions turns into a settings row that
// contributes nothing — see its failure-posture comment. A directory that can
// only be half-understood must not take the board down with it.
//
// Stays a LEAF: node:fs / node:path / node:url and the provenance leaf only.

// A static import of these breaks BOOT FOR THE WHOLE SERVER, not just one
// extension: server/extensions/** is imported by mcp/client-config.js and
// agent-skills.js, which the agent adapters import, so reaching back into
// session-manager / state-reader / tmux-scraper / the server entry / host-api/
// closes a real module cycle and nothing comes up at all. That is a far worse
// failure than one broken extension, which is the entire reason this scan
// exists.
//
// It is a CORRECTNESS rule, NOT a security one, and it is trivially bypassed by
// `await import(...)` at run time. Nothing here is trying to stop hostile code:
// an extension runs in-process with full access to the machine (see the trust
// framing in the spec), so there is no boundary to enforce. It catches the
// honest mistake.
//
// Shared with index.test.js, which asserts the same list over the in-repo
// manifests — one array so the runtime scanner and the test cannot drift.
export const FORBIDDEN_IMPORTS = [
  /\/(session-manager|state-reader|tmux-scraper)\.js['"]/,
  /from\s+['"](\.\.\/)+index\.js['"]/,
  /\/host-api\//,
];

const MAX_SCAN_BYTES = 2 * 1024 * 1024;

// Every .js directly under `dir` or in its subdirectories, excluding
// node_modules — an extension's dependencies are third-party packages that
// legitimately contain anything, and they are not what this rule is about (they
// cannot be static-imported by the server's own graph, only by the manifest).
function ownJsFiles(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) ownJsFiles(full, out);
    else if (e.isFile() && e.name.endsWith('.js')) out.push(full);
  }
  return out;
}

function importViolation(dir) {
  for (const file of ownJsFiles(dir)) {
    let body;
    try {
      // Bounded: a generated or bundled file can be megabytes, and this runs at
      // boot for every installed extension.
      if (fs.statSync(file).size > MAX_SCAN_BYTES) continue;
      body = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const line of body.split('\n')) {
      if (/^\s*import\b/.test(line) && FORBIDDEN_IMPORTS.some((re) => re.test(line))) {
        return `${path.relative(dir, file)} statically imports a server core module (${line.trim()})`;
      }
    }
  }
  return null;
}

// Capabilities the manifest now asks for that its recorded consent does not
// cover. Checked HERE rather than at install time as well, because a manifest
// can widen `requires` in place on disk after consent — editing the file is all
// it takes — and an extension must never silently gain a capability a human
// never approved. A narrowed or unchanged set proceeds on the recorded consent.
//
// An extension with NO provenance record (a hand-dropped directory, a legitimate
// dev workflow) has nothing to compare against and is not gated: it was placed
// there by hand, which is its own consent.
export function unconsentedCapabilities(requires, record) {
  if (!record || !Array.isArray(record.requires)) return [];
  const consented = new Set(record.requires);
  return [...new Set(requires.filter((c) => !consented.has(c)))];
}

export async function discoverExternal({ dir = externalDir(), provenance = readProvenance(), importer = (url) => import(url) } = {}) {
  let names;
  try {
    names = fs.readdirSync(dir, { withFileTypes: true })
      // The dot-prefix skip is what excludes the install staging dir
      // (<DATA_DIR>/extensions/.tmp/), so a half-finished clone is never
      // discovered as an extension.
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort();
  } catch {
    return []; // no extensions dir yet — the ordinary state of a fresh install
  }
  const out = [];
  for (const name of names) {
    const extDir = path.join(dir, name);
    // Keyed on the DIRECTORY name, not the manifest's id: a manifest that
    // cannot be read still has to produce a row, and the directory is the only
    // name available then. `provenance: null` is what marks an entry as
    // not-updatable (there is no originUrl to re-clone).
    const base = { id: name, dir: extDir, external: true, provenance: provenance?.[name] ?? null };
    const violation = importViolation(extDir);
    if (violation) { out.push({ ...base, quarantine: violation }); continue; }
    let manifest;
    try {
      // Cache-busted by nothing: this runs once per boot, and newly installed
      // code deliberately only loads at the next server start (the same
      // restart semantics an enabled-but-not-boot-enabled builtin has).
      const mod = await importer(pathToFileURL(path.join(extDir, 'index.js')).href);
      manifest = mod?.default;
    } catch (err) {
      out.push({ ...base, quarantine: `could not load index.js (${err?.message || err})` });
      continue;
    }
    if (!manifest || typeof manifest !== 'object') {
      out.push({ ...base, quarantine: 'index.js has no default-exported manifest object' });
      continue;
    }
    // EXTERNAL ONLY: the id and the directory name must agree, or the on-disk
    // layout lies about what is installed — the provenance record, the
    // /ext/<id>/ asset route and the uninstall path are all keyed on one of the
    // two, and a mismatch makes them disagree silently.
    if (manifest.id !== name) {
      out.push({ ...base, quarantine: `manifest id "${String(manifest.id)}" does not match its directory name "${name}"` });
      continue;
    }
    const widened = unconsentedCapabilities([...(manifest.requires || [])], base.provenance);
    if (widened.length) {
      out.push({ ...base, quarantine: `widened-and-unconsented requires (${widened.join(', ')}) — reinstall to re-consent` });
      continue;
    }
    // `dir` is overwritten AFTER the manifest spread: a manifest exports its own
    // `dir` from import.meta.url, and for an installed one the discovered path
    // is the authority (validateManifest resolves `client`/`styles` under it).
    out.push({ ...manifest, ...base });
  }
  return out;
}
