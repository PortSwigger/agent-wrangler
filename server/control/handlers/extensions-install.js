import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { validateManifest } from '../../extensions/index.js';
import { externalDir, tmpDir, ensureDirs, isValidExtensionId, readProvenance, recordFor, putRecord, removeRecord } from '../../extensions/provenance.js';
import { unconsentedCapabilities, admitExternal, importViolation } from '../../extensions/external.js';
import { assertAllowedUrl, cloneTo, readHead, lockDependencies, npmCi, lsRemoteHead, readDeclaration, MissingLockfileError, MissingDeclarationError } from '../../extensions/install.js';
import { log } from '../../log.js';

// Installing an external extension, in two frames with a human decision between
// them: `ext-install` clones and DISCLOSES (nothing is installed, no registry is
// contacted), `ext-consent` either completes or throws the staging dir away.
// `ext-uninstall` is the third.
//
// THE TRUST FRAMING, because every message this handler produces has to carry
// it: an extension runs IN-PROCESS WITH FULL ACCESS TO THE USER'S MACHINE. The
// `requires` capability list is disclosure and accident-containment, never a
// security boundary; the browser half is trusted exactly as much as the server
// half. Installing one is as much trust as `npm install`-ing a package into the
// server. Nothing here sandboxes anything, and no copy anywhere may imply it
// does.
//
// WHEN EACH OF THESE TAKES EFFECT, because the three differ and the copy has to
// say so. A FRESH install registers and activates in this process: the row, its
// tools, handlers, stores and client asset are all live before the reply lands.
// An UPDATE — any id already carrying a row — deliberately keeps RESTART
// semantics: Node cannot unload the old module, so activating the new one would
// run two versions of one extension at once, which is worse than waiting.
// UNINSTALL deactivates and deregisters immediately but still asks for a restart
// to reclaim, for the same reason in reverse. The one lag common to all three is
// an ALREADY-RUNNING agent's MCP tools, whose `--allowedTools` is baked into its
// launch argv and only changes at its next resume.

// ONE install at a time per instance, refused rather than queued: two clones
// racing into the same staging root, or two `npm ci` runs against one tree, has
// no sensible outcome and a human who pressed the button twice wants to be told,
// not silently made to wait. In-memory is right — a restart cancels nothing
// meaningful, because an interrupted install leaves only a staging dir, which
// boot sweeps (server/extensions/external.js sweepStaging).
// `busy` is `{ url, since, tempId, awaitingConsent }` while an install is in
// flight. The lock is HELD across the human's decision on purpose — the staging
// dir is what a second install would collide with — but "the human decided" is
// not the only way a disclosure ends: closing the modal, reloading the board or
// losing the socket leaves nothing to answer with, and the handler never learns
// about any of them. So a disclosure awaiting consent is RECLAIMABLE after
// PENDING_CONSENT_TTL_MS: the next install sweeps that staging dir and takes the
// lock. Without it one abandoned modal wedged every install on the instance
// until a restart, which is a real dead end rather than the "a restart cancels
// nothing meaningful" the in-memory lock is justified by.
//
// Reclaim is gated on `awaitingConsent`, never on age alone: a clone or an
// `npm ci` is genuinely slow and is already bounded by its own execFile timeout,
// so a running install must keep refusing however long it has taken.
const PENDING_CONSENT_TTL_MS = 10 * 60 * 1000;
let busy = null;
// Staged clones this process has disclosed but not yet resolved, keyed on the
// opaque tempId the client echoes back. In memory for the same reason as the
// lock: the only durable artefact is the staging dir, and a restart having
// forgotten a pending consent is correct — the human re-runs the install.
const pending = new Map();

// The subprocess runners, injectable so the tests drive the whole install path
// with no process and no network. Deliberately a MODULE seam and never an option
// on the incoming frame: a control frame is browser-supplied, so a `_clone` a
// client could set would be arbitrary code execution offered as an API.
const REAL_RUNNERS = { clone: cloneTo, head: readHead, npm: npmCi, lsRemote: lsRemoteHead };
let runners = REAL_RUNNERS;

export function _setInstallRunnersForTests(next = null) {
  runners = next ? { ...REAL_RUNNERS, ...next } : REAL_RUNNERS;
}

