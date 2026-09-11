import path from 'node:path';
import { readConfig, extensionEnabled } from '../config-store.js';
import checklistExtension from './checklist/index.js';

// The in-repo extensions API: one manifest per optional feature, loaded ONCE at
// boot and gated as a unit by `extensions.<id>` in config.json (config-store's
// extensionEnabled, defaulting to the manifest's own `defaultEnabled`). A toggle
// takes effect at the next restart — everything here is fixed at load time, and
// the consumers below read the loaded lists, never the config, at call time.
//
// This module is a LEAF and every builtin manifest must stay leaf-compatible: it
// is imported by server/mcp/client-config.js and server/agent-skills.js, which the
// agent adapters (server/agents/*) import, so nothing under server/extensions/**
// may import session-manager / state-reader / tmux-scraper / index.js (asserted
// by index.test.js). A manifest's tools/handlers/stores therefore reach the
// server only through the `deps`/`ctx` bags they are handed (`deps.ext.stores`,
// `ctx.ext.stores`), the same way core tools reach sessionManager.
export const BUILTIN = [checklistExtension];

// Every graph key rebuildOnce (server/index.js) sets itself. A contributor
// colliding with one would silently overwrite core state on every ~4s tick,
// where nothing may log — so it is refused at boot instead (assertGraphKeys,
// run by index.js against the real stores once they exist).
export const RESERVED_GRAPH_KEYS = new Set([
  'nodes', 'edges', 'sessions', 'history', 'generatedAt', 'tasks', 'schedules', 'extensions',
  'taskMemoryEnabled', 'subagentsExpandedByDefault', 'trustCodexLaunchCwd', 'childFullViewByDefault',
  'autoFixPrChecksDefault', 'archiveReviewEnabled', 'chatViewDefault',
]);

export const SESSION_HOOKS = ['onArchive', 'onFork', 'onPurge', 'onDispatch', 'onResume'];
const ID_RE = /^[a-z][a-z0-9-]*$/;

function fail(ext, reason) {
  const id = ext && typeof ext.id === 'string' ? ext.id : '<no id>';
  throw new Error(`Extension ${id}: ${reason}`);
}

// Throws (naming the extension) on any manifest shape the rest of the server
// would otherwise misread silently. `dir` is the manifest module's own directory
// (it exports it from import.meta.url) — the only thing a `client` path may
// resolve inside, and only under its public/ subdir, since that is what the
// /ext/<id>/ static route will serve.
export function validateManifest(ext, { dir = ext?.dir } = {}) {
  if (!ext || typeof ext !== 'object') throw new Error('Extension <no id>: manifest is not an object');
  if (typeof ext.id !== 'string' || !ID_RE.test(ext.id)) fail(ext, `id must match ${ID_RE} (got ${JSON.stringify(ext.id)})`);
  if (typeof ext.label !== 'string' || !ext.label) fail(ext, 'label must be a non-empty string');
  if (ext.help != null && typeof ext.help !== 'string') fail(ext, 'help must be a string');
  if (ext.stores != null) {
    if (typeof ext.stores !== 'object') fail(ext, 'stores must be an object of factories');
    for (const [name, factory] of Object.entries(ext.stores)) {
      if (typeof factory !== 'function') fail(ext, `stores.${name} must be a factory function`);
    }
  }
  for (const [i, t] of (ext.tools || []).entries()) {
    if (!t || typeof t.name !== 'string' || !t.name) fail(ext, `tools[${i}] has no name`);
    if (typeof t.handler !== 'function') fail(ext, `tool ${t.name} has no handler function`);
  }
  for (const [i, h] of (ext.handlers || []).entries()) {
    if (!h || typeof h.type !== 'string' || !h.type) fail(ext, `handlers[${i}] has no type`);
    if (typeof h.handler !== 'function') fail(ext, `handler ${h.type} has no handler function`);
  }
  for (const [i, s] of (ext.skills || []).entries()) {
    if (typeof s !== 'string' || !s) fail(ext, `skills[${i}] must be a skill name`);
  }
  if (ext.graph != null && typeof ext.graph !== 'function') fail(ext, 'graph must be a function');
  if (ext.session != null) {
    if (typeof ext.session !== 'object') fail(ext, 'session must be an object of hooks');
    for (const [k, fn] of Object.entries(ext.session)) {
      if (!SESSION_HOOKS.includes(k)) fail(ext, `unknown session hook "${k}" (known: ${SESSION_HOOKS.join(', ')})`);
      if (typeof fn !== 'function') fail(ext, `session.${k} must be a function`);
    }
  }
  for (const [i, s] of (ext.sweeps || []).entries()) {
    if (!s || typeof s.id !== 'string' || !s.id) fail(ext, `sweeps[${i}] has no id`);
    if (!(typeof s.everyMs === 'number' && Number.isFinite(s.everyMs) && s.everyMs > 0)) fail(ext, `sweep ${s.id} everyMs must be a positive finite number`);
    if (typeof s.run !== 'function') fail(ext, `sweep ${s.id} has no run function`);
  }
  if (ext.client != null) {
    if (typeof ext.client !== 'string' || !ext.client) fail(ext, 'client must be a relative path string');
    if (typeof dir !== 'string' || !path.isAbsolute(dir)) fail(ext, 'client requires the manifest to export its absolute `dir`');
    const base = path.resolve(dir);
    const pubDir = path.join(base, 'public');
    const resolved = path.resolve(base, ext.client);
    if (!resolved.startsWith(base + path.sep) || !resolved.startsWith(pubDir + path.sep)) {
      fail(ext, `client "${ext.client}" must resolve inside ${pubDir}`);
    }
  }
  return true;
}

