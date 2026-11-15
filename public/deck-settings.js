import { CODEX_POLICY_FALLBACK } from './codex-policy-field.js';

// Settings row id -> its field of a deck's codexPolicyDefaults.
export const CODEX_DEFAULT_SETTINGS = { codexDefaultSandbox: 'sandbox', codexDefaultApproval: 'approval', codexDefaultApproveForMe: 'approveForMe', codexDefaultBypass: 'bypass' };

const EXT_PREFIX = 'ext:';

// A deck setting's value as one deck's graph carries it, with the same
// fallbacks the board applies to its own deck's graph. Undefined for an id
// that is not a deck setting, or an extension the deck does not have.
export function deckSettingValue(graph, id) {
  const g = graph || {};
  switch (id) {
    case 'trustCodexLaunchCwd': case 'trustClaudeLaunchCwd': case 'autoFixPrChecksDefault':
    case 'suppressNudgedPrToasts': case 'prModelFooter':
      return g[id] !== false;
    case 'mailWakesDormant': case 'refreshSessionsAfterUpdate':
      return g[id] === true;
    case 'defaultSessionCwd':
      return typeof g.defaultSessionCwd === 'string' ? g.defaultSessionCwd : '';
    case 'defaultRuntime':
      return typeof g.defaultRuntime === 'string' && g.defaultRuntime ? g.defaultRuntime : 'local';
    case 'backgroundModel':
      return g.backgroundModel && typeof g.backgroundModel === 'object' ? `${g.backgroundModel.agent}:${g.backgroundModel.model}` : undefined;
    case 'autoUpdate':
      return g.autoUpdate || 'notify';
    default:
      break;
  }
  if (CODEX_DEFAULT_SETTINGS[id]) {
    const policy = g.codexPolicyDefaults && typeof g.codexPolicyDefaults === 'object' ? { ...CODEX_POLICY_FALLBACK, ...g.codexPolicyDefaults } : CODEX_POLICY_FALLBACK;
    return policy[CODEX_DEFAULT_SETTINGS[id]];
  }
  if (typeof id === 'string' && id.startsWith(EXT_PREFIX)) {
    const list = Array.isArray(g.extensions) ? g.extensions : [];
    return list.find((e) => e?.id === id.slice(EXT_PREFIX.length))?.enabled;
  }
  return undefined;
}

// The control frame that writes a deck setting (each is an admin.* action on
// the deck API), or null for an id that is not one.
export function deckSettingFrame(id, value) {
  switch (id) {
    case 'trustCodexLaunchCwd': return { type: 'set-trust-codex-launch-cwd', enabled: Boolean(value) };
    case 'trustClaudeLaunchCwd': return { type: 'set-trust-claude-launch-cwd', enabled: Boolean(value) };
    case 'autoFixPrChecksDefault': return { type: 'set-auto-fix-pr-checks-default', enabled: Boolean(value) };
    case 'suppressNudgedPrToasts': return { type: 'set-suppress-nudged-pr-toasts', enabled: Boolean(value) };
    case 'mailWakesDormant': return { type: 'set-mail-wakes-dormant', enabled: Boolean(value) };
    case 'prModelFooter': return { type: 'set-pr-model-footer', enabled: Boolean(value) };
    case 'defaultSessionCwd': return { type: 'set-default-session-cwd', cwd: String(value || '').trim() };
    case 'defaultRuntime': return { type: 'set-default-runtime', runtime: String(value || 'local') };
    case 'autoUpdate': return { type: 'set-auto-update-mode', mode: value };
    case 'refreshSessionsAfterUpdate': return { type: 'set-refresh-sessions-after-update', enabled: Boolean(value) };
    case 'backgroundModel': {
      // `<agent>:<model>`: an agent id never holds a colon, a model value may.
      const raw = String(value || '');
      const at = raw.indexOf(':');
      return at > 0 ? { type: 'set-background-model', agent: raw.slice(0, at), model: raw.slice(at + 1) } : null;
    }
    default:
      break;
  }
  if (CODEX_DEFAULT_SETTINGS[id]) return { type: 'set-codex-policy-default', key: CODEX_DEFAULT_SETTINGS[id], value };
  if (typeof id === 'string' && id.startsWith(EXT_PREFIX)) return { type: 'extension-enabled', id: id.slice(EXT_PREFIX.length), enabled: Boolean(value) };
  return null;
}

// Descriptor fields every deck reports as part of the deck API itself; any
// other field is a choice the deck was started with.
const DESCRIPTOR_PROTOCOL_KEYS = new Set(['deckId', 'name', 'api', 'runtimes', 'actions', 'extensions', 'startup']);

const labelOf = (key) => {
  const words = String(key).replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim().toLowerCase();
  return words ? words[0].toUpperCase() + words.slice(1) : String(key);
};

function valueText(v) {
  if (v === null || v === undefined) return 'Not set: the deck\'s default';
  if (typeof v === 'boolean') return v ? 'On' : 'Off';
  if (Array.isArray(v)) return v.length ? v.map((x) => (x && typeof x === 'object' ? JSON.stringify(x) : String(x))).join(', ') : 'None';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

// What a deck was started with, read-only, from its descriptor: every field
// that is not part of the deck API itself, plus each field of a `startup`
// object if it reports one. [{ key, label, value }] in descriptor order.
export function startupChoices(descriptor) {
  if (!descriptor || typeof descriptor !== 'object') return [];
  const out = [];
  const add = (key, v) => { if (!out.some((c) => c.key === key)) out.push({ key, label: labelOf(key), value: valueText(v) }); };
  for (const [key, v] of Object.entries(descriptor)) if (!DESCRIPTOR_PROTOCOL_KEYS.has(key)) add(key, v);
  if (descriptor.startup && typeof descriptor.startup === 'object' && !Array.isArray(descriptor.startup)) {
    for (const [key, v] of Object.entries(descriptor.startup)) add(key, v);
  }
  return out;
}

// Settings' deck picker, from the board's decks (own first, as app.js's
// boardDecks() lists them). `key` is the deck list entry id. A deck's settings
// are available only while it is connected and has sent its state; otherwise
// `why` says what it is instead.
export function settingsDeckChoices(decks = []) {
  return (decks || []).filter(Boolean).map((d) => {
    const status = d.duplicate ? 'incompatible' : d.status;
    let why = '';
    if (status === 'incompatible') why = d.duplicate ? 'already on this board' : 'incompatible';
    else if (status !== 'ready' || !d.live) why = status === 'connecting' ? 'connecting' : 'unreachable';
    return { key: d.id, label: d.name, own: Boolean(d.own), available: !why, why };
  });
}