export const _PENDING_CONSENT_TTL_MS = PENDING_CONSENT_TTL_MS;

// Backdates the pending disclosure past its TTL, so the reclaim path is tested
// without a fake clock or a ten-minute wait.
export function _agePendingConsentForTests() {
  if (busy) busy.since = Date.now() - PENDING_CONSENT_TTL_MS - 1;
}

export function _resetInstallLockForTests() {
  busy = null;
  pending.clear();
}

// Every computed path is resolved and asserted to stay under
// <DATA_DIR>/extensions/ before any write or delete, because the `id` comes
// from a third-party MANIFEST. `isValidExtensionId` already rejects a separator
// outright; this is the second, structural check, since a single missed id
// validation on a delete path is a wipe of an arbitrary directory.
function safeExtPath(id) {
  if (!isValidExtensionId(id)) throw new Error(`Refusing extension id ${JSON.stringify(id)} — must match /^[a-z][a-z0-9-]*$/`);
  const root = path.resolve(externalDir());
  const resolved = path.resolve(root, id);
  if (path.dirname(resolved) !== root) throw new Error(`Refusing extension path outside ${root}`);
  return resolved;
}

function safeStagingPath(tempId) {
  if (!/^[0-9a-f]{16}$/.test(String(tempId || ''))) throw new Error('Unknown staging id');
  const root = path.resolve(tmpDir());
  const resolved = path.resolve(root, tempId);
  if (path.dirname(resolved) !== root) throw new Error('Unknown staging id');
  return resolved;
}

function rmQuiet(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* nothing left to do about it */ }
}

function reclaimable(lock) {
  return Boolean(lock.awaitingConsent) && Date.now() - lock.since > PENDING_CONSENT_TTL_MS;
}

// Abandoning a disclosure leaves exactly one artefact — the staging dir — so
// reclaiming is removing it and dropping the pending entry. Deliberately silent:
// nobody asked for this install any more, and it is not a state change a human
// would ask about afterwards (server/log.js is event-only).
function reclaim(lock) {
  const staged = lock.tempId ? pending.get(lock.tempId) : null;
  if (staged) rmQuiet(staged.dir);
  if (lock.tempId) pending.delete(lock.tempId);
  busy = null;
}

// Progress is BROADCAST (the modal may be open in more than one tab, and the
// board's own state changes underneath it) and the terminal phase is ALSO
// replied, so the modal never depends solely on a broadcast it might have
// missed. Routed through ctx.broadcast, which is sendGuarded-backed like every
// other broadcast.
function progress(ctx, phase, extra = {}) {
  ctx.broadcast?.({ type: 'ext-install-progress', phase, ...extra });
}

// Only what the consent modal shows, and it comes from the clone's STATIC
// declaration (readDeclaration) rather than an imported manifest — see that
// function for why nothing here may execute the extension's code. Third-party
// data throughout; every field is rendered via textContent.
function discloseDeclared(declared) {
  return {
    id: declared.id,
    label: declared.label,
    description: declared.description,
    author: declared.author,
    homepage: declared.homepage,
    capabilities: [...declared.requires],
  };
}

// An UPDATE's decision is its diff, not its full lists — a transitive tree can
// churn by hundreds of entries, which is noise a human cannot read. So:
// capabilities in full (there are at most 17 and each one matters), dependencies
// as the DIRECT changes plus a count of the transitive churn.
//
// `reconsentNeeded` is the gate, and it is only `requires` WIDENING. Unchanged
// or narrowed proceeds on the recorded consent, because nothing new is being
// asked for. (external.js re-checks the same thing at every boot, which is what
// catches a manifest that widens itself in place on disk after consent.)
function updateDiff(record, declared, deps) {
  const priorAll = new Set(record.dependencies || []);
  const nextAll = new Set(deps.all);
  const addedCapabilities = unconsentedCapabilities([...declared.requires], record);
  const removedCapabilities = (record.requires || []).filter((c) => !declared.requires.includes(c));
  const addedDeps = deps.all.filter((d) => !priorAll.has(d));
  const removedDeps = (record.dependencies || []).filter((d) => !nextAll.has(d));
  const nameOf = (s) => s.slice(0, s.lastIndexOf('@'));
  const nextNames = new Set(deps.all.map(nameOf));
  // ADDED entries are filtered to the new version's DIRECT dependencies, which
  // is the set the manifest itself names. REMOVED cannot be filtered the same
  // way — the provenance record stores a flat list with no direct/transitive
  // mark, and adding one would only help installs made from now on — so a
  // removal is listed when the package NAME has left the tree entirely (a
  // dependency genuinely dropped, which is the thing worth reading) and is
  // otherwise just the old half of a version bump the added side already shows.
  return {
    update: true,
    priorSha: record.sha || '',
    addedCapabilities,
    removedCapabilities,
    addedDependencies: addedDeps.filter((d) => deps.direct.includes(d)),
    removedDependencies: removedDeps.filter((d) => !nextNames.has(nameOf(d))),
    addedCount: addedDeps.length,
    removedCount: removedDeps.length,
    reconsentNeeded: addedCapabilities.length > 0,
  };
}

