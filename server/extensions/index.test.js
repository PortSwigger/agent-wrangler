import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BUILTIN, RESERVED_GRAPH_KEYS, SESSION_HOOKS,
  validateManifest, assertGraphKeys, loadExtensions, getExtensions, extensionsForGraph, _resetExtensionsForTests,
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

test('BUILTIN: the checklist ships enabled by default with its four tools granted and no client yet', () => {
  const out = loadExtensions({ cfg: {}, builtin: BUILTIN });
  assert.deepEqual(out.list.map((e) => [e.id, e.enabled]), [['checklist', true]]);
  assert.deepEqual(out.tools.map((t) => t.name).sort(), ['add_checklist_item', 'list_checklist', 'remove_checklist_item', 'update_checklist_item']);
  assert.deepEqual([...out.allowedToolNames].sort(), out.tools.map((t) => t.name).sort());
  assert.deepEqual(out.handlers.map((h) => h.type).sort(), ['checklist-add', 'checklist-remove', 'checklist-reorder', 'checklist-update']);
  assert.deepEqual(out.skillIds, ['checklist']);
  // The help text is the only place a human is told the two halves move at
  // different times: the panel goes on the next tick, the tools at next resume.
  assert.match(out.list[0].help, /hides the panel straight away/);
  assert.match(out.list[0].help, /at its next resume/);
});

test('BUILTIN: cfg.extensions.checklist=false empties every channel and marks the skill disabled', () => {
  const out = loadExtensions({ cfg: { extensions: { checklist: false } }, builtin: BUILTIN });
  assert.equal(out.list[0].enabled, false);
  assert.deepEqual(out.tools, []);
  assert.deepEqual(out.handlers, []);
  assert.deepEqual(out.skillIds, []);
  assert.deepEqual(out.graphContributors, []);
  assert.deepEqual(out.clientManifest, []);
  assert.ok(out.disabledSkillIds.includes('checklist'));
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
  assert.ok(files.length >= 8, `expected the loader plus the checklist's modules, found ${files.length}`);
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
