import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  extInstallHandler, extConsentHandler, extUninstallHandler, extCheckUpdatesHandler,
  _resetInstallLockForTests, _setInstallRunnersForTests, _agePendingConsentForTests,
} from './extensions-install.js';
import { externalDir, tmpDir, readProvenance, putRecord } from '../../extensions/provenance.js';
import { loadExtensions, registerExtension, unregisterExtension } from '../../extensions/index.js';
import { discoverExternal } from '../../extensions/external.js';
import { DATA_DIR } from '../../data-dir.js';

// AW_DATA_DIR is a per-process temp dir (server/test-setup.js), so every path
// below is throwaway. No git and no npm ever runs: the clone is faked by writing
// the files a clone would have produced, through the module's runner seam —
// never through the incoming frame, which is browser-supplied.
function reset() {
  _resetInstallLockForTests();
  _setInstallRunnersForTests(null);
  fs.rmSync(externalDir(), { recursive: true, force: true });
  // extensions.json is a SIBLING of the extensions dir, not inside it — that
  // separation is the point of the provenance store, so clearing it needs its
  // own line here.
  fs.rmSync(path.join(DATA_DIR, 'extensions.json'), { force: true });
}

// A REAL loaded registry behind the core-owned bag index.js builds (extBag), so
// an install's register/unregister actually mutate something and the test can
// read the result; activate/deactivate are spies, since bringing an extension up
// binds singletons that only exist inside server/index.js. `builtin` entries go
// through the loader, so a bare `{id, external}` becomes the same quarantined
// row discovery would have produced — which is all the uninstall and
// check-updates paths read.
function ctx(builtin = [], { onActivate } = {}) {
  const loaded = loadExtensions({ cfg: {}, builtin });
  const calls = { replies: [], broadcasts: [], rebuild: 0, activated: [], deactivated: [], changed: 0 };
  return {
    calls,
    loaded,
    ext: {
      list: loaded.list,
      manifests: loaded._manifests,
      register: (m, o) => registerExtension(loaded, m, o),
      unregister: (id, o) => unregisterExtension(loaded, id, o),
      activate: (id) => { calls.activated.push(id); onActivate?.(id); },
      deactivate: (id) => { calls.deactivated.push(id); },
      quarantine: () => {},
      changed: () => { calls.changed += 1; },
    },
    reply: (o) => calls.replies.push(o),
    broadcast: (o) => calls.broadcasts.push(o),
    rebuild: async () => { calls.rebuild += 1; },
  };
}

function reply(c, type) {
  return c.calls.replies.find((r) => r.type === type);
}

// Stands in for `git clone`: the handler's only contract with it is that the
// destination directory holds the repo afterwards.
// `declared`/`declaredRequires` default to the manifest's own id/requires, which
// is the honest case; a test passes them separately to stage a repo whose
// package.json disclosure and index.js manifest DISAGREE.
function fakeClone({
  id = 'notes', requires = [], lock = true, declaration = true,
  declaredId = id, declaredRequires = requires, indexThrows = false, defaultEnabled = true,
} = {}) {
  return async (_url, dest) => {
    fs.mkdirSync(dest, { recursive: true });
    const body = indexThrows
      ? "throw new Error('index.js executed at disclosure time');\n"
      : `export default {\n  id: ${JSON.stringify(id)},\n  label: 'Notes',\n  description: 'Keeps notes.',\n  author: 'A Colleague',\n  defaultEnabled: ${JSON.stringify(defaultEnabled)},\n  requires: ${JSON.stringify(requires)},\n};\n`;
    fs.writeFileSync(path.join(dest, 'index.js'), body);
    fs.writeFileSync(path.join(dest, 'package.json'), JSON.stringify({
      name: 'notes',
      type: 'module',
      dependencies: { left: '^1.0.0' },
      ...(declaration ? {
        wranglerExtension: {
          id: declaredId, label: 'Notes', description: 'Keeps notes.', author: 'A Colleague', requires: declaredRequires,
        },
      } : {}),
    }));
    if (lock) {
      fs.writeFileSync(path.join(dest, 'package-lock.json'), JSON.stringify({
        lockfileVersion: 3,
        packages: {
          '': { name: 'notes', dependencies: { left: '^1.0.0' } },
          'node_modules/left': { version: '1.0.0' },
          'node_modules/deep': { version: '2.0.0' },
        },
      }));
    }
  };
}

