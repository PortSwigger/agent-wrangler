import path from 'node:path';
import semver from 'semver';
import { readConfig, extensionEnabled, extensionSettings } from '../config-store.js';
import { SKILLS_ROOT, skillAt, skillsIn } from '../skill-catalog.js';
import { validateSettingDef } from './setting-constraints.js';

// The extensions API: one manifest per optional feature, gated as a unit by
// `extensions.<id>` in config.json (config-store's extensionEnabled, defaulting
// to the manifest's own `defaultEnabled`). The loaded object is a LIVE REGISTRY,
// not a boot snapshot: `loadExtensions` fills it once and `registerExtension` /
// `unregisterExtension` mutate that same object afterwards, so an install or a
// settings flip takes effect in-process. Every consumer below reads the object's
// fields at CALL time, which is what makes mutating it in place enough — and why
// nothing may ever REASSIGN `loaded.list` (server/index.js and the control
// handlers hold that array by reference).
//
// What a live change cannot do is unload code: Node keeps an imported module
// forever, so an uninstall deregisters and deactivates but the module itself
// stays in the cache until a restart, and an UPDATE of an already-registered id
// keeps restart semantics rather than run two versions at once.
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
  'quarantinedBuiltins',
]);

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
  'usage:read',
  'sessions:bill',
  'sessions:interrupt',
]);

// The CLOSED vocabulary a manifest's `hideDispatchField` is drawn from: the
// core dispatch-modal fields an extension may take over by drawing its own
// control in the `dispatch.field` slot (public/slots.js). Deliberately SMALL —
// each name is a field the core draws AND a commitment that app.js has a row id
// for it (DISPATCH_FIELD_ROWS) and index.html a wrapper. Widening it is a MINOR
// and three more edits; keep it at four unless a real extension needs more.
//
// A STATIC array on the manifest, not a function, for the same reason
// `requires` is: the board has to know what an extension may suppress before
// any of its code runs, and a function could answer differently per call.
export const DISPATCH_FIELDS = new Set(['effort', 'autoCompactTokens', 'runtime', 'model']);

// `onBeforeDispatch` is the one hook that runs while the session does not yet
// exist anywhere: it fires after dispatch has settled the card id, cwd and
// worktree but BEFORE the launch command is built and the pane started, which
// is the only window in which an extension can persist state that the agent's
// very first tool call may already depend on. `onDispatch` fires after the
// entry is saved — correct for anything reacting to a new card, too late for an
// invariant the launched process itself relies on.
// What one extension's session hook is handed: the payload as fired, except
// `ext` — the dispatch's `{ [extId]: data }` bag from the dialog's
// dispatch.field contributions — narrowed to THIS extension's slice (null when
// it sent none), so no extension reads what a sibling's browser half sent.
export function hookPayloadFor(extId, payload) {
  if (!payload || !('ext' in payload)) return payload;
  const bag = payload.ext && typeof payload.ext === 'object' ? payload.ext : {};
  return { ...payload, ext: Object.hasOwn(bag, extId) ? bag[extId] : null };
}

export const SESSION_HOOKS = ['onBeforeDispatch', 'onArchive', 'onFork', 'onPurge', 'onDispatch', 'onResume'];
export const LAUNCH_PHASES = ['dispatch', 'resume', 'fork'];
const ID_RE = /^[a-z][a-z0-9-]*$/;

