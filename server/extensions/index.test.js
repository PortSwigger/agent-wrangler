import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BUILTIN, RESERVED_GRAPH_KEYS, SESSION_HOOKS, CAPABILITIES,
  validateManifest, assertGraphKeys, loadExtensions, getExtensions, extensionsForGraph,
  createSkillGate, createToolFilter, quarantineExtension, primeExtensions, extensionsPrimed, _resetExtensionsForTests,
} from './index.js';
import { FORBIDDEN_IMPORTS } from './external.js';
import { TOOLS } from '../mcp/tools/index.js';
import { CONTROL_HANDLERS } from '../control/handlers/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function manifest(overrides = {}) {
  return {
    id: 'fake',
    label: 'Fake extension',
    help: 'Does fake things.',
    defaultEnabled: true,
    dir: path.join(HERE, 'fake'),
    stores: { fake: () => ({ snapshot: () => ({ n: 1 }) }) },
    handlers: [{ type: 'fake-do', handler() {} }],
    tools: [{ name: 'fake_tool', handler() {} }],
    skills: ['fake'],
    graph: ({ host }) => ({ fakes: host.stores.fake.snapshot() }),
    session: { onPurge() {} },
    ...overrides,
  };
}

// A rejected manifest QUARANTINES rather than throwing (loadExtensions' failure
// posture), so every expectation below is on the entry's reason rather than on a
// thrown error. The `Extension <id>: ` prefix is reconstructed here because the
// loader strips it for display on the settings row.
function rejects(ext, re, opts) {
  const out = loadExtensions({ cfg: {}, builtin: [ext], ...opts });
  const entry = out.list.at(-1);
  assert.ok(entry?.quarantine, `expected a quarantine reason, got ${JSON.stringify(entry)}`);
  assert.match(`Extension ${entry.id}: ${entry.quarantine}`, re);
  assert.equal(entry.enabled, false, 'a quarantined extension is never enabled');
  return out;
}

test('validation failures quarantine the extension, naming it in the reason', () => {
  rejects(manifest({ id: undefined }), /Extension <no id>: id must match/);
  rejects(manifest({ id: 'Bad_Id' }), /Extension Bad_Id: id must match/);
  rejects(manifest({ tools: [{ handler() {} }] }), /Extension fake: tools\[0\] has no name/);
  rejects(manifest({ tools: [{ name: 'x' }] }), /Extension fake: tool x has no handler/);
  rejects(manifest({ handlers: [{ handler() {} }] }), /Extension fake: handlers\[0\] has no type/);
  rejects(manifest({ sweeps: [{ id: 's', everyMs: 0, run() {} }] }), /Extension fake: sweep s everyMs must be a positive finite number/);
  rejects(manifest({ sweeps: [{ id: 's', everyMs: Infinity, run() {} }] }), /everyMs must be a positive finite number/);
  rejects(manifest({ session: { onArchived() {} } }), /Extension fake: unknown session hook "onArchived"/);
  rejects(manifest({ session: { onPurge: true } }), /Extension fake: session.onPurge must be a function/);
  rejects(manifest({ stores: { x: 42 } }), /Extension fake: stores.x must be a factory function/);
  rejects(manifest({ graph: 'nope' }), /Extension fake: graph must be a function/);
  rejects(manifest({ label: '' }), /Extension fake: label/);
});