// What `graph.extensions` carries every rebuild. Identity/label/help/defaultEnabled
// come from the boot snapshot (they cannot change without a restart), but `enabled`
// is re-read from config on EVERY call — the settings toggle has to take an
// extension's UI off the board on the next tick rather than at the next restart,
// which is what the pre-extensions per-tick `graph.checklistEnabled` read did.
// Only the UI moves: tools, handlers, stores and graph contributors were all fixed
// by loadExtensions, so an extension that booted OFF stays off until a restart.
export function extensionsForGraph(list, enabledFor = extensionEnabled) {
  return list.map(({ id, label, help, defaultEnabled }) => ({
    id, label, help, defaultEnabled, enabled: enabledFor(id, defaultEnabled),
  }));
}

// Boot-time check for a graph contributor's keys, run once against the real
// stores (index.js) rather than every tick — see RESERVED_GRAPH_KEYS.
export function assertGraphKeys(id, contribution) {
  if (!contribution || typeof contribution !== 'object') throw new Error(`Extension ${id}: graph contributor must return an object`);
  for (const k of Object.keys(contribution)) {
    if (RESERVED_GRAPH_KEYS.has(k)) throw new Error(`Extension ${id}: graph key "${k}" is reserved by the core graph`);
  }
}

// `coreToolNames`/`coreHandlerTypes` are the core registries' names, passed in by
// index.js (this leaf cannot import the registries — they pull in
// session-manager). An adapter's memoised call passes none, which is fine: the
// cross-registry check only has to run once, at boot, and index.js runs first.
export function loadExtensions({ cfg = readConfig(), builtin = BUILTIN, coreToolNames = [], coreHandlerTypes = [] } = {}) {
  const ids = new Set();
  const toolNames = new Set(coreToolNames);
  const handlerTypes = new Set(coreHandlerTypes);
  const storeNames = new Set();
  const out = {
    list: [],
    stores: {},
    handlers: [],
    tools: [],
    allowedToolNames: [],
    skillIds: [],
    disabledSkillIds: [],
    graphContributors: [],
    sessionHooks: Object.fromEntries(SESSION_HOOKS.map((k) => [k, []])),
    sweeps: [],
    clientManifest: [],
    dirs: {},
  };
  for (const ext of builtin) {
    validateManifest(ext);
    if (ids.has(ext.id)) fail(ext, 'duplicate extension id');
    ids.add(ext.id);
    const enabled = extensionEnabled(ext.id, ext.defaultEnabled, cfg);
    out.list.push({ id: ext.id, label: ext.label, help: ext.help || '', defaultEnabled: Boolean(ext.defaultEnabled), enabled });
    if (!enabled) {
      out.disabledSkillIds.push(...(ext.skills || []));
      continue;
    }
    for (const t of ext.tools || []) {
      if (toolNames.has(t.name)) fail(ext, `tool name "${t.name}" is already registered`);
      toolNames.add(t.name);
      out.tools.push(t);
      out.allowedToolNames.push(t.name);
    }
    for (const h of ext.handlers || []) {
      if (handlerTypes.has(h.type)) fail(ext, `handler type "${h.type}" is already registered`);
      handlerTypes.add(h.type);
      out.handlers.push(h);
    }
    for (const [name, factory] of Object.entries(ext.stores || {})) {
      if (storeNames.has(name)) fail(ext, `store name "${name}" is already registered`);
      storeNames.add(name);
      out.stores[name] = factory;
    }
    out.skillIds.push(...(ext.skills || []));
    if (ext.graph) out.graphContributors.push({ id: ext.id, contribute: ext.graph });
    for (const [k, fn] of Object.entries(ext.session || {})) out.sessionHooks[k].push(fn);
    for (const s of ext.sweeps || []) out.sweeps.push({ extId: ext.id, ...s });
    if (ext.dir) out.dirs[ext.id] = ext.dir;
    if (ext.client) out.clientManifest.push({ id: ext.id, client: `/ext/${ext.id}/${path.posix.relative('public', ext.client.split(path.sep).join('/'))}` });
  }
  return out;
}

// Memoised so the leaf consumers (client-config.js, agent-skills.js,
// tools/index.js, control/router.js) can derive their lists with no threading
// through index.js — which calls this FIRST at boot, with the core registry
// names, so the server and the adapters read one and the same object. Every
// consumer keeps an injectable `{ ext }` so tests never touch this memo.
let memo = null;
export function getExtensions(opts) {
  if (!memo) memo = loadExtensions(opts);
  return memo;
}

export function _resetExtensionsForTests() {
  memo = null;
}