// A settings DEF, not a value: what the Extensions tab draws a row for and what
// ext-setting-set validates an incoming value against. Keys are camelCase and
// namespaced per extension in config.json (`extensionSettings.<id>.<key>`), so
// two manifests can both declare `registryUrl` with no collision and nothing
// needs a `reg` claim for them — only the within-manifest duplicate check below.
//
// No `default` on a def: an unset setting reads as `undefined` and the extension
// supplies its own fallback. A def-level default would be a fourth thing to
// validate and a second place a default can disagree with the code reading it,
// and an extension that is deliberately inert until a value is set needs
// `undefined` to be distinguishable from a value.
//
// No `secret` type either. A masked input that still round-trips through
// config.json in plaintext would imply a protection that does not exist, and
// nothing about an extension is protected from an extension anyway — the
// capability list is disclosure, not a sandbox.
//
// Constraint fields (`min`/`max`/`step` on a number, `maxLength`/`pattern` on
// text, `options` on a select) are DECLARATIVE: their legality is checked here
// via validateSettingDef, and a value is measured against them on the write
// path (ext-setting-set) by checkSettingValue — both from
// setting-constraints.js, so the two cannot drift. The Extensions panel mirrors
// them onto the native input as an AFFORDANCE; the server write path is the
// enforcement, and it rejects rather than clamps.
const SETTING_KEY_RE = /^[a-z][a-zA-Z0-9]*$/;
const SETTING_TYPES = ['text', 'number', 'toggle', 'select'];

function fail(ext, reason) {
  const id = ext && typeof ext.id === 'string' ? ext.id : '<no id>';
  throw new Error(`Extension ${id}: ${reason}`);
}

// The wrangler's own skill names, read once: agent-skills/skills/ cannot change
// under a running process, and this is on the boot path for every manifest.
// They are the OTHER half of what a `skills` entry may resolve to — an
// extension has always been able to gate an in-repo skill without shipping one.
let repoNames = null;
function inRepoSkillNames() {
  if (!repoNames) repoNames = new Set(skillsIn(SKILLS_ROOT).map((e) => e.name));
  return repoNames;
}

// Does this manifest SHIP `<dir>/skills/<name>`? The frontmatter `name` has to
// agree with the declared one, or the catalog would publish the skill under a
// name the manifest never claimed — and therefore never gates and never
// disables with itself.
function shipsSkill(dir, name) {
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) return false;
  return skillAt(path.join(dir, 'skills', name))?.name === name;
}

