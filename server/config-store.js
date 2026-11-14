import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './data-dir.js';
import { generateSocketName } from './tmux-socket.js';
import { writeJsonAtomic } from './atomic-json.js';
import { CODEX_SANDBOXES, CODEX_APPROVALS } from './extensions/codex-policy.js';

// Persistent per-install settings (the tmux socket this data dir is bound to,
// and later the migration-complete flag). Distinct from the ephemeral
// runtime.json (port/pid/startedAt). One JSON file rather than a dot-file per
// flag, so new settings just add a key.
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

export function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) || {};
  } catch {
    return {};
  }
}

export function writeConfig(patch) {
  const next = { ...readConfig(), ...patch };
  writeJsonAtomic(CONFIG_FILE, next, { trailingNewline: true });
  return next;
}

// This install's tmux socket — generated and persisted on first run, stable
// thereafter. New sessions launch here; legacy sessions stay on the default
// socket until drained. AW_TMUX_SOCKET forces a name (handy for a known dev
// socket); otherwise one is generated.
// Whether to auto-open the board in a browser on startup. Default OFF — opt in
// with AW_OPEN_BROWSER=1. The legacy AW_NO_OPEN flag (truthy) still suppresses and
// takes precedence, so pre-existing plists keep working without changes.
export function shouldOpenBrowser(env = process.env) {
  const truthy = (v) => v != null && !['', '0', 'false', 'no'].includes(String(v).toLowerCase());
  if (truthy(env.AW_NO_OPEN)) return false;
  return truthy(env.AW_OPEN_BROWSER);
}

export function resolveInstanceSocket() {
  const cfg = readConfig();
  if (cfg.tmuxSocket) return cfg.tmuxSocket;
  const socket = process.env.AW_TMUX_SOCKET || generateSocketName();
  writeConfig({ tmuxSocket: socket });
  return socket;
}

// How often (seconds) the server re-polls GitHub PR check status for every PR
// link on the board. Defaults to 60; a positive-number override wins, anything
// else falls back to the default.
export function prStatusPollSeconds() {
  const v = readConfig().prStatusPollSeconds;
  return typeof v === 'number' && v > 0 ? v : 60;
}

// Whether the server auto-attaches a session's GitHub PR to its links when one
// is discovered (gh, in the session's cwd) on the PR-poll tick. Default on; set
// config.json `autoAttachPr: false` to disable.
export function autoAttachPrEnabled() {
  return readConfig().autoAttachPr !== false;
}

// Whether a PR an agent creates with `gh pr create` gets a `Model: <id>` footer
// naming the session's model (server/pr-footer.js), so PRs can be searched by
// model. Independent of autoAttachPr: the footer never attaches anything. Default
// on; config.json `prModelFooter: false` turns it off. Takes cfg so tests never
// write the shared config.json.
export function prModelFooterEnabled(cfg = readConfig()) {
  return cfg.prModelFooter !== false;
}

export function archiveReviewEnabled(cfg = readConfig()) {
  return extensionSetting('task-memory', 'archiveReviewEnabled', false, cfg) === true;
}

// Whether mail or status notices wake a dormant recipient. Default OFF — mail
// stays unread and status notices are skipped. A wake spends a session's context and
// launches a process nobody asked for. Takes cfg so tests never write the
// shared config.json.
export function mailWakesDormant(cfg = readConfig()) {
  return cfg.mailWakesDormant === true;
}

// Whether a Codex launch/resume/fork marks that invocation's cwd trusted
// (`-c projects."<cwd>".trust_level="trusted"`), skipping Codex's own
// trust-folder prompt — Agent Wrangler already sandboxes the session
// (workspace-write + no approval), so the prompt is pure friction. Default on;
// toggled from the board's settings modal (config.json
// `trustCodexLaunchCwd: false` restores Codex's normal prompt). Takes cfg (like
// archiveReviewEnabled) so tests never write the shared config.json.
export function trustCodexLaunchCwd(cfg = readConfig()) {
  return cfg.trustCodexLaunchCwd !== false;
}

// Whether a Claude launch/resume/fork first marks the scratch-session dir
// (~/.agent-wrangler/sessions, the parent of every blank-cwd launch) trusted in
// ~/.claude.json, so Claude's "trust this folder?" dialog never appears there,
// and mirrors a trusted repo's trust onto a worktree cut from it. Default on; `trustClaudeLaunchCwd: false` restores the normal prompt.
export function trustClaudeLaunchCwd(cfg = readConfig()) {
  return cfg.trustClaudeLaunchCwd !== false;
}

// The board's own settings that config.json held before they moved into the
// board. Only explicit booleans, so the board copies in a choice, never a default.
const LEGACY_BOARD_SETTINGS = ['subagentsExpandedByDefault', 'childFullViewByDefault', 'chatViewDefault'];
export function legacyBoardSettings(cfg = readConfig()) {
  const out = {};
  for (const key of LEGACY_BOARD_SETTINGS) if (typeof cfg[key] === 'boolean') out[key] = cfg[key];
  return out;
}

