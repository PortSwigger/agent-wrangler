import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { discoverExternal, unconsentedCapabilities, admitExternal, FORBIDDEN_IMPORTS } from './external.js';
import { loadExtensions } from './index.js';

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aw-ext-discover-'));
}

// The smallest real manifest an installed extension can ship: a default export
// whose id matches the directory it sits in.
function writeExt(root, id, { body, idInManifest = id, requires = [] } = {}) {
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.js'), body ?? `export default {
    id: ${JSON.stringify(idInManifest)},
    label: ${JSON.stringify(`${id} extension`)},
    requires: ${JSON.stringify(requires)},
  };\n`);
  return dir;
}

test('a good manifest is discovered, tagged external and carries its directory', async () => {
  const root = tempRoot();
  writeExt(root, 'notes');
  const found = await discoverExternal({ dir: root, provenance: {} });
  assert.equal(found.length, 1);
  assert.equal(found[0].id, 'notes');
  assert.equal(found[0].external, true);
  assert.equal(found[0].dir, path.join(root, 'notes'));
  assert.equal(found[0].provenance, null, 'a hand-dropped directory loads with no provenance');
  assert.equal(found[0].quarantine, undefined);
});

test('a missing extensions dir is the ordinary fresh-install state, not an error', async () => {
  assert.deepEqual(await discoverExternal({ dir: path.join(tempRoot(), 'nope'), provenance: {} }), []);
});

test('a bad manifest quarantines rather than throwing', async () => {
  const root = tempRoot();
  writeExt(root, 'nodefault', { body: 'export const notDefault = 1;\n' });
  writeExt(root, 'throws', { body: 'throw new Error("boom");\n' });
  fs.mkdirSync(path.join(root, 'empty'));
  const found = await discoverExternal({ dir: root, provenance: {} });
  const byId = Object.fromEntries(found.map((e) => [e.id, e.quarantine]));
  assert.match(byId.nodefault, /no default-exported manifest/);
  assert.match(byId.throws, /could not load index\.js .*boom/);
  assert.match(byId.empty, /could not load index\.js/);
});

test('a leaf-rule import violation quarantines, and the rule is shared with index.test.js', async () => {
  const root = tempRoot();
  writeExt(root, 'cyclic', { body: "import { SessionManager } from '../../session-manager.js';\nexport default { id: 'cyclic', label: 'Cyclic' };\n" });
  writeExt(root, 'hostapi', { body: "import { buildHostApi } from '../../host-api/index.js';\nexport default { id: 'hostapi', label: 'Host' };\n" });
  writeExt(root, 'entry', { body: "import x from '../../index.js';\nexport default { id: 'entry', label: 'Entry' };\n" });
  // A DYNAMIC import of the same module is deliberately NOT caught — the rule is
  // a correctness guard against closing a boot-breaking module cycle, not a
  // security boundary, and this asserts nothing pretends otherwise.
  writeExt(root, 'dynamic', { body: "export default { id: 'dynamic', label: 'Dyn', load: () => import('../../session-manager.js') };\n" });
  const found = await discoverExternal({ dir: root, provenance: {} });
  const byId = Object.fromEntries(found.map((e) => [e.id, e.quarantine]));
  for (const id of ['cyclic', 'hostapi', 'entry']) assert.match(byId[id], /statically imports a server core module/, id);
  assert.equal(byId.dynamic, undefined, 'a dynamic import is not, and does not claim to be, caught');
  assert.equal(FORBIDDEN_IMPORTS.length, 3);
});

// The most obvious test an extension can ship — a manifest self-check — used to
// quarantine it, with a reason about server core modules it never imported. Two
// independent things had to be wrong for that, and both are asserted here: the
// scan walked test files at all, and a SINGLE-level `../index.js` matched the
// server-entry pattern even though no relative path from an installed
// extension's directory reaches the repo.
test("an extension's own tests are not scanned, and a self-import is not a server import", async () => {
  const root = tempRoot();
  const dir = writeExt(root, 'selfcheck');
  fs.mkdirSync(path.join(dir, 'test'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'test', 'manifest.test.js'), "import ext from '../index.js';\nimport { SessionManager } from '../../session-manager.js';\n");
  // A test file beside the manifest rather than in a test/ directory, skipped by
  // name for the same reason.
  fs.writeFileSync(path.join(dir, 'smoke.test.js'), "import x from '../../host-api/index.js';\n");
  // And a REAL module of the extension's own, self-importing the way any
  // multi-file extension does.
  fs.writeFileSync(path.join(dir, 'tools.js'), "import manifest from '../index.js';\nexport default manifest;\n");
  const found = await discoverExternal({ dir: root, provenance: {} });
  assert.equal(found[0].quarantine, undefined);
});

// A skill ships for an AGENT to read, and may carry a script for it to run;
// nothing in the server's import graph can reach one, so scanning the skills
// directory could only ever produce a false positive — the same argument as
// test files and node_modules. At the root only: a `skills/` directory inside
// the extension's own code is ordinary code.
test("the root skills/ directory is not scanned, but a nested one still is", async () => {
  const root = tempRoot();
  const dir = writeExt(root, 'ships');
  fs.mkdirSync(path.join(dir, 'skills', 'job-worker'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'skills', 'job-worker', 'SKILL.md'), '---\nname: job-worker\ndescription: d\n---\n');
  fs.writeFileSync(path.join(dir, 'skills', 'job-worker', 'helper.js'), "import { SessionManager } from '../../../session-manager.js';\n");
  assert.equal((await discoverExternal({ dir: root, provenance: {} }))[0].quarantine, undefined);

  fs.mkdirSync(path.join(dir, 'server', 'skills'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'server', 'skills', 'reach.js'), "import x from '../../../state-reader.js';\n");
  assert.match((await discoverExternal({ dir: root, provenance: {} }))[0].quarantine, /server\/skills\/reach\.js/);
});

test('the server entry is still caught from a builtin\'s depth, in a subdirectory too', async () => {
  const root = tempRoot();
  const dir = writeExt(root, 'deep');
  fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'lib', 'reach.js'), "import x from '../../../index.js';\n");
  const found = await discoverExternal({ dir: root, provenance: {} });
  assert.match(found[0].quarantine, /statically imports a server core module/);
  assert.match(found[0].quarantine, /lib\/reach\.js/);
});

test('node_modules is not scanned for the import rule', async () => {
  const root = tempRoot();
  const dir = writeExt(root, 'deps');
  fs.mkdirSync(path.join(dir, 'node_modules', 'pkg'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'node_modules', 'pkg', 'i.js'), "import y from '../../../../tmux-scraper.js';\n");
  const found = await discoverExternal({ dir: root, provenance: {} });
  assert.equal(found[0].quarantine, undefined);
});

test('id !== directory name quarantines — the on-disk layout must not lie', async () => {
  const root = tempRoot();
  writeExt(root, 'notes', { idInManifest: 'something-else' });
  const found = await discoverExternal({ dir: root, provenance: {} });
  assert.match(found[0].quarantine, /does not match its directory name "notes"/);
});

test('an external id colliding with a builtin quarantines the EXTERNAL one', async () => {
  const root = tempRoot();
  writeExt(root, 'notes');
  const external = await discoverExternal({ dir: root, provenance: {} });
  const builtin = { id: 'notes', label: 'Shipped notes', dir: path.join(root, 'builtin') };
  // The order primeExtensions uses: builtins first, externals appended.
  const out = loadExtensions({ cfg: {}, builtin: [builtin, ...external] });
  assert.equal(out.list[0].quarantine, null);
  assert.equal(out.list[0].label, 'Shipped notes');
  assert.match(out.list[1].quarantine, /duplicate extension id/);
  assert.equal(out.list[1].external, true);
});

test('requires widened in place after consent quarantines; unchanged or narrowed does not', async () => {
  const root = tempRoot();
  writeExt(root, 'wide', { requires: ['tasks:read', 'sessions:kill'] });
  writeExt(root, 'same', { requires: ['tasks:read'] });
  writeExt(root, 'narrow', { requires: [] });
  const provenance = {
    wide: { id: 'wide', requires: ['tasks:read'] },
    same: { id: 'same', requires: ['tasks:read'] },
    narrow: { id: 'narrow', requires: ['tasks:read'] },
  };
  const found = await discoverExternal({ dir: root, provenance });
  const byId = Object.fromEntries(found.map((e) => [e.id, e.quarantine]));
  assert.match(byId.wide, /widened-and-unconsented requires \(sessions:kill\)/);
  assert.equal(byId.same, undefined);
  assert.equal(byId.narrow, undefined);
});

test('unconsentedCapabilities gates nothing without a record — a hand-dropped directory is its own consent', () => {
  assert.deepEqual(unconsentedCapabilities(['sessions:kill'], null), []);
  assert.deepEqual(unconsentedCapabilities(['sessions:kill'], { id: 'x' }), []);
  assert.deepEqual(unconsentedCapabilities(['a', 'b', 'b'], { requires: ['a'] }), ['b']);
});

// The same checks the install handler runs after ITS import, which is the whole
// reason they live in one function: an install that admitted a manifest boot
// would quarantine reads as an install that silently did nothing.
test('admitExternal applies the id-match and consent checks the install path shares with discovery', () => {
  const base = { id: 'toy', dir: '/tmp/toy', external: true, provenance: { id: 'toy', requires: ['tasks:read'] } };
  assert.deepEqual(admitExternal(null, base), { ok: false, quarantine: 'index.js has no default-exported manifest object' });
  assert.match(admitExternal({ id: 'other' }, base).quarantine, /does not match its directory name "toy"/);
  assert.match(admitExternal({ id: 'toy', requires: ['tasks:read', 'sessions:kill'] }, base).quarantine, /widened-and-unconsented requires \(sessions:kill\)/);
  const ok = admitExternal({ id: 'toy', label: 'Toy', dir: '/its/own/idea', requires: ['tasks:read'] }, base);
  assert.equal(ok.ok, true);
  assert.equal(ok.entry.label, 'Toy');
  assert.equal(ok.entry.dir, '/tmp/toy', 'the discovered path wins over the manifest\'s own');
  assert.equal(ok.entry.external, true);
});