function useFakes(opts = {}) {
  _setInstallRunnersForTests({ clone: fakeClone(opts), head: async () => opts.sha || 'c'.repeat(40), npm: async () => {} });
}

const URL_NOTES = 'https://example.invalid/notes.git';

async function disclose(c, opts = {}) {
  useFakes(opts);
  await extInstallHandler.handler({ type: 'ext-install', url: URL_NOTES }, c);
  return reply(c, 'ext-install-disclosure');
}

async function install(c, opts = {}, approve = true) {
  const disclosure = await disclose(c, opts);
  await extConsentHandler.handler({ type: 'ext-consent', tempId: disclosure.tempId, approve }, c);
  return disclosure;
}

test('ext-install discloses and installs NOTHING; ext-consent completes it', async () => {
  reset();
  const c = ctx();
  const disclosure = await install(c);
  assert.equal(disclosure.id, 'notes');
  assert.equal(disclosure.label, 'Notes');
  assert.equal(disclosure.description, 'Keeps notes.');
  assert.equal(disclosure.author, 'A Colleague');
  assert.equal(disclosure.update, false);
  assert.deepEqual(disclosure.dependencies, ['left@1.0.0'], 'direct dependencies are listed');
  assert.equal(disclosure.dependencyCount, 2, 'the transitive total is a count, not a list');
  const done = reply(c, 'ext-install-done');
  assert.equal(done.installed, true);
  assert.equal(done.restartRequired, undefined, 'a fresh install goes live in this process');
  assert.equal(done.active, true);
  // Registered AND activated: the row, its contributions and its client asset
  // are all there before the reply lands.
  assert.deepEqual(c.loaded.list.map((e) => e.id), ['notes']);
  assert.deepEqual(c.calls.activated, ['notes']);
  assert.equal(c.calls.changed, 1, 'the router map and the client announcement both ride this');
  assert.ok(fs.existsSync(path.join(externalDir(), 'notes', 'index.js')));
  const record = readProvenance().notes;
  assert.equal(record.originUrl, URL_NOTES);
  assert.deepEqual(record.dependencies, ['deep@2.0.0', 'left@1.0.0']);
  assert.deepEqual(record.requires, []);
  assert.deepEqual(c.calls.broadcasts.map((b) => b.phase), ['cloning', 'resolving', 'disclosed', 'installing', 'done']);
  assert.equal(c.calls.rebuild, 1);
  // The installed tree is exactly what discovery loads at the next boot.
  const found = await discoverExternal();
  assert.deepEqual(found.map((e) => [e.id, e.quarantine]), [['notes', undefined]]);
  reset();
});

test('a rejected consent installs nothing and leaves no staging dir behind', async () => {
  reset();
  const c = ctx();
  await install(c, {}, false);
  assert.equal(reply(c, 'ext-install-done').cancelled, true);
  assert.equal(fs.existsSync(path.join(externalDir(), 'notes')), false);
  assert.deepEqual(fs.readdirSync(tmpDir()), []);
  assert.equal(readProvenance().notes, undefined);
  reset();
});

test('a repository with no package-lock.json is refused, and the staging dir is swept', async () => {
  reset();
  const c = ctx();
  useFakes({ lock: false });
  await assert.rejects(
    () => extInstallHandler.handler({ type: 'ext-install', url: URL_NOTES }, c),
    /ships no package-lock\.json/,
  );
  assert.deepEqual(fs.readdirSync(tmpDir()), []);
  assert.equal(c.calls.broadcasts.at(-1).phase, 'failed');
  // The lock is released on the failure path, or one bad repository would wedge
  // every later install for the life of the process.
  assert.equal((await install(ctx())).id, 'notes');
  reset();
});

test('a refused URL never reaches the clone', async () => {
  reset();
  let cloned = false;
  _setInstallRunnersForTests({ clone: async () => { cloned = true; } });
  await assert.rejects(
    () => extInstallHandler.handler({ type: 'ext-install', url: 'ext::sh -c id' }, ctx()),
    /Refusing repository URL/,
  );
  assert.equal(cloned, false);
  reset();
});

