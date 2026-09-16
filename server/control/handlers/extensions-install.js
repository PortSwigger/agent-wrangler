import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { validateManifest } from '../../extensions/index.js';
import { externalDir, tmpDir, ensureDirs, isValidExtensionId, readProvenance, recordFor, putRecord, removeRecord } from '../../extensions/provenance.js';
import { unconsentedCapabilities } from '../../extensions/external.js';
import { assertAllowedUrl, cloneTo, readHead, lockDependencies, npmCi, lsRemoteHead, MissingLockfileError } from '../../extensions/install.js';
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
// Newly installed code loads at the NEXT SERVER START — the same restart
// semantics the existing `enabled && !bootEnabled` case has, reusing
// extensionFlipNote's vocabulary rather than inventing a second way of saying
// it. Uninstall is symmetric: the code stays live until restart.

// ONE install at a time per instance, refused rather than queued: two clones
// racing into the same staging root, or two `npm ci` runs against one tree, has
// no sensible outcome and a human who pressed the button twice wants to be told,
// not silently made to wait. In-memory is right — a restart cancels nothing
// meaningful, because an interrupted install leaves only a staging dir, which
// boot sweeps (server/extensions/external.js sweepStaging).
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

// Progress is BROADCAST (the modal may be open in more than one tab, and the
// board's own state changes underneath it) and the terminal phase is ALSO
// replied, so the modal never depends solely on a broadcast it might have
// missed. Routed through ctx.broadcast, which is sendGuarded-backed like every
// other broadcast.
function progress(ctx, phase, extra = {}) {
  ctx.broadcast?.({ type: 'ext-install-progress', phase, ...extra });
}

// Only what the consent modal shows. Deliberately NOT the whole manifest: it is
// third-party data, and everything here is rendered via textContent.
function discloseManifest(manifest) {
  return {
    id: manifest.id,
    label: manifest.label,
    description: typeof manifest.description === 'string' ? manifest.description : '',
    author: typeof manifest.author === 'string' ? manifest.author : '',
    homepage: typeof manifest.homepage === 'string' ? manifest.homepage : '',
    capabilities: [...(manifest.requires || [])],
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
function updateDiff(record, manifest, deps) {
  const priorAll = new Set(record.dependencies || []);
  const nextAll = new Set(deps.all);
  const addedCapabilities = unconsentedCapabilities([...(manifest.requires || [])], record);
  const removedCapabilities = (record.requires || []).filter((c) => !(manifest.requires || []).includes(c));
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
    if (busy) throw new Error(`An extension install is already running (${busy}). Wait for it to finish and try again.`);
    const url = assertAllowedUrl(String(msg.url || '').trim());
    busy = url;
    const tempId = crypto.randomBytes(8).toString('hex');
    const dir = safeStagingPath(tempId);
    try {
      ensureDirs();
      progress(ctx, 'cloning', { url });
      await runners.clone(url, dir);
      progress(ctx, 'resolving');
      const manifest = await loadStagedManifest(dir);
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
      const existing = recordFor(manifest.id);
      const reply = {
        type: 'ext-install-disclosure',
        tempId,
        sha,
        ...discloseManifest(manifest),
        dependencies: deps.direct,
        dependencyCount: deps.all.length,
        ...(existing ? updateDiff(existing, manifest, deps) : { update: false, reconsentNeeded: true }),
      };
      pending.set(tempId, { url, sha, manifest, deps, dir });
      // The lock is HELD across the human's decision, deliberately: the staging
      // dir is what a second install would collide with, and it lives until
      // consent resolves. Released by ext-consent, or by the failure path here.
      progress(ctx, 'disclosed', { id: manifest.id });
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
    const { url, sha, manifest, deps, dir } = staged;
    try {
      if (!msg.approve) {
        rmQuiet(dir);
        progress(ctx, 'cancelled', { id: manifest.id });
        ctx.reply({ type: 'ext-install-done', id: manifest.id, installed: false, cancelled: true });
        return;
      }
      progress(ctx, 'installing', { id: manifest.id });
      await runners.npm(dir);
      const dest = safeExtPath(manifest.id);
      // Replacing an existing install (an update) is a remove-then-rename
      // rather than a merge: a stale file from the previous version left in
      // place is a version nobody shipped. The live code keeps running from the
      // process's module cache until restart regardless.
      rmQuiet(dest);
      fs.renameSync(dir, dest);
      putRecord({
        id: manifest.id,
        originUrl: url,
        sha,
        installedAt: new Date().toISOString(),
        // The CONSENTED set, which is what a later update is diffed against and
        // what external.js checks the on-disk manifest has not widened past.
        requires: [...(manifest.requires || [])],
        dependencies: deps.all,
      });
      log(`[agent-wrangler] extension ${manifest.id} installed from ${url} at ${sha.slice(0, 8)}`);
      progress(ctx, 'done', { id: manifest.id });
      ctx.reply({ type: 'ext-install-done', id: manifest.id, installed: true, sha, restartRequired: true });
      await ctx.rebuild();
    } catch (err) {
      // On ANY failure at any point the staging dir goes — it is never left
      // behind for a later boot to find half-installed.
      rmQuiet(dir);
      progress(ctx, 'failed', { id: manifest.id, message: String(err?.message || err) });
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
    rmQuiet(dest);
    removeRecord(id);
    // DATA_DIR-persisted store data deliberately STAYS, and a reinstall picks it
    // up — the same "set aside, not destroyed" posture archive has. An explicit
    // purge is deferred; see the spec's Deferred section.
    log(`[agent-wrangler] extension ${id} uninstalled (store data kept)`);
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