// Loaded ONLY after consent and `npm ci`, which is the first moment the
// manifest's own imports resolve and the first moment running its code is
// something the human has agreed to. `declared` is what they agreed to, so the
// manifest is held to it: a different id would install into a directory the
// disclosure never named, and a wider `requires` would take capabilities that
// were never on screen. Either fails the install rather than quarantining after
// the fact — nothing is on disk yet, so refusing is free.
function assertManifestMatchesDeclaration(manifest, declared) {
  if (manifest.id !== declared.id) {
    throw new Error(`The extension's index.js declares id "${manifest.id}" but its package.json disclosed "${declared.id}" — refusing to install a manifest that does not match what was consented to.`);
  }
  const consented = new Set(declared.requires);
  const extra = [...new Set((manifest.requires || []).filter((c) => !consented.has(c)))];
  if (extra.length) {
    throw new Error(`The extension's index.js requires ${extra.join(', ')}, which its package.json did not disclose — refusing to install capabilities that were never consented to.`);
  }
}

// The fresh-install half: import what was just placed on disk and bring it up in
// this process. Deliberately re-runs the checks BOOT would have run rather than
// trusting the staged manifest — `importViolation` before the import (a static
// import of a server core module cycles the adapters through the server, and
// after the import it is already too late) and `admitExternal` after it, so an
// install can never admit something the next boot would quarantine.
//
// ROLLS BACK COMPLETELY on any failure: the registry, the directory and the
// provenance record all go, so a manifest whose store factory throws leaves the
// board exactly as it was. Rethrows into the caller's failure path, which
// reports it and releases the lock.
async function goLive(ctx, id, dest) {
  let registered = false;
  try {
    const violation = importViolation(dest);
    if (violation) throw new Error(`Refusing to load it: ${violation}`);
    // Cache-busted: a reinstall of the same id AFTER an uninstall would
    // otherwise get the module already in this process's ESM cache, which is
    // the version that was just deleted from disk.
    const mod = await import(`${pathToFileURL(path.join(dest, 'index.js')).href}?t=${Date.now()}`);
    const admitted = admitExternal(mod?.default, { id, dir: dest, external: true, provenance: recordFor(id) });
    if (!admitted.ok) throw new Error(admitted.quarantine);
    const entry = ctx.ext.register(admitted.entry);
    registered = true;
    // An extension config says is OFF is registered and inactive — the same end
    // state a restart would reach, and what the toggle then turns on.
    if (entry.enabled) ctx.ext.activate(id);
    ctx.ext.changed();
    return entry;
  } catch (err) {
    if (registered) {
      ctx.ext.unregister(id, { remove: true });
      ctx.ext.changed();
    }
    rmQuiet(dest);
    removeRecord(id);
    throw err;
  }
}

async function loadStagedManifest(dir) {
  // A cache-busting query is what makes a re-clone of the SAME path (an update,
  // or a second attempt after a failure) read the new file rather than the
  // module already in this process's ESM cache.
  const url = `${pathToFileURL(path.join(dir, 'index.js')).href}?t=${Date.now()}`;
  let manifest;
  try {
    manifest = (await import(url))?.default;
  } catch (err) {
    throw new Error(`Could not load the extension's index.js: ${err?.message || err}`);
  }
  if (!manifest || typeof manifest !== 'object') throw new Error("The repository's index.js has no default-exported manifest object");
  // Validated against the STAGING dir, so a `client`/`styles` path is checked
  // where the files actually are; validateManifest resolves them under `dir`.
  validateManifest({ ...manifest, dir });
  return manifest;
}

