import path from 'node:path';
import semver from 'semver';
import { readConfig, extensionEnabled } from '../config-store.js';

// The in-repo extensions API: one manifest per optional feature, loaded ONCE at
// boot and gated as a unit by `extensions.<id>` in config.json (config-store's
// extensionEnabled, defaulting to the manifest's own `defaultEnabled`). A toggle
// takes effect at the next restart — everything here is fixed at load time, and
// the consumers below read the loaded lists, never the config, at call time.
//
// This module is a LEAF and every builtin manifest must stay leaf-compatible: it
// is imported by server/mcp/client-config.js and server/agent-skills.js, which the
// agent adapters (server/agents/*) import, so nothing under server/extensions/**
// may import session-manager / state-reader / tmux-scraper / index.js / the
// host-api/ directory (asserted by index.test.js). A manifest's tools, handlers,
// hooks and sweeps therefore reach the server only through the per-extension
// `host` façade they are handed, built by server/index.js from this loader's
// `requires` list — the loader itself cannot build one, since a builder binds
// singletons it may not import. `semver` below is an npm package, not a server
// module, so importing it breaches nothing: the leaf rule is about reaching back
// into the server core, not about third-party code.
//
// Empty for now: this lands the API and its seams, with no feature migrated onto
// it yet. Nothing here is dead — every consumer below already routes through the
// loader's (currently empty) lists, so the first manifest is a one-line addition
// to this array plus its own directory.
export const BUILTIN = [];

// Every graph key rebuildOnce (server/index.js) sets itself. A contributor
// colliding with one would silently overwrite core state on every ~4s tick,
// where nothing may log — so it is refused at boot instead (assertGraphKeys,
// run by index.js against the real stores once they exist).
export const RESERVED_GRAPH_KEYS = new Set([
  'nodes', 'edges', 'sessions', 'history', 'generatedAt', 'tasks', 'schedules', 'extensions',
  'checklists', 'checklistEnabled', 'taskMemoryEnabled', 'subagentsExpandedByDefault', 'trustCodexLaunchCwd', 'childFullViewByDefault',
  'autoFixPrChecksDefault', 'archiveReviewEnabled', 'chatViewDefault',
]);

// `onBeforeDispatch` is the one hook that runs while the session does not yet
// exist anywhere: it fires after dispatch has settled the card id, cwd and
// worktree but BEFORE the launch command is built and the pane started, which
// is the only window in which an extension can persist state that the agent's
// very first tool call may already depend on. `onDispatch` fires after the
// entry is saved — correct for anything reacting to a new card, too late for an
// invariant the launched process itself relies on.
// The CLOSED capability vocabulary a manifest's `requires` is drawn from. It
// lives HERE rather than beside the builders because the loader validates
// `requires` at manifest-load time and cannot import the non-leaf host-api/.
// host-api/index.test.js asserts V1_BUILDERS' keys and this set match in BOTH
// directions — that test is what keeps the two in step without an import, so a
// new capability is a two-file change by design.
export const CAPABILITIES = new Set([
  'sessions:read', 'sessions:wake', 'sessions:archive', 'sessions:spawn', 'sessions:kill',
  'tasks:read', 'tasks:write',
  'memory:read', 'memory:append',
  'deliver',
  'board:rebuild', 'board:broadcast',
  'terminals:create',
  'schedules:read', 'schedules:write',
  'mail:read', 'mail:send',
]);