// Throws (naming the extension) on any manifest shape the rest of the server
// would otherwise misread silently. `dir` is the manifest module's own directory
// (it exports it from import.meta.url) — the only thing a `client` path may
// resolve inside, and only under its public/ subdir, since that is what the
// /ext/<id>/ static route will serve.
export function validateManifest(ext, { dir = ext?.dir, repoSkills = inRepoSkillNames() } = {}) {
  if (!ext || typeof ext !== 'object') throw new Error('Extension <no id>: manifest is not an object');
  if (typeof ext.id !== 'string' || !ID_RE.test(ext.id)) fail(ext, `id must match ${ID_RE} (got ${JSON.stringify(ext.id)})`);
  if (typeof ext.label !== 'string' || !ext.label) fail(ext, 'label must be a non-empty string');
  if (ext.help != null && typeof ext.help !== 'string') fail(ext, 'help must be a string');
  // Consent-modal and settings-row prose. Optional, and third-party strings for
  // an installed extension — checked only for TYPE here; every consumer renders
  // them via textContent, so nothing downstream cares what is in them.
  for (const key of ['description', 'author', 'homepage']) {
    if (ext[key] != null && typeof ext[key] !== 'string') fail(ext, `${key} must be a string`);
  }
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
  // Which core dispatch-modal rows this extension's browser half may hide. The
  // DISCLOSURE half of the two-key veto — a contribution's own `hides` is
  // filtered against it client-side, so the browser can never widen what the
  // manifest declared.
  if (ext.hideDispatchField != null) {
    if (!Array.isArray(ext.hideDispatchField) || ext.hideDispatchField.some((f) => typeof f !== 'string' || !f)) {
      fail(ext, 'hideDispatchField must be an array of dispatch field names');
    }
    for (const f of ext.hideDispatchField) {
      if (!DISPATCH_FIELDS.has(f)) fail(ext, `unknown dispatch field "${f}" (known: ${[...DISPATCH_FIELDS].sort().join(', ')})`);
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
  if (ext.settings != null) {
    if (!Array.isArray(ext.settings)) fail(ext, 'settings must be an array of setting definitions');
    const keys = new Set();
    for (const [i, s] of ext.settings.entries()) {
      if (!s || typeof s !== 'object') fail(ext, `settings[${i}] is not an object`);
      if (typeof s.key !== 'string' || !SETTING_KEY_RE.test(s.key)) fail(ext, `settings[${i}].key must match ${SETTING_KEY_RE} (got ${JSON.stringify(s.key)})`);
      if (keys.has(s.key)) fail(ext, `duplicate setting key "${s.key}"`);
      keys.add(s.key);
      if (!SETTING_TYPES.includes(s.type)) fail(ext, `settings.${s.key}.type must be one of ${SETTING_TYPES.join(', ')}`);
      if (typeof s.label !== 'string' || !s.label) fail(ext, `settings.${s.key}.label must be a non-empty string`);
      // Third-party prose. Type-checked only, exactly like description/author/
      // homepage above — every consumer renders these via textContent.
      for (const k of ['help', 'placeholder']) {
        if (s[k] != null && typeof s[k] !== 'string') fail(ext, `settings.${s.key}.${k} must be a string`);
      }
      const badConstraint = validateSettingDef(s);
      if (badConstraint) fail(ext, `settings.${s.key}.${badConstraint}`);
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
  // A declared skill must RESOLVE, to one of exactly two places: an in-repo
  // agent-skills/skills/<name> (all a manifest could name before an extension
  // could ship one, and still how it gates one) or its own
  // `<dir>/skills/<name>/SKILL.md`. A name matching neither was silently inert
  // — the manifest claimed a skill, the catalog had never heard of the
  // directory, and nothing anywhere said so.
  //
  // Shipping a directory that SHADOWS an in-repo skill is refused rather than
  // resolved either way round: the catalog keeps the in-repo one, so the
  // extension's copy would be dead content reading exactly like the skill the
  // agent is actually getting.
  for (const [i, s] of (ext.skills || []).entries()) {
    if (typeof s !== 'string' || !s) fail(ext, `skills[${i}] must be a skill name`);
    if (repoSkills.has(s)) {
      if (shipsSkill(dir, s)) fail(ext, `skill "${s}" collides with the in-repo skill of the same name`);
    } else if (!shipsSkill(dir, s)) {
      fail(ext, `unknown skill "${s}" — neither agent-skills/skills/${s} in the wrangler nor skills/${s}/SKILL.md declaring \`name: ${s}\` under this extension`);
    }
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
// come off the registered entry; `enabled` is re-read from config on EVERY call,
// so the settings toggle takes an extension's UI off the board on the next tick.
//
// `bootEnabled` keeps its name for the client's sake but now means "ACTIVE in
// this process right now" — its tools, handlers, stores and client asset are
// registered. `enabled` is the config value. The two differ only in the window
// between a toggle and its activation settling, and for a quarantined entry,
// which reports both false however loudly config says otherwise.
//
// `handlerTypes` is the one addition the client half needs rather than the
// human: the browser façade binds an extension's `send` to its OWN registered
// types (public/slots.js), so this array is what makes that possible. A handful
// of short strings per extension — nowhere near graph.history's
// problem — and deliberately off the per-card path.
// `quarantine` short-circuits `enabled` in BOTH directions: the config may well
// say this extension is on, but it is contributing nothing, so reporting it
// enabled would draw a live-looking toggle over a feature that is not there.
// The extra fields are the installed-extension row's own content (origin, SHA,
// author, description) and are third-party strings — the client renders every
// one of them through `textContent`.
export function extensionsForGraph(list, enabledFor = extensionEnabled, valuesFor = extensionSettings) {
  return list.map(({
    id, label, help, defaultEnabled, enabled: bootEnabled, handlerTypes, hideDispatchField,
    quarantine, external, description, author, homepage, provenance, requires, settings,
  }) => ({
    id, label, help, defaultEnabled, bootEnabled: Boolean(bootEnabled) && !quarantine,
    enabled: quarantine ? false : enabledFor(id, defaultEnabled),
    handlerTypes: [...(handlerTypes || [])],
    hideDispatchField: [...(hideDispatchField || [])],
    quarantine: quarantine || null,
    external: Boolean(external),
    description: description || '',
    author: author || '',
    homepage: homepage || '',
    requires: [...(requires || [])],
    // The setting DEFS (third-party prose, rendered via textContent) plus the
    // current VALUES, re-read from config on every rebuild for exactly the
    // reason `enabled` is: an edit in another tab, or by hand in config.json,
    // has to reach the panel. A quarantined row keeps its defs — the panel
    // draws them DISABLED, which says "this is what it would want" rather than
    // hiding the rows and making a broken extension look like one with nothing
    // to configure.
    //
    // A handful of short defs and values per extension, the same order of cost
    // as `requires` and `handlerTypes` above, and deliberately off the per-card
    // path for the same reason.
    settings: (settings || []).map((s) => ({ ...s })),
    settingValues: valuesFor(id),
    // Only the two fields the row shows, never the whole record: `requires` on
    // it is the CONSENTED set, which is an update-flow input and not something
    // the board needs on every tick.
    origin: provenance?.originUrl || '',
    sha: provenance?.sha || '',
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
//
// FAILURE POSTURE: a manifest the rest of the server would misread does NOT
// throw out of here — it QUARANTINES, landing in `out.list` as
// `{ enabled: false, quarantine: '<reason>' }` and contributing nothing (no
// tools, handlers, stores, graph keys, hooks, sweeps or client asset). This
// deliberately overrides the façade design's boot-fail tier: with third-party
// manifests in `builtin` (external.js appends them) one bad directory must not
// take the whole board down. It covers BUILTINS too — a repo bug that quietly
// vanished reads as a feature that was never there — so index.js logs every
// quarantine once at boot and the board raises a persistent banner for a
// quarantined builtin.
//
// Collision order is load-bearing: `builtin` comes first, externals are
// appended, and every name check is first-come — so a builtin wins every tie by
// construction and the EXTERNAL entry is the one quarantined.
export function loadExtensions({ cfg = readConfig(), builtin = BUILTIN, coreToolNames = [], coreHandlerTypes = [] } = {}) {
  const reg = {
    ids: new Set(),
    toolNames: new Set(coreToolNames),
    handlerTypes: new Set(coreHandlerTypes),
    storeNames: new Set(),
    // SHIPPED skill names only. The in-repo ones are not in here and cannot be
    // claimed: several manifests gating `checklist` is ordinary, two
    // directories answering to one catalog name is not.
    skillNames: new Set(),
  };
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
    // The name registry, carried ON the object rather than kept local to this
    // call: a later registerExtension has to claim names against the same sets,
    // and a later unregisterExtension has to release them, or a reinstall of the
    // same id (or a re-enable) collides with the copy it just removed.
    _reg: reg,
    // id -> the manifest object as it was passed in, for every non-quarantined
    // entry INCLUDING a disabled one. A boot-disabled extension staged nothing,
    // so this map is the only thing a later live ENABLE can re-stage from; a
    // quarantined entry has no manifest worth keeping.
    _manifests: new Map(),
  };
  for (const ext of builtin) {
    // Pre-quarantined by discovery — a directory that never yielded a usable
    // manifest (external.js). There is nothing to stage, only a row to show.
    if (ext?.quarantine) { out.list.push(quarantinedEntry(ext, ext.quarantine)); continue; }
    try {
      stageExtension(ext, { cfg, out, reg });
    } catch (err) {
      out.list.push(quarantinedEntry(ext, reasonOf(err, ext?.id)));
    }
  }
  return out;
}

// The `Extension <id>: ` prefix `fail()` adds is noise once the reason is shown
// on that extension's own settings row, so it comes straight back off here.
function reasonOf(err, id) {
  const msg = err?.message || String(err);
  const prefix = `Extension ${typeof id === 'string' && id ? id : '<no id>'}: `;
  return msg.startsWith(prefix) ? msg.slice(prefix.length) : msg;
}

// A row exists even for a manifest nothing could be read off, so the settings
// panel can name WHICH extension is broken and why — an absent row is exactly
// the "feature that quietly vanished" this posture must not produce. The id
// falls back to the directory-derived one external.js carries, then to a
// placeholder.
function quarantinedEntry(ext, quarantine) {
  const id = typeof ext?.id === 'string' && ext.id ? ext.id : '<no id>';
  return {
    id,
    label: typeof ext?.label === 'string' && ext.label ? ext.label : id,
    help: '',
    description: '',
    author: '',
    homepage: '',
    defaultEnabled: false,
    enabled: false,
    requires: [],
    range: null,
    storeNames: [],
    settings: [],
    skills: [],
    handlerTypes: [],
    hideDispatchField: [],
    external: Boolean(ext?.external),
    dir: typeof ext?.dir === 'string' ? ext.dir : null,
    provenance: ext?.provenance ?? null,
    quarantine,
  };
}

// Everything a manifest contributes is computed into locals FIRST and written to
// `out`/`reg` only once the whole entry has validated. A manifest that collides
// half-way through (two tools, the second name taken) would otherwise leave its
// first tool registered under an extension that contributes nothing — the exact
// half-state the quarantine posture exists to avoid. That atomicity is also what
// lets registerExtension hand an install's collision straight back to the
// handler with nothing written.
//
// A row whose id `reg` no longer holds was RELEASED by unregisterExtension (a
// disable, or an uninstall-then-reinstall of the same id) and is replaced at its
// own index, so the settings tab's ordering does not jump under a re-enable. An
// id `reg` still holds is a genuine duplicate and fails.
function stageExtension(ext, { cfg, out, reg }) {
  validateManifest(ext);
  if (reg.ids.has(ext.id)) fail(ext, 'duplicate extension id');
  const at = out.list.findIndex((e) => e.id === ext.id);
  const place = (entry) => { if (at >= 0) out.list[at] = entry; else out.list.push(entry); };
  const enabled = extensionEnabled(ext.id, ext.defaultEnabled, cfg);
  // `requires`/`range`/`storeNames` are the façade's build inputs, carried on
  // the list entry because index.js — not this leaf — is what can build one.
  // `handlerTypes` is filled below, as the handlers are collected: it is what
  // tells the BOARD which control types this extension owns, so the client
  // façade's `send` can refuse a frame aimed at anything else.
  //
  // `external`/`dir`/`provenance` are what let the settings row tell an
  // installed extension from a shipped one and offer Uninstall/Update for it.
  const listEntry = {
    id: ext.id,
    label: ext.label,
    help: ext.help || '',
    description: typeof ext.description === 'string' ? ext.description : '',
    author: typeof ext.author === 'string' ? ext.author : '',
    homepage: typeof ext.homepage === 'string' ? ext.homepage : '',
    defaultEnabled: Boolean(ext.defaultEnabled),
    enabled,
    requires: [...(ext.requires || [])],
    range: ext.engines?.wranglerApi ?? null,
    storeNames: Object.keys(ext.stores || {}),
    // Copied, not referenced: the entry is what extensionsForGraph reads every
    // tick and what ext-setting-set validates against, and a manifest that
    // mutated its own defs array afterwards must not be able to move either.
    //
    // Unlike every other contribution on this entry, settings claim NOTHING and
    // release nothing: no tool, handler, store, hook, sweep or asset, and no
    // name in `reg` (keys are namespaced by extension id in config.json). So
    // there is nothing to stage atomically beyond the entry itself and nothing
    // for unregisterExtension to take back.
    settings: (ext.settings || []).map((s) => ({ ...s })),
    // Kept on the entry purely so a late quarantine (below) can move this
    // manifest's skills from the enabled list to the disabled one by id.
    skills: [...(ext.skills || [])],
    handlerTypes: [],
    // Copied, not referenced, like `requires`/`settings`: this is what the
    // board's veto is checked against and a manifest must not be able to widen
    // it after the fact. Claims no name in `reg` and stages nothing, so
    // unregisterExtension has nothing to take back.
    hideDispatchField: [...(ext.hideDispatchField || [])],
    external: Boolean(ext.external),
    dir: typeof ext.dir === 'string' ? ext.dir : null,
    provenance: ext.provenance ?? null,
    quarantine: null,
  };
  if (!enabled) {
    reg.ids.add(ext.id);
    place(listEntry);
    out._manifests?.set(ext.id, ext);
    out.disabledSkillIds.push(...(ext.skills || []));
    return;
  }
  const tools = [];
  const handlers = [];
  const stores = [];
  // What this manifest SHIPS, as opposed to the in-repo skills it merely gates
  // — validateManifest has already resolved every declared name, so anything
  // not in-repo is one of its own. Claimed globally exactly as a tool name is:
  // the catalog is one flat namespace keyed by the frontmatter `name`, so two
  // extensions shipping one name would otherwise resolve by load order.
  const shipped = (ext.skills || []).filter((s) => !inRepoSkillNames().has(s));
  for (const s of shipped) if (reg.skillNames.has(s)) fail(ext, `skill name "${s}" is already registered`);
  for (const t of ext.tools || []) {
    if (reg.toolNames.has(t.name) || tools.some((s) => s.name === t.name)) fail(ext, `tool name "${t.name}" is already registered`);
    // Tagged with its owner as it is collected: each frame is invoked with
    // THAT extension's façade, so the tag is how mcp/server.js and
    // control/router.js tell an extension's tool/handler from a core one (an
    // untagged one is core and still gets deps/ctx). Same for handlers and
    // session hooks below — sweeps were already tagged.
    tools.push({ ...t, extId: ext.id });
  }
  for (const h of ext.handlers || []) {
    if (reg.handlerTypes.has(h.type) || handlers.some((s) => s.type === h.type)) fail(ext, `handler type "${h.type}" is already registered`);
    handlers.push({ ...h, extId: ext.id });
  }
  for (const [name, factory] of Object.entries(ext.stores || {})) {
    if (reg.storeNames.has(name)) fail(ext, `store name "${name}" is already registered`);
    stores.push([name, factory]);
  }

  reg.ids.add(ext.id);
  place(listEntry);
  out._manifests?.set(ext.id, ext);
  for (const t of tools) { reg.toolNames.add(t.name); out.tools.push(t); out.allowedToolNames.push(t.name); }
  for (const h of handlers) { reg.handlerTypes.add(h.type); out.handlers.push(h); listEntry.handlerTypes.push(h.type); }
  for (const [name, factory] of stores) { reg.storeNames.add(name); out.stores[name] = factory; }
  for (const s of shipped) reg.skillNames.add(s);
  out.skillIds.push(...(ext.skills || []));
  // A RE-registration has to undo the suppression its own unregister added, or
  // the same skill is nudged and actively suppressed at once. Inert at boot,
  // where nothing has been disabled yet.
  if (ext.skills?.length) {
    const back = new Set(ext.skills);
    out.disabledSkillIds = out.disabledSkillIds.filter((s) => !back.has(s));
  }
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
  //
  // An INSTALLED extension's asset URLs carry its pinned commit as `?v=`, which
  // a builtin (no provenance) has nothing to add and so keeps the bare path.
  // The browser caches an ES module per URL for the life of the page, so a
  // reinstall or an update of the same id would otherwise re-announce a URL the
  // tab has already resolved and silently re-register the OLD client half —
  // the mirror of the `?t=` the server's own import is cache-busted with. The
  // static route splits the query off before resolving, so it costs nothing.
  const assetVersion = ext.provenance?.sha ? `?v=${ext.provenance.sha.slice(0, 12)}` : '';
  if (ext.client || ext.styles) {
    out.clientManifest.push({
      id: ext.id,
      ...(ext.client ? { client: extAssetUrl(ext.id, ext.client) + assetVersion } : {}),
      ...(ext.styles ? { styles: extAssetUrl(ext.id, ext.styles) + assetVersion } : {}),
      // The control types this extension's BROWSER half may send, carried on
      // the connect announcement as well as on graph.extensions because the
      // announcement lands before the first graph — and slots.js fails closed
      // until it has heard one of the two. Omitted when it has none, keeping a
      // handler-less extension's entry byte-identical to the pre-façade one.
      ...(listEntry.handlerTypes.length ? { handlerTypes: [...listEntry.handlerTypes] } : {}),
      // The core dispatch rows this extension's `dispatch.field` contributions
      // may veto — same two inputs, same reason, and omitted when empty so an
      // extension that hides nothing keeps a byte-identical entry.
      ...(listEntry.hideDispatchField.length ? { hideDispatchField: [...listEntry.hideDispatchField] } : {}),
    });
  }
}

// Stage a manifest into an ALREADY-LOADED registry: the install handler's last
// step, and the enable handler's first. Everything a live change needs beyond
// this is index.js's side (stores, façade, hooks, sweeps) — see
// activateExtension there; this is purely the leaf's half.
//
// Throws on a validation failure or a name collision with NOTHING written, since
// staging commits only at the end — so an install that cannot be registered
// leaves no half-extension behind and the caller only has to undo the disk half.
// It never pushes a quarantined row: an install must fail outright rather than
// land a broken row, while boot and the enable path quarantine deliberately.
export function registerExtension(loaded, manifest, { cfg = readConfig() } = {}) {
  stageExtension(manifest, { cfg, out: loaded, reg: loaded._reg });
  return loaded.list.find((e) => e.id === manifest.id);
}

// The inverse: take every contribution of `id` back out of the registry and
// release its names, so the same id can be staged again (a re-enable, or a
// reinstall after an uninstall). `remove: false` keeps the ROW — a disabled or
// quarantined extension still has to appear in the settings list saying why —
// while `remove: true` is uninstall, where the extension is gone entirely.
//
// Releasing the names in `_reg` is the part with no boot-time equivalent: before
// this the registry only ever grew, so a second staging of the same id (or of a
// tool name the row still held) would have failed as a duplicate.
export function unregisterExtension(loaded, id, { remove = false } = {}) {
  const entry = loaded.list.find((e) => e.id === id);
  const reg = loaded._reg;
  if (reg) {
    reg.ids.delete(id);
    // Read off the live lists BEFORE they are filtered — the row itself carries
    // its handler types and store names, but never its tool names.
    for (const t of loaded.tools) if (t.extId === id) reg.toolNames.delete(t.name);
    for (const h of loaded.handlers) if (h.extId === id) reg.handlerTypes.delete(h.type);
    for (const name of entry?.storeNames || []) reg.storeNames.delete(name);
    // In-repo names were never claimed, so dropping them here is a no-op — the
    // row carries both kinds and telling them apart again would only be a
    // second place the rule lives.
    for (const s of entry?.skills || []) reg.skillNames.delete(s);
  }
  if (entry) entry.enabled = false;
  loaded.tools = loaded.tools.filter((t) => t.extId !== id);
  loaded.allowedToolNames = loaded.tools.map((t) => t.name);
  loaded.handlers = loaded.handlers.filter((h) => h.extId !== id);
  loaded.sweeps = loaded.sweeps.filter((s) => s.extId !== id);
  loaded.graphContributors = loaded.graphContributors.filter((g) => g.id !== id);
  loaded.skillGates = loaded.skillGates.filter((g) => g.id !== id);
  loaded.toolFilters = loaded.toolFilters.filter((f) => f.id !== id);
  loaded.clientManifest = loaded.clientManifest.filter((c) => c.id !== id);
  for (const name of entry?.storeNames || []) delete loaded.stores[name];
  for (const k of SESSION_HOOKS) loaded.sessionHooks[k] = loaded.sessionHooks[k].filter((h) => h.extId !== id);
  delete loaded.dirs[id];
  const skills = new Set(entry?.skills || []);
  loaded.skillIds = loaded.skillIds.filter((s) => !skills.has(s));
  if (remove) {
    // SPLICED, never reassigned: index.js's extBag and every ctx.ext hold this
    // array by reference, so a fresh array would leave them reading the old one.
    const at = loaded.list.findIndex((e) => e.id === id);
    if (at >= 0) loaded.list.splice(at, 1);
    loaded._manifests?.delete(id);
    // An extension that is GONE should neither be nudged nor actively
    // suppressed — there is no longer a feature for the suppression to describe.
    loaded.disabledSkillIds = loaded.disabledSkillIds.filter((s) => !skills.has(s));
  } else {
    // Its skills leave the nudge and the Codex catalog with it, and join the
    // DISABLED list — an unregistered extension's skill must be actively
    // suppressed rather than merely unmentioned, exactly as a toggled-off one's is.
    for (const s of skills) if (!loaded.disabledSkillIds.includes(s)) loaded.disabledSkillIds.push(s);
  }
  return entry || null;
}

// Quarantine an extension that only failed once the NON-leaf half reached it —
// a store factory that threw, an unsatisfiable `engines.wranglerApi` caught by
// buildHostApi, a graph contributor claiming a reserved key. All of those happen
// in index.js, AFTER the manifest's contributions are registered, so this has to
// unregister them by id rather than simply decline to add them. Boot is no
// longer the only moment it can happen: a live ENABLE runs the same activation.
export function quarantineExtension(loaded, id, reason) {
  unregisterExtension(loaded, id);
  const entry = loaded.list.find((e) => e.id === id);
  if (entry) entry.quarantine = reason;
  return reason;
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
let primed = false;
export function getExtensions(opts) {
  if (!memo) memo = loadExtensions(opts);
  return memo;
}

// The one ASYNC door into the memo, and the only one that includes INSTALLED
// extensions: discovery has to `await import()` each one, and `getExtensions()`
// must stay synchronous or every leaf consumer (client-config.js,
// agent-skills.js, tools/index.js, control/router.js — and through them the
// agent adapters) would have to become async for it. Keeping the async work in
// a separate function is the whole reason there is no ripple.
//
// THROWS IF THE MEMO IS ALREADY SET, which is the ordering guard: anything that
// reached `getExtensions()` before this ran silently memoised a BUILTIN-ONLY
// board — installed extensions simply absent, no error anywhere, for the life of
// the process. server/index.js awaits this before the MCP registry, the control
// router's lazy map and any adapter import.
//
// `getExtensions()` deliberately does NOT also throw when called before priming.
// It cannot: the adapters and the whole test suite legitimately call it with an
// injected `{ builtin }`/`{ cfg }` and no priming at all, and there is no way
// from this leaf to tell "the server booted in the wrong order" from either. The
// throw here already fires on exactly the bad case — something got in first —
// so a second guard would add a false-positive surface and no coverage.
export async function primeExtensions({ discover, ...opts } = {}) {
  if (memo) throw new Error('primeExtensions: extensions were already loaded — something read getExtensions() before priming, so installed extensions would be silently missing');
  // Imported dynamically so the SYNCHRONOUS consumers above — which are what
  // the agent adapters pull in — never load discovery (and through it
  // atomic-json and the filesystem walk) just to read a memo that is already
  // filled. It is also why the leaf-import scanner's `^\s*import` anchor does
  // not need to think about this line.
  const { discoverExternal } = await import('./external.js');
  const external = await (discover || discoverExternal)();
  // Builtins FIRST so every first-come name check resolves a tie in their
  // favour and the EXTERNAL entry is the one quarantined.
  memo = loadExtensions({ ...opts, builtin: [...(opts.builtin || BUILTIN), ...external] });
  primed = true;
  return memo;
}

export function extensionsPrimed() {
  return primed;
}

export function _resetExtensionsForTests() {
  memo = null;
  primed = false;
}