test('one install at a time: a second concurrent attempt is refused, not queued', async () => {
  reset();
  const c = ctx();
  await disclose(c);
  await assert.rejects(
    () => extInstallHandler.handler({ type: 'ext-install', url: 'https://example.invalid/other.git' }, c),
    /already running/,
  );
  reset();
});

test('an update diffs against the recorded consent, and only a WIDENED requires forces re-consent', async () => {
  reset();
  putRecord({
    id: 'notes',
    originUrl: URL_NOTES,
    sha: 'a'.repeat(40),
    installedAt: new Date().toISOString(),
    requires: ['tasks:read', 'memory:read'],
    dependencies: ['gone@0.1.0', 'left@0.9.0'],
  });

  // Narrowed: nothing new is being asked for, so the recorded consent stands.
  const narrowed = ctx();
  const nd = await disclose(narrowed, { requires: ['tasks:read'] });
  assert.equal(nd.update, true);
  assert.equal(nd.reconsentNeeded, false);
  assert.deepEqual(nd.addedCapabilities, []);
  assert.deepEqual(nd.removedCapabilities, ['memory:read']);
  assert.equal(nd.priorSha, 'a'.repeat(40));
  // The diff, not the full lists: `left` bumped (direct, so listed), `deep`
  // arrived transitively (counted only), `gone` left the tree entirely.
  assert.deepEqual(nd.addedDependencies, ['left@1.0.0']);
  assert.deepEqual(nd.removedDependencies, ['gone@0.1.0']);
  assert.equal(nd.addedCount, 2);
  assert.equal(nd.removedCount, 2);
  await extConsentHandler.handler({ type: 'ext-consent', tempId: nd.tempId, approve: false }, narrowed);

  const widened = ctx();
  const wd = await disclose(widened, { requires: ['tasks:read', 'sessions:kill'] });
  assert.equal(wd.reconsentNeeded, true);
  assert.deepEqual(wd.addedCapabilities, ['sessions:kill']);
  await extConsentHandler.handler({ type: 'ext-consent', tempId: wd.tempId, approve: true }, widened);
  assert.deepEqual(readProvenance().notes.requires, ['tasks:read', 'sessions:kill'], 'consent is re-recorded at the new set');
  reset();
});

test('a requires widened in place on disk after consent quarantines at the next discovery', async () => {
  reset();
  // A distinct id: Node's ESM cache is per URL, so re-importing a path an
  // earlier test already discovered would serve the OLD module. Real discovery
  // runs once per process, so this is a test artefact rather than a product one.
  await install(ctx(), { id: 'widener', requires: ['tasks:read'] });
  const file = path.join(externalDir(), 'widener', 'index.js');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('["tasks:read"]', "['tasks:read','sessions:kill']"));
  const found = await discoverExternal();
  assert.match(found[0].quarantine, /widened-and-unconsented requires \(sessions:kill\)/);
  reset();
});

test('ext-uninstall removes the directory and the record, keeps store data, and refuses a builtin', async () => {
  reset();
  await install(ctx());
  const c = ctx([{ id: 'notes', external: true }, { id: 'shipped', external: false }]);
  await extUninstallHandler.handler({ type: 'ext-uninstall', id: 'notes' }, c);
  assert.equal(fs.existsSync(path.join(externalDir(), 'notes')), false);
  assert.equal(readProvenance().notes, undefined);
  assert.equal(reply(c, 'ext-uninstall-done').restartRequired, true, 'the module Node already cached is what the restart reclaims');
  // Deregistered immediately, whatever the module cache still holds.
  assert.deepEqual(c.loaded.list.map((e) => e.id), ['shipped']);
  assert.deepEqual(c.calls.deactivated, ['notes']);
  assert.equal(c.calls.changed, 1);
  assert.equal(c.calls.rebuild, 1);
  await assert.rejects(() => extUninstallHandler.handler({ type: 'ext-uninstall', id: 'shipped' }, c), /ships with the wrangler/);
  await assert.rejects(() => extUninstallHandler.handler({ type: 'ext-uninstall', id: 'nope' }, c), /Unknown extension/);
  reset();
});