export const SESSION_HOOKS = ['onBeforeDispatch', 'onArchive', 'onFork', 'onPurge', 'onDispatch', 'onResume'];
export const LAUNCH_PHASES = ['dispatch', 'resume', 'fork'];
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
  // What of the host façade this manifest gets. An undeclared capability's key
  // is structurally absent, so a typo here is a TypeError deep in a tool rather
  // than anything a human would connect back to the manifest — refuse at boot.
  if (ext.requires != null) {
    if (!Array.isArray(ext.requires) || ext.requires.some((c) => typeof c !== 'string' || !c)) {
      fail(ext, 'requires must be an array of capability names');
    }
    for (const c of ext.requires) {
      if (!CAPABILITIES.has(c)) fail(ext, `unknown capability "${c}" (known: ${[...CAPABILITIES].sort().join(', ')})`);
    }
  }
  // The host API range this manifest was written against. Only its SHAPE is
  // checked here — whether the served version satisfies it is buildHostApi's
  // call, since this leaf does not know what version is served. Duplicated
  // one-liner, deliberately: see host-api/version.js isValidRange.
  if (ext.engines?.wranglerApi != null) {
    const range = ext.engines.wranglerApi;
    if (typeof range !== 'string' || semver.validRange(range) == null) {
      fail(ext, 'engines.wranglerApi must be a valid semver range');
    }
  }
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
  if (ext.skillsFor != null && typeof ext.skillsFor !== 'function') fail(ext, 'skillsFor must be a function');
  if (ext.hideTool != null && typeof ext.hideTool !== 'function') fail(ext, 'hideTool must be a function');
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
  // `client` and `styles` are the two asset paths, checked identically: both are
  // served by the /ext/<id>/ static route, so both must resolve under the
  // manifest's own public/ and nowhere else.
  for (const key of ['client', 'styles']) {
    if (ext[key] == null) continue;
    if (typeof ext[key] !== 'string' || !ext[key]) fail(ext, `${key} must be a relative path string`);
    if (typeof dir !== 'string' || !path.isAbsolute(dir)) fail(ext, `${key} requires the manifest to export its absolute \`dir\``);
    const base = path.resolve(dir);
    const pubDir = path.join(base, 'public');
    const resolved = path.resolve(base, ext[key]);
    if (!resolved.startsWith(base + path.sep) || !resolved.startsWith(pubDir + path.sep)) {
      fail(ext, `${key} "${ext[key]}" must resolve inside ${pubDir}`);
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
//
// `bootEnabled` is that boot value, carried separately so the settings toggle can
// tell a human WHICH of those two worlds they are in. The pair is the whole state
// space: enabled && bootEnabled is live; !enabled is hidden now with a running
// session's tools following at its next resume; enabled && !bootEnabled is the one
// case nothing can finish without a restart, and saying so is the only way a human
// tells it apart from a toggle that silently did nothing.
//
// `handlerTypes` is the one addition the client half needs rather than the
// human: the browser façade binds an extension's `send` to its OWN registered
// types (public/slots.js), so this array is what makes that possible. Boot-fixed
// and a handful of short strings per extension — nowhere near graph.history's
// problem — and deliberately off the per-card path.
export function extensionsForGraph(list, enabledFor = extensionEnabled) {
  return list.map(({ id, label, help, defaultEnabled, enabled: bootEnabled, handlerTypes }) => ({
    id, label, help, defaultEnabled, bootEnabled, enabled: enabledFor(id, defaultEnabled),
    handlerTypes: [...(handlerTypes || [])],
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
    skillGates: [],
    toolFilters: [],
    sweeps: [],
    clientManifest: [],
    dirs: {},
  };
  for (const ext of builtin) {
    validateManifest(ext);
    if (ids.has(ext.id)) fail(ext, 'duplicate extension id');
    ids.add(ext.id);
    const enabled = extensionEnabled(ext.id, ext.defaultEnabled, cfg);
    // `requires`/`range`/`storeNames` are the façade's build inputs, carried on
    // the list entry because index.js — not this leaf — is what can build one.
    // `handlerTypes` is filled below, as the handlers are collected: it is what
    // tells the BOARD which control types this extension owns, so the client
    // façade's `send` can refuse a frame aimed at anything else.
    const listEntry = {
      id: ext.id,
      label: ext.label,
      help: ext.help || '',
      defaultEnabled: Boolean(ext.defaultEnabled),
      enabled,
      requires: [...(ext.requires || [])],
      range: ext.engines?.wranglerApi ?? null,
      storeNames: Object.keys(ext.stores || {}),
      handlerTypes: [],
    };
    out.list.push(listEntry);
    if (!enabled) {
      out.disabledSkillIds.push(...(ext.skills || []));
      continue;
    }
    for (const t of ext.tools || []) {
      if (toolNames.has(t.name)) fail(ext, `tool name "${t.name}" is already registered`);
      toolNames.add(t.name);
      // Tagged with its owner as it is collected: each frame is invoked with
      // THAT extension's façade, so the tag is how mcp/server.js and
      // control/router.js tell an extension's tool/handler from a core one (an
      // untagged one is core and still gets deps/ctx). Same for handlers and
      // session hooks below — sweeps were already tagged.
      out.tools.push({ ...t, extId: ext.id });
      out.allowedToolNames.push(t.name);
    }
    for (const h of ext.handlers || []) {
      if (handlerTypes.has(h.type)) fail(ext, `handler type "${h.type}" is already registered`);
      handlerTypes.add(h.type);
      out.handlers.push({ ...h, extId: ext.id });
      listEntry.handlerTypes.push(h.type);
    }
    for (const [name, factory] of Object.entries(ext.stores || {})) {
      if (storeNames.has(name)) fail(ext, `store name "${name}" is already registered`);
      storeNames.add(name);
      out.stores[name] = factory;
    }
    out.skillIds.push(...(ext.skills || []));
    // A gate can only ever narrow THIS manifest's own declared skills (its
    // `skills` list is passed back to it and its answer is intersected below),
    // so one extension can never silently suppress another's — nor task-memory's,
    // which is not an extension at all and keeps its own flag.
    if (ext.skillsFor) out.skillGates.push({ id: ext.id, skills: [...(ext.skills || [])], gate: ext.skillsFor });
    if (ext.hideTool) out.toolFilters.push({ id: ext.id, hide: ext.hideTool });
    if (ext.graph) out.graphContributors.push({ id: ext.id, contribute: ext.graph });
    for (const [k, fn] of Object.entries(ext.session || {})) out.sessionHooks[k].push({ extId: ext.id, fn });
    for (const s of ext.sweeps || []) out.sweeps.push({ extId: ext.id, ...s });
    if (ext.dir) out.dirs[ext.id] = ext.dir;
    // Omitted rather than nulled when absent, so the announcement a stock
    // install sends is byte-identical to the pre-styles one.
    if (ext.client || ext.styles) {
      out.clientManifest.push({
        id: ext.id,
        ...(ext.client ? { client: extAssetUrl(ext.id, ext.client) } : {}),
        ...(ext.styles ? { styles: extAssetUrl(ext.id, ext.styles) } : {}),
      });
    }
  }
  return out;
}

function extAssetUrl(id, rel) {
  return `/ext/${id}/${path.posix.relative('public', rel.split(path.sep).join('/'))}`;
}

// Per-launch skill gating. The manifest-level `skills` list is all-or-nothing
// (a disabled extension's skills drop out of the nudge and the Codex catalog for
// every session); a `skillsFor` gate is what makes the same call PER SESSION,
// which is what a feature whose launches are of two kinds — an automation run
// versus an ordinary one — needs, and what `taskMemoryEnabled`'s hand-threaded
// boolean does for the one non-extension case.
//
// Returns the skill names to suppress for THIS launch, which is the direction
// that composes: `agent-skills.js` already filters a global disabled list, and a
// per-launch value threaded alongside `taskMemory` adds nothing new to the
// adapters beyond one more array. A gate that throws suppresses nothing for its
// own extension and never touches another's — a broken gate must not silently
// strip an unrelated feature's skill out of a real launch.
// `hostApiFor(extId)` rather than one shared bag: each gate is called with its
// OWN extension's façade, so a gate reads only what its manifest declared.
export function createSkillGate(ext, hostApiFor = () => undefined, onError = () => {}) {
  return function disabledSkillsFor(context = {}) {
    const out = [];
    for (const { id, skills, gate } of ext.skillGates) {
      let keep;
      try {
        keep = gate({ ...context, host: hostApiFor(id), skills: [...skills] });
      } catch (err) {
        onError(`[ext:${id}] skillsFor failed`, err);
        continue;
      }
      const kept = new Set(Array.isArray(keep) ? keep : skills);
      for (const name of skills) if (!kept.has(name)) out.push(name);
    }
    return out;
  };
}

// Per-caller MCP tool visibility. Unlike every other extension surface this one
// shapes tools an extension does NOT own — the point is a session KIND (a job
// run, say) that must not see `spawn_session` — so it is a veto, not a rewrite:
// a filter answers true to hide one named tool from one caller, and the tool
// stays listed unless some filter says otherwise.
//
// Fails OPEN by design. A throwing filter hides nothing and is logged: this is a
// UX narrowing on an advisory identity (extractCaller is not authentication —
// see server/mcp/server.js), so a bug here must degrade to the full tool list
// rather than silently leaving every session unable to do anything.
export function createToolFilter(ext, hostApiFor = () => undefined, onError = () => {}) {
  if (!ext.toolFilters.length) return null;
  return function hideTool(caller, toolName) {
    for (const { id, hide } of ext.toolFilters) {
      try {
        if (hide({ host: hostApiFor(id), caller, tool: toolName })) return true;
      } catch (err) {
        onError(`[ext:${id}] hideTool failed`, err);
      }
    }
    return false;
  };
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