// The fallback for a session's `autoFixPrChecks` (the PR check-failure and
// merge-conflict pane nudge) when that session has no explicit choice of its
// own — the per-card toggle always wins over this, so flipping the default
// never overrides a card someone has already set by hand. Default on, which is
// exactly the behaviour before the setting existed; toggled from the board's
// settings modal (config.json `autoFixPrChecksDefault: false` leaves
// new/untouched sessions unnudged). Takes cfg (like archiveReviewEnabled) so tests
// never write the shared config.json.
export function autoFixPrChecksDefault(cfg = readConfig()) {
  return cfg.autoFixPrChecksDefault !== false;
}

// Whether the board skips a PR status toast when the owning session already got
// the same notice in its pane. Default on; the toast still shows when the
// session did not get the nudge. Takes cfg so tests never write config.json.
export function suppressNudgedPrToasts(cfg = readConfig()) {
  return cfg.suppressNudgedPrToasts !== false;
}


// The Codex sandbox/approval policy a new Codex session starts from: what the
// dispatch dialog's Advanced options prefill, and what a dispatch with no dialog
// (spawn_session, a schedule) is stored with. Every field is always present, so
// the dialog and Settings show a value rather than "unset"; the defaults are
// core's own default flags (codexPolicyArgs(undefined)). Set from Settings ›
// Sessions (config.json `codexPolicyDefaults`); a hand-edited bad value falls
// back field by field. Takes cfg so tests never write the shared config.json.
export const CODEX_POLICY_DEFAULTS = Object.freeze({ sandbox: 'workspace-write', approval: 'on-request', approveForMe: false, bypass: false });

export function codexPolicyDefaults(cfg = readConfig()) {
  const raw = cfg.codexPolicyDefaults && typeof cfg.codexPolicyDefaults === 'object' ? cfg.codexPolicyDefaults : {};
  return {
    sandbox: CODEX_SANDBOXES.includes(raw.sandbox) ? raw.sandbox : CODEX_POLICY_DEFAULTS.sandbox,
    approval: CODEX_APPROVALS.includes(raw.approval) ? raw.approval : CODEX_POLICY_DEFAULTS.approval,
    approveForMe: typeof raw.approveForMe === 'boolean' ? raw.approveForMe : CODEX_POLICY_DEFAULTS.approveForMe,
    bypass: typeof raw.bypass === 'boolean' ? raw.bypass : CODEX_POLICY_DEFAULTS.bypass,
  };
}

// Flags that were core config keys before their feature became an extension,
// each carried over to `extensions.<extId>` at boot. A row is `{ oldKey, extId }`
// and the key is `<feature>Enabled`-shaped: only an explicit boolean `false`
// ever meant "off" (the old getters were `cfg.x !== false`), so only that moves
// across. A row stays in this table forever: it is a no-op once the key is gone,
// and an install that skipped several releases still needs it. Extracting a
// feature adds a row here; nothing else.
export const RETIRED_FLAGS = [
  { oldKey: 'checklistEnabled', extId: 'checklist' },
  { oldKey: 'taskMemoryEnabled', extId: 'task-memory' },
];

// Config keys that became an extension's own setting, carried to
// `extensionSettings.<extId>.<key>` at boot. A row is `{ oldKey, extId, key,
// envKey?, type? }`. A string (or boolean with `type: 'boolean'`) old value
// moves across unless the setting is already set
// (the human's answer to the new question wins); `envKey` names an environment
// variable that seeds the setting when neither exists, so an install that only
// ever used the env var ends up with the value in Settings and can drop the
// variable. A blank old value just drops the key. Rows stay forever, like
// RETIRED_FLAGS.
export const RETIRED_SETTINGS = [
  { oldKey: 'archiveReviewEnabled', extId: 'task-memory', key: 'archiveReviewEnabled', type: 'boolean' },
  { oldKey: 'jiraBaseUrl', extId: 'jira', key: 'baseUrl', envKey: 'AW_JIRA_BASE_URL' },
];

// Pure: returns the migrated config (a new object) and whether anything moved.
// An explicit `extensions.<extId>` boolean WINS over the old flag (the human
// has already answered the new question) and the old key is deleted either way.
// `true`, a missing key or garbage just drop the key and add nothing, because
// the extension's own default already says what those meant. Idempotent.
export function migrateRetiredFlags(cfg, table = RETIRED_FLAGS, settingsTable = RETIRED_SETTINGS, env = {}) {
  const next = { ...cfg };
  let changed = false;
  for (const { oldKey, extId, key, envKey, type } of settingsTable) {
    const had = Object.hasOwn(next, oldKey);
    const block = next.extensionSettings?.[extId];
    const current = block && typeof block === 'object' && !Array.isArray(block) ? block : {};
    const old = had && typeof next[oldKey] === 'string' ? next[oldKey].trim() : '';
    const seed = type === 'boolean'
      ? (typeof next[oldKey] === 'boolean' ? next[oldKey] : undefined)
      : old || (envKey && typeof env[envKey] === 'string' ? env[envKey].trim() : '');
    if (had) delete next[oldKey];
    if ((type === 'boolean' ? seed !== undefined : Boolean(seed)) && current[key] === undefined) {
      next.extensionSettings = { ...next.extensionSettings, [extId]: { ...current, [key]: seed } };
      changed = true;
    } else if (had) {
      changed = true;
    }
  }
  for (const { oldKey, extId } of table) {
    if (!Object.hasOwn(next, oldKey)) continue;
    changed = true;
    const old = next[oldKey];
    delete next[oldKey];
    const current = next.extensions && typeof next.extensions === 'object' && !Array.isArray(next.extensions) ? next.extensions : {};
    if (old === false && typeof current[extId] !== 'boolean') {
      next.extensions = { ...current, [extId]: false };
    }
  }
  return { cfg: next, changed };
}