test('a manifest id that would escape the extensions dir is refused before any write', async () => {
  reset();
  const c = ctx();
  useFakes({ id: '../escape' });
  await assert.rejects(
    () => extInstallHandler.handler({ type: 'ext-install', url: URL_NOTES }, c),
    /id must match/,
    'validateManifest rejects it at disclosure, so no path is ever built from it',
  );
  assert.deepEqual(fs.readdirSync(tmpDir()), []);
  reset();
});

test('ext-check-updates asks once per installed extension, on demand, and skips a provenance-less one', async () => {
  reset();
  putRecord({ id: 'notes', originUrl: URL_NOTES, sha: 'a'.repeat(40), installedAt: '', requires: [], dependencies: [] });
  const asked = [];
  _setInstallRunnersForTests({ lsRemote: async (url) => { asked.push(url); return 'b'.repeat(40); } });
  const c = ctx([{ id: 'notes', external: true }, { id: 'handdropped', external: true }, { id: 'shipped', external: false }]);
  await extCheckUpdatesHandler.handler({ type: 'ext-check-updates' }, c);
  const { extensions } = reply(c, 'ext-updates');
  assert.deepEqual(asked, [URL_NOTES], 'one ls-remote per updatable extension, and none for a builtin');
  assert.deepEqual(extensions.map((e) => [e.id, e.updatable, e.behind ?? null]), [['notes', true, true], ['handdropped', false, null]]);
  reset();
});

test('disclosure NEVER imports the extension: an index.js that throws on import still discloses', async () => {
  // The security half of the static-declaration rule. `npm ci` has not run at
  // disclosure time either, so a manifest importing a dependency could not be
  // imported even if we wanted to — this repo's index.js throws outright, which
  // is the same thing from the handler's point of view.
  reset();
  const c = ctx();
  const disclosure = await disclose(c, { indexThrows: true });
  assert.equal(disclosure.id, 'notes');
  assert.deepEqual(disclosure.capabilities, []);
  // …and it is the CONSENT step that discovers the bad manifest, with nothing
  // installed and the staging dir gone.
  await assert.rejects(
    extConsentHandler.handler({ type: 'ext-consent', tempId: disclosure.tempId, approve: true }, c),
    /index\.js executed at disclosure time/,
  );
  assert.equal(fs.existsSync(path.join(externalDir(), 'notes')), false);
  assert.deepEqual(fs.readdirSync(tmpDir()), []);
});

test('a repo with no wranglerExtension block is refused, naming what it must declare', async () => {
  reset();
  const c = ctx();
  await assert.rejects(
    (async () => { useFakes({ declaration: false }); await extInstallHandler.handler({ type: 'ext-install', url: URL_NOTES }, c); })(),
    /wranglerExtension/,
  );
  assert.deepEqual(fs.readdirSync(tmpDir()), []);
});

test('a manifest requiring more than its package.json disclosed fails the install', async () => {
  // The whole point of holding the manifest to the declaration: the human
  // consented to a list, and the code may not quietly take more than that.
  reset();
  const c = ctx();
  const disclosure = await disclose(c, { requires: ['tasks:read', 'sessions:kill'], declaredRequires: ['tasks:read'] });
  assert.deepEqual(disclosure.capabilities, ['tasks:read']);
  await assert.rejects(
    extConsentHandler.handler({ type: 'ext-consent', tempId: disclosure.tempId, approve: true }, c),
    /sessions:kill.*did not disclose/s,
  );
  assert.equal(fs.existsSync(path.join(externalDir(), 'notes')), false);
  assert.equal(readProvenance().notes, undefined);
});

test("a manifest whose id differs from the disclosed one fails the install", async () => {
  reset();
  const c = ctx();
  const disclosure = await disclose(c, { id: 'other', declaredId: 'notes' });
  assert.equal(disclosure.id, 'notes');
  await assert.rejects(
    extConsentHandler.handler({ type: 'ext-consent', tempId: disclosure.tempId, approve: true }, c),
    /does not match what was consented to/,
  );
  assert.equal(fs.existsSync(path.join(externalDir(), 'other')), false);
  assert.equal(fs.existsSync(path.join(externalDir(), 'notes')), false);
});