export const extInstallHandler = {
  type: 'ext-install',
  async handler(msg, ctx) {
    if (busy && !reclaimable(busy)) {
      throw new Error(`An extension install is already running (${busy.url}). Wait for it to finish and try again.`);
    }
    if (busy) reclaim(busy);
    const url = assertAllowedUrl(String(msg.url || '').trim());
    busy = { url, since: Date.now(), tempId: null, awaitingConsent: false };
    const tempId = crypto.randomBytes(8).toString('hex');
    busy.tempId = tempId;
    const dir = safeStagingPath(tempId);
    try {
      ensureDirs();
      progress(ctx, 'cloning', { url });
      await runners.clone(url, dir);
      progress(ctx, 'resolving');
      // Static read — the manifest module is NOT imported until after consent.
      let declared;
      try {
        declared = readDeclaration(dir);
      } catch (err) {
        if (err instanceof MissingDeclarationError) throw new Error('This repository declares no "wranglerExtension" block in its package.json. An external extension must declare its id, label and requires there so they can be shown to you without running any of its code.');
        throw err;
      }
      const sha = await runners.head(dir);
      // Refused BEFORE consent and before any registry fetch: an extension
      // whose dependency set is unpinned cannot be disclosed honestly, so there
      // is nothing to consent to.
      let deps;
      try {
        deps = lockDependencies(dir);
      } catch (err) {
        if (err instanceof MissingLockfileError) throw new Error('This repository ships no package-lock.json. An extension without a lockfile is not installable — its dependency set would be unpinned and unreviewable.');
        throw err;
      }
      const existing = recordFor(declared.id);
      const reply = {
        type: 'ext-install-disclosure',
        tempId,
        sha,
        ...discloseDeclared(declared),
        dependencies: deps.direct,
        dependencyCount: deps.all.length,
        ...(existing ? updateDiff(existing, declared, deps) : { update: false, reconsentNeeded: true }),
      };
      pending.set(tempId, { url, sha, declared, deps, dir });
      busy.awaitingConsent = true;
      busy.since = Date.now();
      // The lock is HELD across the human's decision, deliberately: the staging
      // dir is what a second install would collide with, and it lives until
      // consent resolves. Released by ext-consent, or by the failure path here.
      progress(ctx, 'disclosed', { id: declared.id });
      ctx.reply(reply);
    } catch (err) {
      rmQuiet(dir);
      pending.delete(tempId);
      busy = null;
      progress(ctx, 'failed', { message: String(err?.message || err) });
      throw err;
    }
  },
};