// Collisions quarantine the SECOND claimant, which is how a builtin wins every
// tie against an appended external one by construction (loadExtensions' order
// comment) — so each case also asserts the first extension survived intact.
test('duplicate ids, tool names and handler types quarantine the second claimant, never the first', () => {
  function collides(second, re) {
    const out = loadExtensions({ cfg: {}, builtin: [manifest(), second] });
    assert.match(`Extension ${out.list[1].id}: ${out.list[1].quarantine}`, re);
    assert.equal(out.list[0].quarantine, null, 'the first extension is untouched');
    assert.deepEqual(out.tools.map((t) => t.name), ['fake_tool']);
    assert.deepEqual(out.handlers.map((h) => h.type), ['fake-do']);
    assert.deepEqual(Object.keys(out.stores), ['fake']);
  }
  collides(manifest(), /Extension fake: duplicate extension id/);
  collides(manifest({ id: 'other', handlers: [], stores: {} }), /Extension other: tool name "fake_tool" is already registered/);
  collides(manifest({ id: 'other', tools: [], stores: {} }), /Extension other: handler type "fake-do" is already registered/);
  collides(manifest({ id: 'other', tools: [], handlers: [] }), /Extension other: store name "fake" is already registered/);
  // A manifest that collides only on its SECOND tool registers neither: the
  // whole entry is staged before anything is committed.
  const partial = loadExtensions({ cfg: {}, builtin: [manifest({ id: 'other', handlers: [], stores: {}, tools: [{ name: 'other_tool', handler() {} }, { name: 'list_sessions', handler() {} }] })], coreToolNames: TOOLS.map((t) => t.name) });
  assert.match(partial.list[0].quarantine, /tool name "list_sessions"/);
  assert.deepEqual(partial.tools, []);
  assert.deepEqual(partial.allowedToolNames, []);
  rejects(manifest({ tools: [{ name: 'list_sessions', handler() {} }] }), /tool name "list_sessions" is already registered/, { coreToolNames: TOOLS.map((t) => t.name) });
  rejects(manifest({ handlers: [{ type: 'dispatch', handler() {} }] }), /handler type "dispatch" is already registered/, { coreHandlerTypes: CONTROL_HANDLERS.map((h) => h.type) });
  // A DISABLED extension's names are not claimed — it registers nothing.
  const out = loadExtensions({ cfg: { extensions: { fake: false } }, builtin: [manifest(), manifest({ id: 'other', stores: {} })] });
  assert.deepEqual(out.tools.map((t) => t.name), ['fake_tool']);
});

test('client paths must resolve inside the manifest dir\'s public/ subdir', () => {
  rejects(manifest({ client: '../index.js' }), /Extension fake: client "\.\.\/index\.js" must resolve inside .*fake\/public/);
  rejects(manifest({ client: 'index.js' }), /must resolve inside/);
  rejects(manifest({ client: '/etc/passwd' }), /must resolve inside/);
  rejects(manifest({ client: 'public/../store.js' }), /must resolve inside/);
  rejects(manifest({ client: 'public/index.js', dir: undefined }), /client requires the manifest to export its absolute `dir`/);
  rejects(manifest({ client: 'public/index.js', dir: 'relative/dir' }), /absolute `dir`/);
  assert.ok(validateManifest(manifest({ client: 'public/index.js' })));
  const out = loadExtensions({ cfg: {}, builtin: [manifest({ client: 'public/index.js' })] });
  assert.deepEqual(out.clientManifest, [{ id: 'fake', client: '/ext/fake/index.js', handlerTypes: ['fake-do'] }]);
  assert.deepEqual(out.dirs, { fake: path.join(HERE, 'fake') });
});

test('a manifest without `client` contributes nothing to clientManifest', () => {
  assert.deepEqual(loadExtensions({ cfg: {}, builtin: [manifest()] }).clientManifest, []);
});