test('an abandoned consent is reclaimed rather than wedging every later install', async () => {
  // Closing the modal, reloading the board or losing the socket all end a
  // disclosure with nobody to answer it, and the handler is told about none of
  // them. Before this, one of those held the lock until a restart.
  reset();
  const c = ctx();
  const abandoned = await disclose(c);
  await assert.rejects(
    extInstallHandler.handler({ type: 'ext-install', url: URL_NOTES }, ctx()),
    /already running/,
  );
  _agePendingConsentForTests();
  const c2 = ctx();
  const fresh = await disclose(c2);
  assert.notEqual(fresh.tempId, abandoned.tempId);
  // The abandoned staging dir went with the lock — only the live one is left.
  assert.deepEqual(fs.readdirSync(tmpDir()), [fresh.tempId]);
});

// An UPDATE keeps restart semantics deliberately: Node cannot unload the old
// module, so activating the new one would run two versions of one extension at
// once. Any id already carrying a row takes this path, a quarantined one
// included — a fix-by-reinstall still needs the restart.
test('installing over an id that already has a row is an update: restart, not live', async () => {
  reset();
  const c = ctx([{ id: 'notes', label: 'Notes', defaultEnabled: true, external: true }]);
  await install(c);
  const done = reply(c, 'ext-install-done');
  assert.equal(done.installed, true);
  assert.equal(done.restartRequired, true);
  assert.equal(c.calls.broadcasts.at(-1).restartRequired, true, 'the progress line says so too');
  assert.deepEqual(c.calls.activated, [], 'the new module is never brought up beside the old one');
  assert.equal(c.calls.changed, 0);
  assert.ok(fs.existsSync(path.join(externalDir(), 'notes', 'index.js')), 'the files still land');
  reset();
});

// Config, not the install button, decides whether it RUNS — the same rule boot
// applies, so an install can never leave the process in a state a restart would
// not reproduce.
test('an extension config says is off installs registered-but-inactive, and says so', async () => {
  reset();
  const c = ctx();
  await install(c, { defaultEnabled: false });
  const done = reply(c, 'ext-install-done');
  assert.equal(done.installed, true);
  assert.equal(done.active, false);
  assert.deepEqual(c.loaded.list.map((e) => [e.id, e.enabled]), [['notes', false]]);
  assert.deepEqual(c.calls.activated, []);
  assert.equal(c.calls.changed, 1, 'the row is new even though nothing is running');
  reset();
});

// Everything or nothing: a manifest that cannot be brought up must leave no
// directory, no provenance record, no row — and must release the install lock.
test('a failure while going live rolls the whole install back', async () => {
  reset();
  const c = ctx([], { onActivate: () => { throw new Error('store factory exploded'); } });
  const disclosure = await disclose(c, { id: 'boom' });
  await assert.rejects(
    () => extConsentHandler.handler({ type: 'ext-consent', tempId: disclosure.tempId, approve: true }, c),
    /store factory exploded/,
  );
  assert.equal(fs.existsSync(path.join(externalDir(), 'boom')), false);
  assert.equal(readProvenance().boom, undefined);
  assert.deepEqual(c.loaded.list, []);
  assert.deepEqual(c.loaded.tools, []);
  assert.equal(c.calls.broadcasts.at(-1).phase, 'failed');
  // The lock is released, or one bad extension wedges every later install.
  assert.equal((await install(ctx())).id, 'notes');
  reset();
});

// The same id, twice in one process: the second import must not come back out
// of Node's ESM cache holding the version that was just deleted from disk.
test('a same-id reinstall after an uninstall goes live again', async () => {
  reset();
  const c = ctx();
  await install(c, { id: 'recycled' });
  await extUninstallHandler.handler({ type: 'ext-uninstall', id: 'recycled' }, c);
  assert.deepEqual(c.loaded.list, []);
  // `reply()` finds the FIRST frame of a type, so the second round needs a
  // clean slate; the registry behind the bag is deliberately the same one.
  c.calls.replies.length = 0;
  await install(c, { id: 'recycled' });
  assert.deepEqual(c.loaded.list.map((e) => e.id), ['recycled'], 'the id was released, so it stages again');
  assert.equal(reply(c, 'ext-install-done').active, true);
  reset();
});