export const extConsentHandler = {
  type: 'ext-consent',
  async handler(msg, ctx) {
    const staged = pending.get(msg.tempId);
    if (!staged) throw new Error('That install is no longer pending — start it again.');
    pending.delete(msg.tempId);
    const { url, sha, declared, deps, dir } = staged;
    try {
      if (!msg.approve) {
        rmQuiet(dir);
        progress(ctx, 'cancelled', { id: declared.id });
        ctx.reply({ type: 'ext-install-done', id: declared.id, installed: false, cancelled: true });
        return;
      }
      progress(ctx, 'installing', { id: declared.id });
      await runners.npm(dir);
      // First point at which the manifest's imports resolve, and the first at
      // which running its code is consented to — so this is where the real
      // manifest is validated and held to what was disclosed.
      const manifest = await loadStagedManifest(dir);
      assertManifestMatchesDeclaration(manifest, declared);
      const dest = safeExtPath(manifest.id);
      // Anything with a row already — an update, a reinstall over a live
      // install, or a fix-by-reinstall of a QUARANTINED one — takes the restart
      // path. Read BEFORE the rename, though nothing here can change it.
      const registered = ctx.ext.list.some((e) => e.id === manifest.id);
      // Replacing an existing install (an update) is a remove-then-rename
      // rather than a merge: a stale file from the previous version left in
      // place is a version nobody shipped. On the update path the live code
      // keeps running from the process's module cache until restart regardless.
      rmQuiet(dest);
      fs.renameSync(dir, dest);
      putRecord({
        id: manifest.id,
        originUrl: url,
        sha,
        installedAt: new Date().toISOString(),
        // The CONSENTED set — the DISCLOSED list, not the manifest's, because
        // that is what the human saw and approved. The two are asserted equal
        // or narrower above, and external.js re-checks the on-disk manifest
        // against this record at every boot.
        requires: [...declared.requires],
        dependencies: deps.all,
      });
      log(`[agent-wrangler] extension ${manifest.id} installed from ${url} at ${sha.slice(0, 8)}`);
      if (registered) {
        progress(ctx, 'done', { id: manifest.id, restartRequired: true });
        ctx.reply({ type: 'ext-install-done', id: manifest.id, installed: true, sha, restartRequired: true });
        await ctx.rebuild();
        return;
      }
      const entry = await goLive(ctx, manifest.id, dest);
      progress(ctx, 'done', { id: manifest.id });
      // `active: false` is the honest end state when config says this extension
      // is off — `defaultEnabled` absent or false, or a stale `extensions.<id>`
      // left behind by an earlier uninstall. It is registered and one toggle
      // away, and saying "installed and live" there would be a lie.
      ctx.reply({ type: 'ext-install-done', id: manifest.id, installed: true, sha, active: Boolean(entry.enabled) });
      await ctx.rebuild();
    } catch (err) {
      // On ANY failure at any point the staging dir goes — it is never left
      // behind for a later boot to find half-installed.
      rmQuiet(dir);
      progress(ctx, 'failed', { id: declared.id, message: String(err?.message || err) });
      throw err;
    } finally {
      busy = null;
    }
  },
};

export const extUninstallHandler = {
  type: 'ext-uninstall',
  async handler(msg, ctx) {
    const id = String(msg.id || '');
    const known = ctx.ext.list.find((e) => e.id === id);
    if (!known) throw new Error(`Unknown extension: ${id}`);
    if (!known.external) throw new Error(`${id} ships with the wrangler and cannot be uninstalled — turn it off instead.`);
    const dest = safeExtPath(id);
    // Deactivated and deregistered BEFORE the files go: its row, tools,
    // handlers, stores, sweeps and client asset are gone on the next tick. What
    // no uninstall can undo is the module import itself — Node keeps it forever
    // — so the reply still asks for a restart to reclaim it, and anything the
    // manifest's own top-level code started (a timer, a global listener) runs
    // until then.
    ctx.ext.deactivate(id);
    ctx.ext.unregister(id, { remove: true });
    rmQuiet(dest);
    removeRecord(id);
    ctx.ext.changed();
    // Whatever the extension persisted under DATA_DIR stays — not as retention,
    // but because a store's file is chosen by the extension's own factory and
    // there is nothing here that can enumerate it. An explicit purge is deferred;
    // see the spec's Deferred section, and uninstallBodyText, which says so.
    log(`[agent-wrangler] extension ${id} uninstalled (its own saved data, wherever it put it, is left)`);
    ctx.reply({ type: 'ext-uninstall-done', id, restartRequired: true });
    await ctx.rebuild();
  },
};

export const extCheckUpdatesHandler = {
  type: 'ext-check-updates',
  async handler(msg, ctx) {
    // ON DEMAND ONLY — one `git ls-remote` per installed extension, off a
    // button. No sweep, no background network, and nothing logged: a periodic
    // check would be per-tick noise in the log and unasked-for traffic to
    // whatever host an extension came from.
    const provenance = readProvenance();
    const out = [];
    for (const entry of ctx.ext.list) {
      if (!entry.external) continue;
      const record = provenance[entry.id];
      // `provenance: null` — a hand-dropped directory — has no originUrl to ask
      // about, so it is skipped rather than reported as up to date.
      if (!record?.originUrl) { out.push({ id: entry.id, updatable: false }); continue; }
      try {
        const head = await runners.lsRemote(record.originUrl);
        out.push({ id: entry.id, updatable: true, originUrl: record.originUrl, sha: record.sha || '', remoteSha: head, behind: Boolean(record.sha) && head !== record.sha });
      } catch (err) {
        out.push({ id: entry.id, updatable: true, originUrl: record.originUrl, error: String(err?.message || err) });
      }
    }
    ctx.reply({ type: 'ext-updates', extensions: out });
  },
};