test('enabled filtering: a disabled extension is listed but contributes nothing except its disabledSkillIds', () => {
  const out = loadExtensions({ cfg: { extensions: { fake: false } }, builtin: [manifest({ client: 'public/index.js', sweeps: [{ id: 's', everyMs: 1000, run() {} }] })] });
  assert.deepEqual(out.list, [{
    id: 'fake', label: 'Fake extension', help: 'Does fake things.', defaultEnabled: true, enabled: false,
    description: '', author: '', homepage: '',
    requires: [], range: null, storeNames: ['fake'], skills: ['fake'], handlerTypes: [],
    external: false, dir: path.join(HERE, 'fake'), provenance: null, quarantine: null,
  }], 'a disabled extension still reports its facade inputs, but claims no handler types');
  assert.deepEqual(out.tools, []);
  assert.deepEqual(out.allowedToolNames, []);
  assert.deepEqual(out.handlers, []);
  assert.deepEqual(out.skillIds, []);
  assert.deepEqual(out.disabledSkillIds, ['fake']);
  assert.deepEqual(out.graphContributors, []);
  assert.deepEqual(out.clientManifest, []);
  assert.deepEqual(out.sweeps, []);
  assert.deepEqual(out.stores, {});
  for (const k of SESSION_HOOKS) assert.deepEqual(out.sessionHooks[k], []);
});

test('enabled: every channel is populated, allowedToolNames is derived from tools, defaultEnabled wins absent config', () => {
  const m = manifest({ defaultEnabled: false });
  assert.equal(loadExtensions({ cfg: {}, builtin: [m] }).list[0].enabled, false);
  const out = loadExtensions({ cfg: { extensions: { fake: true } }, builtin: [m] });
  assert.equal(out.list[0].enabled, true);
  assert.deepEqual(out.allowedToolNames, out.tools.map((t) => t.name));
  assert.deepEqual(out.handlers.map((h) => h.type), ['fake-do']);
  assert.deepEqual(out.skillIds, ['fake']);
  assert.deepEqual(out.disabledSkillIds, []);
  assert.equal(out.graphContributors.length, 1);
  assert.equal(out.graphContributors[0].id, 'fake');
  const stores = Object.fromEntries(Object.entries(out.stores).map(([k, f]) => [k, f()]));
  assert.deepEqual(out.graphContributors[0].contribute({ host: { stores } }), { fakes: { n: 1 } });
  assert.equal(out.sessionHooks.onPurge.length, 1);
  assert.deepEqual(out.sessionHooks.onArchive, []);
});

test('assertGraphKeys refuses a reserved core graph key and a non-object contribution', () => {
  assertGraphKeys('fake', { fakes: 1 });
  for (const k of ['sessions', 'tasks', 'schedules', 'history', 'extensions']) {
    assert.ok(RESERVED_GRAPH_KEYS.has(k));
    assert.throws(() => assertGraphKeys('fake', { [k]: 1 }), new RegExp(`Extension fake: graph key "${k}" is reserved`));
  }
  assert.throws(() => assertGraphKeys('fake', null), /must return an object/);
});

// --- invariants over the REAL builtin set ---

// BUILTIN is empty in this PoC: the API lands with its seams, no feature
// migrated onto it yet. Asserted rather than assumed — an accidental manifest
// would otherwise silently register tools and handlers on every install, and
// the two tests below (collisions, manifest shape) would quietly pass over an
// empty list without saying so.
test('BUILTIN: ships empty, so every loader output is empty too', () => {
  assert.deepEqual(BUILTIN, []);
  const out = loadExtensions({ cfg: {}, builtin: BUILTIN });
  assert.deepEqual(out.list, []);
  assert.deepEqual(out.tools, []);
  assert.deepEqual(out.handlers, []);
  assert.deepEqual(out.skillIds, []);
  assert.deepEqual(out.disabledSkillIds, []);
  assert.deepEqual(out.graphContributors, []);
  assert.deepEqual(out.clientManifest, []);
  assert.deepEqual(out.stores, {});
  assert.deepEqual(out.dirs, {});
});

test('BUILTIN: no collisions with the core tool/handler registries, and every graph key is unreserved', () => {
  const out = loadExtensions({ cfg: {}, builtin: BUILTIN, coreToolNames: TOOLS.map((t) => t.name), coreHandlerTypes: CONTROL_HANDLERS.map((h) => h.type) });
  const types = out.handlers.map((h) => h.type);
  assert.equal(new Set(types).size, types.length);
  const stores = Object.fromEntries(Object.entries(out.stores).map(([k, f]) => [k, f()]));
  for (const { id, contribute } of out.graphContributors) assertGraphKeys(id, contribute({ stores, graph: {} }));
});

