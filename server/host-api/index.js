import { CAPABILITIES } from '../extensions/index.js';
import { HOST_API_VERSION, servesRange } from './version.js';
import { V1_BUILDERS } from './v1.js';

// The per-extension `host` façade: what an extension's tools, handlers, hooks,
// sweeps and gates are handed INSTEAD of the old one-object-for-everyone bag
// (`{stores, list, deliver, core, hideTool}`), which gave an extension needing
// only rebuild() the whole server core plus every other extension's stores.
//
// server/host-api/** is the new NON-leaf and is imported ONLY by server/index.js.
// The direction is one-way and asserted: server/extensions/** may not import
// anything here (extensions/index.test.js's forbidden regex), which is exactly
// why the LOADER cannot build façades — it cannot reach the singletons a builder
// binds. It reports `requires` and the range; index.js builds.
//
// FAILURE POSTURE. A bad `requires`, an unknown capability, or a range this
// server does not serve THROWS here, naming the extension — index.js turns that
// into the existing log-and-exit(1) boot path, the same posture as a colliding
// tool name. A manifest declaring a capability this server cannot serve is a
// mistake, not something to degrade around. A runtime throw from a façade method
// is NOT caught here: it propagates to the MCP tool's error result or the control
// router's error envelope, which already exist.
//
// Versioning: a breaking reshape adds `v2.js` and keeps `v1.js` as the shim,
// selected by the manifest's declared range, rather than editing builders in
// place — see version.js.

// Merged onto every façade whatever it declares. None of the five reaches server
// state on the extension's behalf, which is why none is gated:
//   id       — its own id, so a log line or a broadcast payload can name itself.
//   version  — what it is talking to, matching the range it declared.
//   stores   — ITS OWN stores only. The pre-façade `extStores` was one flat
//              object shared by every manifest; the narrowing is the loader's
//              per-manifest store-name list applied here.
//   settings — ITS OWN settings values, the same argument as `stores`: this is
//              the extension's own data, not a core surface, and a capability
//              for reading back a value a human typed into that extension's own
//              settings row would be disclosure noise.
//   log      — routed through server/log.js, prefixed `[ext:<id>]`. The prefix
//              goes INTO the first argument only when that is a string, so
//              log(err) / log('[tag]', err) keeps the Error its own argument and
//              the console still renders the stack (see log.js).
function alwaysPresent({ id, stores = {}, log = () => {}, settingDefs = [], readSettings = () => ({}) }) {
  return {
    id,
    version: HOST_API_VERSION,
    stores: Object.freeze({ ...stores }),
    // Narrowed by the SAME mechanism as the three forced values in v1.js: `id`
    // is closed over here and is not a caller-passable argument, so there is no
    // signature through which an extension could read a sibling's block. Read
    // THROUGH on every call rather than snapshotted at build time — a value
    // edited in the Extensions tab (or by hand in config.json) has to land
    // without a restart, and the façade is built once per activation.
    //
    // A key the manifest did not declare reads as `undefined` rather than
    // throwing, so `get(k)` and `all()` agree about the vocabulary; a typo is
    // the extension's own bug and there is nothing for it to leak into.
    settings: Object.freeze({
      get: (key) => (settingDefs.some((d) => d.key === key) ? readSettings(id)[key] : undefined),
      all: () => Object.fromEntries(settingDefs.map((d) => [d.key, readSettings(id)[d.key]])),
    }),
    log: (...args) => (typeof args[0] === 'string' ? log(`[ext:${id}] ${args[0]}`, ...args.slice(1)) : log(`[ext:${id}]`, ...args)),
  };
}

// Several capabilities contribute to the same namespace (`sessions:read` and
// `sessions:wake` both return a `sessions` object), so the merge is one level
// deep. Deeper would mean a capability could reshape another's method table.
function mergeInto(target, contribution) {
  for (const [key, value] of Object.entries(contribution)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && typeof value !== 'function') {
      target[key] = { ...(target[key] || {}), ...value };
    } else {
      target[key] = value;
    }
  }
}

export function buildHostApi({ id, requires = [], range = null, ...wiring } = {}) {
  if (typeof id !== 'string' || !id) throw new Error('buildHostApi: id must be a non-empty extension id');
  if (!Array.isArray(requires)) throw new Error(`Extension ${id}: requires must be an array of capability names`);
  if (!servesRange(range)) {
    throw new Error(`Extension ${id}: needs host API ${range}, this server serves ${HOST_API_VERSION}`);
  }
  const facade = alwaysPresent({ id, ...wiring });
  // `settingDefs`/`readSettings` ride in on `wiring` with no signature change,
  // so they reach the capability builders too. No builder reads them and none
  // should: `host.settings` is already built above, ungated, and is not a
  // capability — CAPABILITIES and V1_BUILDERS are untouched by it.
  const dep = { id, ...wiring };
  for (const name of requires) {
    const build = Object.hasOwn(V1_BUILDERS, name) ? V1_BUILDERS[name] : null;
    if (!build) {
      throw new Error(`Extension ${id}: unknown capability "${name}" (known: ${[...CAPABILITIES].sort().join(', ')})`);
    }
    mergeInto(facade, build(dep));
  }
  // Frozen at the top AND one level down: an undeclared capability's key is
  // structurally ABSENT rather than a method that throws (`'sessions' in host`
  // is false), and a declared namespace cannot be extended or swapped by the
  // extension holding it.
  for (const value of Object.values(facade)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) Object.freeze(value);
  }
  return Object.freeze(facade);
}