// The boot half: read, migrate, and write back only when something moved.
// writeConfig is a shallow MERGE and cannot delete a key, so this writes the
// whole object itself. Must run before the loader reads `extensions.<id>`.
export function applyRetiredFlagMigrations(table = RETIRED_FLAGS, settingsTable = RETIRED_SETTINGS, env = process.env) {
  const { cfg, changed } = migrateRetiredFlags(readConfig(), table, settingsTable, env);
  if (changed) writeJsonAtomic(CONFIG_FILE, cfg, { trailingNewline: true });
  return changed;
}

// Whether an extension (server/extensions/index.js) is enabled on this install:
// an explicit `extensions.<id>` boolean in config.json, else the manifest's own
// default. Non-boolean values are ignored rather than coerced. Takes cfg (like
// archiveReviewEnabled) so tests never write the shared config.json.
export function extensionEnabled(id, defaultEnabled, cfg = readConfig()) {
  const v = cfg.extensions?.[id];
  return typeof v === 'boolean' ? v : Boolean(defaultEnabled);
}

// An extension's own settings VALUES, in a NEW `extensionSettings.<id>.<key>`
// block — deliberately not inside `extensions.<id>`, which is the enable flag
// and is a BOOLEAN. Keeping them apart is what makes it impossible for a
// manifest declaring a setting called `enabled` (or for a hand-edit) to make the
// toggle and a value the same key. Takes cfg (like extensionEnabled) so tests
// never write the shared config.json.
export function extensionSetting(id, key, fallback, cfg = readConfig()) {
  const v = cfg.extensionSettings?.[id]?.[key];
  return v === undefined ? fallback : v;
}

// Every stored value for one extension, as `{ key: value }`. `{}` when nothing
// has ever been set. What extensionsForGraph and host.settings.all() read.
export function extensionSettings(id, cfg = readConfig()) {
  const block = cfg.extensionSettings?.[id];
  return block && typeof block === 'object' && !Array.isArray(block) ? { ...block } : {};
}

// writeConfig is a SHALLOW merge, so BOTH levels are spread by hand — the same
// discipline extension-enabled.js uses for `extensions`. Forgetting the inner
// spread would drop every other setting this extension has; forgetting the
// outer one would drop every other extension's block.
export function setExtensionSetting(id, key, value) {
  const cfg = readConfig();
  const all = cfg.extensionSettings || {};
  return writeConfig({
    extensionSettings: { ...all, [id]: { ...(all[id] || {}), [key]: value } },
  });
}

export const AUTO_UPDATE_MODES = ['off', 'notify', 'auto'];

export function autoUpdateMode(cfg = readConfig()) {
  return AUTO_UPDATE_MODES.includes(cfg.autoUpdate) ? cfg.autoUpdate : 'notify';
}

export function refreshSessionsAfterUpdate(cfg = readConfig()) {
  return cfg.refreshSessionsAfterUpdate === true;
}

export function defaultSessionCwd(cfg = readConfig()) {
  return typeof cfg.defaultSessionCwd === 'string' ? cfg.defaultSessionCwd.trim() : '';
}

// Settings › Automation › Background model, as stored: `{ agent, model }`, or
// null when unset or hand-edited into another shape. Validated against the agent
// registry by server/headless.js backgroundModel, which owns the default (this
// module stays a leaf). Takes cfg so tests never write the shared config.json.
export function backgroundModelConfig(cfg = readConfig()) {
  const raw = cfg.backgroundModel;
  if (!raw || typeof raw !== 'object') return null;
  const agent = typeof raw.agent === 'string' ? raw.agent.trim() : '';
  const model = typeof raw.model === 'string' ? raw.model.trim() : '';
  return agent && model ? { agent, model } : null;
}

// The runtime id the dispatch dialog pre-selects for a new session. Not checked
// against the registry: an extension runtime can be off now and on again later,
// and the dialog falls back to local for any id it doesn't offer.
export function defaultRuntime(cfg = readConfig()) {
  const id = typeof cfg.defaultRuntime === 'string' ? cfg.defaultRuntime.trim() : '';
  return id || 'local';
}