test('BUILTIN: every manifest exports an absolute dir under server/extensions and any client resolves inside its public/', () => {
  for (const ext of BUILTIN) {
    assert.ok(path.isAbsolute(ext.dir), `${ext.id} dir must be absolute`);
    assert.ok(ext.dir.startsWith(HERE + path.sep), `${ext.id} dir must live under server/extensions`);
    assert.ok(validateManifest(ext));
  }
});

// Import-direction guard: client-config.js and agent-skills.js import this
// loader, and the agent adapters import THEM — so anything under
// server/extensions/** that reached back into the server core would cycle the
// adapters through the server. Same static-regex technique as
// public/module-syntax.test.js.
test('no module under server/extensions/** imports session-manager, state-reader, tmux-scraper or the server entry', () => {
  const files = [];
  const walk = (dir) => {
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, d.name);
      if (d.isDirectory()) walk(p);
      else if (d.name.endsWith('.js') && !d.name.endsWith('.test.js')) files.push(p);
    }
  };
  walk(HERE);
  // Just the loader today; the guard is here so the first manifest is covered
  // the day it lands rather than needing this test remembered.
  assert.ok(files.length >= 1, `expected at least the loader, found ${files.length}`);
  // A manifest importing its OWN './x/index.js' is fine; the forbidden index.js
  // is the server entry, reached only by climbing out of server/extensions/.
  // host-api/** is the NON-leaf half of the extensions API: a builder binds the
  // singletons this directory may not touch, so the import direction is one-way
  // and the loader can only ever REPORT `requires` for index.js to build from.
  // The very array external.js's runtime scanner uses against an INSTALLED
  // extension, imported rather than copied so the two cannot drift.
  const forbidden = FORBIDDEN_IMPORTS;
  const offenders = [];
  for (const f of files) {
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      if (/^\s*import\b/.test(line) && forbidden.some((re) => re.test(line))) offenders.push(`${path.relative(HERE, f)}: ${line.trim()}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test('getExtensions() memoises and _resetExtensionsForTests() clears', () => {
  _resetExtensionsForTests();
  const a = getExtensions({ cfg: {}, builtin: [manifest()] });
  const b = getExtensions({ cfg: {}, builtin: [] });
  assert.equal(a, b, 'the second call returns the first result regardless of its arguments');
  assert.deepEqual(a.list.map((e) => e.id), ['fake']);
  _resetExtensionsForTests();
  const c = getExtensions({ cfg: {}, builtin: [] });
  assert.notEqual(c, a);
  assert.deepEqual(c.list, []);
  _resetExtensionsForTests();
});

test('extensionsForGraph re-reads `enabled` per call, so a toggle lands on the next tick', () => {
  const loaded = loadExtensions({ cfg: { extensions: { fake: true } }, builtin: [manifest()] });
  assert.deepEqual(loaded.list.map((e) => e.enabled), [true], 'boot snapshot');

  // The config as it stands AFTER the toggle wrote it — the boot snapshot cannot
  // see this, which is the whole reason the graph reads it live.
  let enabled = false;
  const rows = extensionsForGraph(loaded.list, () => enabled);
  assert.deepEqual(rows.map((e) => e.enabled), [false]);
  enabled = true;
  assert.deepEqual(extensionsForGraph(loaded.list, () => enabled).map((e) => e.enabled), [true]);
});

test('extensionsForGraph reports the boot value alongside the live one', () => {
  // The pair is what the settings note reads: live, hidden-now, or the one case
  // (on in config, off at boot) that a restart has to finish.
  const booted = loadExtensions({ cfg: { extensions: { fake: false } }, builtin: [manifest()] });
  const [row] = extensionsForGraph(booted.list, () => true);
  assert.deepEqual({ enabled: row.enabled, bootEnabled: row.bootEnabled }, { enabled: true, bootEnabled: false });

  const live = loadExtensions({ cfg: { extensions: { fake: true } }, builtin: [manifest()] });
  assert.deepEqual(extensionsForGraph(live.list, () => false).map((e) => [e.enabled, e.bootEnabled]), [[false, true]]);
});

test('extensionsForGraph carries identity off the boot snapshot, never the live read', () => {
  const loaded = loadExtensions({ cfg: {}, builtin: [manifest()] });
  const [row] = extensionsForGraph(loaded.list, () => true);
  assert.deepEqual(
    { id: row.id, label: row.label, help: row.help, defaultEnabled: row.defaultEnabled },
    { id: 'fake', label: loaded.list[0].label, help: loaded.list[0].help, defaultEnabled: loaded.list[0].defaultEnabled },
  );
});

test('extensionsForGraph defaults to the real config reader', () => {
  const loaded = loadExtensions({ cfg: {}, builtin: [manifest()] });
  // defaultEnabled is falsy on the fake manifest and nothing is in config.json,
  // so the live reader must agree with the snapshot rather than throw.
  assert.deepEqual(extensionsForGraph(loaded.list).map((e) => e.enabled), [Boolean(loaded.list[0].defaultEnabled)]);
});


// ── Store/sweep core deps ─────────────────────────────────────────────────
test('a store factory is handed the core deps bag rather than called bare', () => {
  let got = null;
  const loaded = loadExtensions({ cfg: {}, builtin: [manifest({ stores: { s: (deps) => { got = deps; return { deps }; } } })] });
  const core = { sessionManager: {}, taskStore: {}, memoryStore: {} };
  const built = Object.fromEntries(Object.entries(loaded.stores).map(([k, f]) => [k, f({ core })]));
  assert.equal(got.core, core, 'a runner-backed store cannot be constructed without them');
  assert.equal(built.s.deps.core, core);
});

// ── Per-launch skill gating ───────────────────────────────────────────────
test('createSkillGate returns the declared skills a gate left out, and only those', () => {
  const loaded = loadExtensions({
    cfg: {},
    builtin: [manifest({ skills: ['alpha', 'beta'], skillsFor: ({ phase }) => (phase === 'dispatch' ? ['alpha'] : ['alpha', 'beta']) })],
  });
  const gate = createSkillGate(loaded);
  assert.deepEqual(gate({ phase: 'dispatch' }), ['beta']);
  assert.deepEqual(gate({ phase: 'resume' }), []);
});

test('createSkillGate hands the gate its own declared skills plus its OWN facade', () => {
  const seen = [];
  const asked = [];
  const host = { id: 'fake' };
  const loaded = loadExtensions({ cfg: {}, builtin: [manifest({ skills: ['alpha'], skillsFor: (ctx) => { seen.push(ctx); return ctx.skills; } })] });
  createSkillGate(loaded, (extId) => { asked.push(extId); return host; })({ sessionId: 'CARD1', phase: 'resume' });
  assert.deepEqual(seen[0].skills, ['alpha']);
  assert.equal(seen[0].host, host);
  assert.equal(seen[0].stores, undefined, 'the shared bag is gone');
  assert.equal(seen[0].core, undefined);
  assert.equal(seen[0].sessionId, 'CARD1');
  assert.deepEqual(asked, ['fake'], 'the facade is looked up by the OWNING extension id');
});

test('createSkillGate cannot suppress a skill the extension did not declare', () => {
  // The gate's answer is intersected with its own `skills`, so naming someone
  // else's skill (or task-memory, which is not an extension at all) does nothing.
  const loaded = loadExtensions({ cfg: {}, builtin: [manifest({ skills: ['alpha'], skillsFor: () => [] })] });
  assert.deepEqual(createSkillGate(loaded)({}), ['alpha']);
});

test('a throwing gate suppresses nothing and is reported', () => {
  const errs = [];
  const loaded = loadExtensions({ cfg: {}, builtin: [manifest({ skills: ['alpha'], skillsFor: () => { throw new Error('boom'); } })] });
  assert.deepEqual(createSkillGate(loaded, undefined, (...a) => errs.push(a))({}), [], 'a bug here must not strip a real launch');
  assert.match(errs[0][0], /\[ext:fake\] skillsFor failed/);
});

test('no gate at all means no per-launch suppression', () => {
  assert.deepEqual(createSkillGate(loadExtensions({ cfg: {}, builtin: [manifest({ skills: ['alpha'] })] }))({}), []);
});

// ── Per-caller MCP tool filtering ─────────────────────────────────────────
test('createToolFilter is null when no manifest declares a veto', () => {
  assert.equal(createToolFilter(loadExtensions({ cfg: {}, builtin: [manifest()] })), null);
});

test('createToolFilter vetoes per caller and tool', () => {
  const loaded = loadExtensions({ cfg: {}, builtin: [manifest({ hideTool: ({ caller, tool }) => caller === 'JOB1' && tool === 'spawn_session' })] });
  const hide = createToolFilter(loaded);
  assert.equal(hide('JOB1', 'spawn_session'), true);
  assert.equal(hide('JOB1', 'list_sessions'), false);
  assert.equal(hide('CARD1', 'spawn_session'), false);
});

test('a throwing veto fails OPEN and is reported', () => {
  const errs = [];
  const loaded = loadExtensions({ cfg: {}, builtin: [manifest({ hideTool: () => { throw new Error('boom'); } })] });
  assert.equal(createToolFilter(loaded, undefined, (...a) => errs.push(a))('CARD1', 'list_sessions'), false);
  assert.match(errs[0][0], /\[ext:fake\] hideTool failed/);
});

test('a disabled extension contributes neither a gate nor a veto', () => {
  const off = loadExtensions({ cfg: { extensions: { fake: false } }, builtin: [manifest({ skills: ['alpha'], skillsFor: () => [], hideTool: () => true })] });
  assert.deepEqual(off.skillGates, []);
  assert.equal(createToolFilter(off), null);
});

// ── Manifest validation for the new keys ──────────────────────────────────
test('skillsFor and hideTool must be functions', () => {
  assert.throws(() => validateManifest(manifest({ skillsFor: 'yes' })), /skillsFor must be a function/);
  assert.throws(() => validateManifest(manifest({ hideTool: 1 })), /hideTool must be a function/);
});

test('onBeforeDispatch is a known session hook', () => {
  assert.ok(SESSION_HOOKS.includes('onBeforeDispatch'));
  const loaded = loadExtensions({ cfg: {}, builtin: [manifest({ session: { onBeforeDispatch: () => {} } })] });
  assert.equal(loaded.sessionHooks.onBeforeDispatch.length, 1);
});

// ── Stylesheet asset ──────────────────────────────────────────────────────
test('styles is path-checked exactly like client and announced beside it', () => {
  assert.throws(() => validateManifest(manifest({ styles: '../../etc/x.css' }), { dir: HERE }), /styles ".*" must resolve inside/);
  const loaded = loadExtensions({ cfg: {}, builtin: [manifest({ dir: HERE, client: 'public/index.js', styles: 'public/jobs.css' })] });
  assert.deepEqual(loaded.clientManifest, [{ id: 'fake', client: '/ext/fake/index.js', styles: '/ext/fake/jobs.css', handlerTypes: ['fake-do'] }]);
});

test('an extension may ship styles with no client module', () => {
  const loaded = loadExtensions({ cfg: {}, builtin: [manifest({ dir: HERE, styles: 'public/jobs.css' })] });
  assert.deepEqual(loaded.clientManifest, [{ id: 'fake', styles: '/ext/fake/jobs.css', handlerTypes: ['fake-do'] }]);
});

// -- requires / engines.wranglerApi ----------------------------------------
test('requires must be an array of known capability names', () => {
  rejects(manifest({ requires: 'board:rebuild' }), /Extension fake: requires must be an array of capability names/);
  rejects(manifest({ requires: [1] }), /requires must be an array of capability names/);
  rejects(manifest({ requires: ['board:teleport'] }), /Extension fake: unknown capability "board:teleport" \(known: /);
  assert.ok(validateManifest(manifest({ requires: [...CAPABILITIES] })));
});

test('the capability vocabulary is closed and carried onto the list entry', () => {
  assert.ok(CAPABILITIES.has('board:rebuild'));
  const out = loadExtensions({ cfg: {}, builtin: [manifest({ requires: ['board:rebuild'], engines: { wranglerApi: '^1.0.0' } })] });
  assert.deepEqual(out.list[0].requires, ['board:rebuild']);
  assert.equal(out.list[0].range, '^1.0.0');
  assert.deepEqual(out.list[0].storeNames, ['fake']);
});

test('engines.wranglerApi must be a valid semver RANGE; satisfaction is buildHostApi\'s call', () => {
  rejects(manifest({ engines: { wranglerApi: 'whenever' } }), /Extension fake: engines.wranglerApi must be a valid semver range/);
  rejects(manifest({ engines: { wranglerApi: 5 } }), /must be a valid semver range/);
  // A range this server could never satisfy is still SHAPE-valid here: the
  // loader does not know the served version.
  assert.ok(validateManifest(manifest({ engines: { wranglerApi: '^99.0.0' } })));
});

test('tools, handlers and session hooks come out tagged with their owning extension', () => {
  const out = loadExtensions({ cfg: {}, builtin: [manifest({ session: { onPurge() {} } })] });
  assert.deepEqual(out.tools.map((t) => t.extId), ['fake']);
  assert.deepEqual(out.handlers.map((h) => h.extId), ['fake']);
  assert.deepEqual(out.sessionHooks.onPurge.map((h) => h.extId), ['fake']);
  assert.equal(typeof out.sessionHooks.onPurge[0].fn, 'function');
});

test('extensionsForGraph carries each extension\'s own handler types', () => {
  const out = loadExtensions({ cfg: {}, builtin: [manifest()] });
  assert.deepEqual(extensionsForGraph(out.list, () => true)[0].handlerTypes, ['fake-do']);
});

test('a handler-less extension omits handlerTypes from its announcement entry', () => {
  const out = loadExtensions({ cfg: {}, builtin: [manifest({ client: 'public/index.js', handlers: [] })] });
  assert.deepEqual(out.clientManifest, [{ id: 'fake', client: '/ext/fake/index.js' }]);
});

test('primeExtensions throws if the memo is already set — the ordering guard', async () => {
  _resetExtensionsForTests();
  getExtensions({ cfg: {}, builtin: [] });
  await assert.rejects(
    () => primeExtensions({ cfg: {}, builtin: [], discover: async () => [] }),
    /already loaded/,
    'a consumer that got in first would otherwise pin a builtin-only board silently',
  );
  _resetExtensionsForTests();
});

test('getExtensions() after priming returns builtins AND externals', async () => {
  _resetExtensionsForTests();
  assert.equal(extensionsPrimed(), false);
  const installed = { id: 'installed', label: 'Installed', external: true, dir: '/tmp/installed', provenance: { id: 'installed', originUrl: 'https://example.invalid/x.git', sha: 'abc123' } };
  const primedOut = await primeExtensions({ cfg: {}, builtin: [manifest()], discover: async () => [installed] });
  assert.equal(extensionsPrimed(), true);
  assert.deepEqual(primedOut.list.map((e) => [e.id, e.external]), [['fake', false], ['installed', true]]);
  // The whole point of the separate async door: the synchronous consumers the
  // adapters use now see the installed extension too, with no signature change.
  assert.equal(getExtensions(), primedOut);
  const forGraph = extensionsForGraph(primedOut.list, () => true).find((e) => e.id === 'installed');
  assert.equal(forGraph.origin, 'https://example.invalid/x.git');
  assert.equal(forGraph.sha, 'abc123');
  _resetExtensionsForTests();
  assert.equal(extensionsPrimed(), false);
});

test('a bad BUILTIN quarantines too, and the good one beside it loads', () => {
  const out = loadExtensions({ cfg: {}, builtin: [manifest({ id: 'broken', label: '', tools: [], handlers: [], stores: {} }), manifest()] });
  assert.deepEqual(out.list.map((e) => [e.id, Boolean(e.quarantine), e.external]), [['broken', true, false], ['fake', false, false]]);
  assert.deepEqual(out.tools.map((t) => t.name), ['fake_tool'], 'the healthy extension is unaffected');
  assert.deepEqual(
    extensionsForGraph(out.list, () => true).map((e) => [e.id, e.enabled, e.bootEnabled]),
    [['broken', false, false], ['fake', true, true]],
    'a quarantined entry reports disabled even when config says on',
  );
});

test('an already-quarantined entry (discovery could not read it) becomes a row and nothing else', () => {
  const out = loadExtensions({ cfg: {}, builtin: [{ id: 'dud', external: true, quarantine: 'no index.js' }] });
  assert.deepEqual(out.list, [{
    id: 'dud', label: 'dud', help: '', description: '', author: '', homepage: '',
    defaultEnabled: false, enabled: false, requires: [], range: null, storeNames: [], skills: [],
    handlerTypes: [], external: true, dir: null, provenance: null, quarantine: 'no index.js',
  }]);
  assert.deepEqual(out.tools, []);
});

test('quarantineExtension unregisters a late failure by id, leaving its siblings alone', () => {
  const other = manifest({
    id: 'other', label: 'Other', dir: path.join(HERE, 'other'),
    tools: [{ name: 'other_tool', handler() {} }], handlers: [{ type: 'other-do', handler() {} }],
    stores: { other: () => ({}) }, skills: ['other'], graph: () => ({ others: 1 }), session: { onPurge() {} },
  });
  const out = loadExtensions({
    cfg: {},
    builtin: [manifest({ client: 'public/index.js', sweeps: [{ id: 's', everyMs: 1000, run() {} }], skillsFor: () => [], hideTool: () => false }), other],
  });
  assert.equal(quarantineExtension(out, 'fake', 'unsatisfiable engines.wranglerApi'), 'unsatisfiable engines.wranglerApi');
  const entry = out.list.find((e) => e.id === 'fake');
  assert.equal(entry.enabled, false);
  assert.equal(entry.quarantine, 'unsatisfiable engines.wranglerApi');
  assert.deepEqual(out.tools.map((t) => t.name), ['other_tool']);
  assert.deepEqual(out.allowedToolNames, ['other_tool']);
  assert.deepEqual(out.handlers.map((h) => h.type), ['other-do']);
  assert.deepEqual(Object.keys(out.stores), ['other']);
  assert.deepEqual(out.sweeps, []);
  assert.deepEqual(out.graphContributors.map((g) => g.id), ['other']);
  assert.deepEqual(out.skillGates, []);
  assert.deepEqual(out.toolFilters, []);
  assert.deepEqual(out.clientManifest, []);
  assert.deepEqual(out.sessionHooks.onPurge.map((h) => h.extId), ['other']);
  assert.deepEqual(Object.keys(out.dirs), ['other']);
  // Its skill moves from the enabled list to the disabled one: a quarantined
  // extension's skill must be actively suppressed, not merely unmentioned.
  assert.deepEqual(out.skillIds, ['other']);
  assert.deepEqual(out.disabledSkillIds, ['fake']);
});
