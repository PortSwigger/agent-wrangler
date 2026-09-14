import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BUILTIN, RESERVED_GRAPH_KEYS, SESSION_HOOKS,
  validateManifest, assertGraphKeys, loadExtensions, getExtensions, extensionsForGraph,
  createSkillGate, createToolFilter, _resetExtensionsForTests,
} from './index.js';
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
    graph: ({ stores }) => ({ fakes: stores.fake.snapshot() }),
    session: { onPurge() {} },
    ...overrides,
  };
}

function rejects(ext, re, opts) {
  assert.throws(() => loadExtensions({ cfg: {}, builtin: [ext], ...opts }), re);
}

test('validation failures throw with the extension id in the message', () => {
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

test('duplicate ids, tool names and handler types are refused — within extensions and against the core registries', () => {
  assert.throws(() => loadExtensions({ cfg: {}, builtin: [manifest(), manifest()] }), /Extension fake: duplicate extension id/);
  assert.throws(
    () => loadExtensions({ cfg: {}, builtin: [manifest(), manifest({ id: 'other', handlers: [], stores: {} })] }),
    /Extension other: tool name "fake_tool" is already registered/,
  );
  assert.throws(
    () => loadExtensions({ cfg: {}, builtin: [manifest(), manifest({ id: 'other', tools: [], stores: {} })] }),
    /Extension other: handler type "fake-do" is already registered/,
  );
  assert.throws(
    () => loadExtensions({ cfg: {}, builtin: [manifest(), manifest({ id: 'other', tools: [], handlers: [] })] }),
    /Extension other: store name "fake" is already registered/,
  );
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
  assert.deepEqual(out.clientManifest, [{ id: 'fake', client: '/ext/fake/index.js' }]);
  assert.deepEqual(out.dirs, { fake: path.join(HERE, 'fake') });
});

test('a manifest without `client` contributes nothing to clientManifest', () => {
  assert.deepEqual(loadExtensions({ cfg: {}, builtin: [manifest()] }).clientManifest, []);
});

test('enabled filtering: a disabled extension is listed but contributes nothing except its disabledSkillIds', () => {
  const out = loadExtensions({ cfg: { extensions: { fake: false } }, builtin: [manifest({ client: 'public/index.js', sweeps: [{ id: 's', everyMs: 1000, run() {} }] })] });
  assert.deepEqual(out.list, [{ id: 'fake', label: 'Fake extension', help: 'Does fake things.', defaultEnabled: true, enabled: false }]);
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
  assert.deepEqual(out.graphContributors[0].contribute({ stores }), { fakes: { n: 1 } });
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
  const forbidden = [/\/(session-manager|state-reader|tmux-scraper)\.js['"]/, /from\s+['"](\.\.\/)+index\.js['"]/];
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
  const gate = createSkillGate(loaded, { stores: {}, core: {} });
  assert.deepEqual(gate({ phase: 'dispatch' }), ['beta']);
  assert.deepEqual(gate({ phase: 'resume' }), []);
});

test('createSkillGate hands the gate its own declared skills plus the bound bag', () => {
  const seen = [];
  const bag = { stores: { s: 1 }, core: { sessionManager: 2 } };
  const loaded = loadExtensions({ cfg: {}, builtin: [manifest({ skills: ['alpha'], skillsFor: (ctx) => { seen.push(ctx); return ctx.skills; } })] });
  createSkillGate(loaded, bag)({ sessionId: 'CARD1', phase: 'resume' });
  assert.deepEqual(seen[0].skills, ['alpha']);
  assert.equal(seen[0].stores, bag.stores);
  assert.equal(seen[0].core, bag.core);
  assert.equal(seen[0].sessionId, 'CARD1');
});

test('createSkillGate cannot suppress a skill the extension did not declare', () => {
  // The gate's answer is intersected with its own `skills`, so naming someone
  // else's skill (or task-memory, which is not an extension at all) does nothing.
  const loaded = loadExtensions({ cfg: {}, builtin: [manifest({ skills: ['alpha'], skillsFor: () => [] })] });
  assert.deepEqual(createSkillGate(loaded, {})({}), ['alpha']);
});

test('a throwing gate suppresses nothing and is reported', () => {
  const errs = [];
  const loaded = loadExtensions({ cfg: {}, builtin: [manifest({ skills: ['alpha'], skillsFor: () => { throw new Error('boom'); } })] });
  assert.deepEqual(createSkillGate(loaded, {}, (...a) => errs.push(a))({}), [], 'a bug here must not strip a real launch');
  assert.match(errs[0][0], /\[ext:fake\] skillsFor failed/);
});

test('no gate at all means no per-launch suppression', () => {
  assert.deepEqual(createSkillGate(loadExtensions({ cfg: {}, builtin: [manifest({ skills: ['alpha'] })] }), {})({}), []);
});

// ── Per-caller MCP tool filtering ─────────────────────────────────────────
test('createToolFilter is null when no manifest declares a veto', () => {
  assert.equal(createToolFilter(loadExtensions({ cfg: {}, builtin: [manifest()] }), {}), null);
});

test('createToolFilter vetoes per caller and tool', () => {
  const loaded = loadExtensions({ cfg: {}, builtin: [manifest({ hideTool: ({ caller, tool }) => caller === 'JOB1' && tool === 'spawn_session' })] });
  const hide = createToolFilter(loaded, { stores: {}, core: {} });
  assert.equal(hide('JOB1', 'spawn_session'), true);
  assert.equal(hide('JOB1', 'list_sessions'), false);
  assert.equal(hide('CARD1', 'spawn_session'), false);
});

test('a throwing veto fails OPEN and is reported', () => {
  const errs = [];
  const loaded = loadExtensions({ cfg: {}, builtin: [manifest({ hideTool: () => { throw new Error('boom'); } })] });
  assert.equal(createToolFilter(loaded, {}, (...a) => errs.push(a))('CARD1', 'list_sessions'), false);
  assert.match(errs[0][0], /\[ext:fake\] hideTool failed/);
});

test('a disabled extension contributes neither a gate nor a veto', () => {
  const off = loadExtensions({ cfg: { extensions: { fake: false } }, builtin: [manifest({ skills: ['alpha'], skillsFor: () => [], hideTool: () => true })] });
  assert.deepEqual(off.skillGates, []);
  assert.equal(createToolFilter(off, {}), null);
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
  assert.deepEqual(loaded.clientManifest, [{ id: 'fake', client: '/ext/fake/index.js', styles: '/ext/fake/jobs.css' }]);
});

test('an extension may ship styles with no client module', () => {
  const loaded = loadExtensions({ cfg: {}, builtin: [manifest({ dir: HERE, styles: 'public/jobs.css' })] });
  assert.deepEqual(loaded.clientManifest, [{ id: 'fake', styles: '/ext/fake/jobs.css' }]);
});
