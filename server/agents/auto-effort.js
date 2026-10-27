import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { claudeModelId } from './claude.js';
import { codexDefaultEffort } from './codex-catalog.js';
import { codexHome } from '../codex-trust.js';

// "Auto" effort launches pass no --effort / model_reasoning_effort, so the agent
// picks its own level from the user's and organization's config. This resolves
// that level per model from static reads alone — never by launching the agent —
// so the dispatch dialog (and api.agents()) can say what Auto means here. Null
// when unknown: an honest blank beats a guess.

const LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const CLAUDE_SETTINGS_LEVELS = ['low', 'medium', 'high', 'xhigh'];
const CLAUDE_ENV_LEVELS = [...CLAUDE_SETTINGS_LEVELS, 'max'];

// Claude Code's documented defaults (model-config docs, "Adjust effort level"),
// by full model id. `userTopLevel`: a top-level effortLevel in the USER settings
// file still applies to the model — Opus 5.5 and every model released after it
// ignore that legacy key, so an id missing here ignores it too.
const CLAUDE_BUILTIN = {
  'claude-opus-5-5': { level: 'medium' },
  'claude-sonnet-5-5': { level: 'medium' },
  'claude-haiku-5-5': { level: 'medium' },
  'claude-fable-5-1': { level: 'high', userTopLevel: true },
  'claude-fable-5': { level: 'high', userTopLevel: true },
  'claude-opus-5': { level: 'high', userTopLevel: true },
  'claude-sonnet-5': { level: 'high', userTopLevel: true },
  'claude-opus-4-8': { level: 'high', userTopLevel: true },
  'claude-opus-4-7': { level: 'xhigh', userTopLevel: true },
  'claude-opus-4-6': { level: 'high', userTopLevel: true },
  'claude-sonnet-4-6': { level: 'high', userTopLevel: true },
};

const CONTROL_KEYS = new Set(['wslInheritsWindowsSettings', 'managedSourcesBehavior']);

function claudeConfigDir(env = process.env) {
  return env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

function managedDir(platform = process.platform) {
  if (platform === 'darwin') return '/Library/Application Support/ClaudeCode';
  if (platform === 'linux') return '/etc/claude-code';
  return null;
}

function mdmPlists(platform = process.platform) {
  if (platform !== 'darwin') return [];
  const base = '/Library/Managed Preferences';
  let user = null;
  try { user = os.userInfo().username; } catch { /* no passwd entry */ }
  return [user && path.join(base, user, 'com.anthropic.claudecode.plist'), path.join(base, 'com.anthropic.claudecode.plist')].filter(Boolean);
}

// Every file a resolution reads, so a change to any of them is seen.
export function defaultSourcePaths({ env = process.env, platform = process.platform } = {}) {
  const dir = managedDir(platform);
  return {
    remote: path.join(claudeConfigDir(env), 'remote-settings.json'),
    mdm: mdmPlists(platform),
    managedFile: dir && path.join(dir, 'managed-settings.json'),
    managedDropIns: dir && path.join(dir, 'managed-settings.d'),
    user: path.join(claudeConfigDir(env), 'settings.json'),
    codexConfig: path.join(codexHome(), 'config.toml'),
  };
}

// Parsed file contents, re-read only when the file's mtime or size moves.
const fileMemo = new Map();

function statKey(file) {
  try {
    const st = fs.statSync(file);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return null;
  }
}

function readMemo(file, parse) {
  if (!file) return null;
  const key = statKey(file);
  if (key == null) return null;
  const hit = fileMemo.get(file);
  if (hit?.key === key) return hit.value;
  let value = null;
  try { value = parse(file); } catch { value = null; }
  fileMemo.set(file, { key, value });
  return value;
}

const readJson = (file) => readMemo(file, (f) => {
  const v = JSON.parse(fs.readFileSync(f, 'utf8'));
  return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
});

// A binary MDM plist has no JS parser in reach; plutil ships with macOS, and the
// memo means it only runs when the profile itself changes.
const readPlist = (file) => readMemo(file, (f) => JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', f], { encoding: 'utf8', timeout: 5000 })));

function dropIns(dir) {
  if (!dir) return [];
  try {
    return fs.readdirSync(dir).filter((n) => n.endsWith('.json') && !n.startsWith('.')).sort().map((n) => path.join(dir, n));
  } catch {
    return [];
  }
}

// Nested blocks merge key by key; anything else, the later file wins.
function deepMerge(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b || {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])
      ? deepMerge(out[k], v)
      : v;
  }
  return out;
}

// The settings documents Claude Code would read, as { admin, user }: `admin` is
// the managed sources in Claude Code's own rank order (server-managed, MDM,
// managed-settings.json merged with its drop-ins), absent ones as null.
export function readClaudeSources(paths = defaultSourcePaths()) {
  const mdm = paths.mdm.map(readPlist).find(Boolean) || null;
  const files = [paths.managedFile, ...dropIns(paths.managedDropIns)].map(readJson).filter(Boolean);
  return {
    admin: [readJson(paths.remote), mdm, files.length ? files.reduce(deepMerge, {}) : null],
    user: readJson(paths.user),
  };
}

function hasPolicyKey(doc) {
  return !!doc && Object.entries(doc).some(([k, v]) => !CONTROL_KEYS.has(k) && v !== null);
}

// A modelSettings entry is keyed by canonical id, and also matches the alias,
// a date-suffixed id and the [1m] variant.
function modelEntry(doc, id, value) {
  const settings = doc?.modelSettings;
  if (!settings || typeof settings !== 'object') return null;
  for (const [key, entry] of Object.entries(settings)) {
    const bare = key.replace(/\[1m\]$/, '').replace(/-\d{8}$/, '');
    if (key === value || bare === id) return entry;
  }
  return null;
}

const pick = (v, allowed) => (allowed.includes(v) ? v : null);
const rank = (level) => LEVELS.indexOf(level);

// Claude Code's resolution order (model-config docs): CLAUDE_CODE_EFFORT_LEVEL,
// then the highest settings file that sets a level for the model, then the
// model's default; then the lowest maxEffortLevel cap from any source. The
// variable only counts from a settings `env` block: launches strip every
// CLAUDE_CODE_* from the wrangler's own environment (withCleanClaudeEnv).
// Project settings depend on the session's directory, so they are not read.
export function resolveClaudeAutoEffort(value, { admin = [], user = null } = {}) {
  const id = claudeModelId(value);
  if (!id) return null;
  const builtin = CLAUDE_BUILTIN[id];

  const envDoc = [...admin, user].find((d) => pick(d?.env?.CLAUDE_CODE_EFFORT_LEVEL, CLAUDE_ENV_LEVELS));
  let level = envDoc ? envDoc.env.CLAUDE_CODE_EFFORT_LEVEL : null;

  if (!level) {
    // First-wins by default: only the highest managed source with a policy key
    // applies, unless that source opts every admin source in with "merge".
    const present = admin.filter(hasPolicyKey);
    const managed = present[0]?.managedSourcesBehavior === 'merge' ? present : present.slice(0, 1);
    for (const doc of managed) {
      level = pick(modelEntry(doc, id, value)?.effortLevel, CLAUDE_SETTINGS_LEVELS) || pick(doc.effortLevel, CLAUDE_SETTINGS_LEVELS);
      if (level) break;
    }
  }
  if (!level && user) {
    level = pick(modelEntry(user, id, value)?.effortLevel, CLAUDE_SETTINGS_LEVELS)
      || (builtin?.userTopLevel ? pick(user.effortLevel, CLAUDE_SETTINGS_LEVELS) : null);
  }
  level ||= builtin?.level || null;
  if (!level) return null;

  // A per-model cap replaces its source's top-level one; "max" sets none.
  for (const doc of [...admin, user]) {
    if (!doc) continue;
    const cap = pick(modelEntry(doc, id, value)?.maxEffortLevel ?? doc.maxEffortLevel, CLAUDE_ENV_LEVELS);
    if (cap && cap !== 'max' && rank(cap) < rank(level)) level = cap;
  }
  return level;
}

// The top-level `model_reasoning_effort` in Codex's config.toml: only lines
// before the first [table] header are top-level keys.
export function parseCodexConfigEffort(text) {
  for (const line of String(text).split('\n')) {
    if (/^\s*\[/.test(line)) break;
    const m = /^\s*model_reasoning_effort\s*=\s*["']([^"']*)["']/.exec(line);
    if (m) return m[1] || null;
  }
  return null;
}

// Codex: config.toml's level applies to every model, else each model's own
// default_reasoning_level from its catalog.
export function resolveCodexAutoEffort(slug, { configEffort = null } = {}) {
  return configEffort || codexDefaultEffort(slug);
}

function readCodexConfigEffort(file) {
  return readMemo(file, (f) => parseCodexConfigEffort(fs.readFileSync(f, 'utf8')));
}

// The agents frame's models with `autoEffort` added where it is known.
export function withAutoEffort(agentId, models, paths = defaultSourcePaths()) {
  let resolve;
  if (agentId === 'claude') {
    const sources = readClaudeSources(paths);
    resolve = (value) => resolveClaudeAutoEffort(value, sources);
  } else if (agentId === 'codex') {
    const configEffort = readCodexConfigEffort(paths.codexConfig);
    resolve = (value) => resolveCodexAutoEffort(value, { configEffort });
  } else {
    return models;
  }
  return models.map((m) => {
    const autoEffort = resolve(m.value);
    return autoEffort ? { ...m, autoEffort } : m;
  });
}

// A cheap fingerprint of every source file (mtimes and sizes, no reads).
export function sourcesSignature(paths = defaultSourcePaths()) {
  const files = [paths.remote, ...paths.mdm, paths.managedFile, ...dropIns(paths.managedDropIns), paths.user, paths.codexConfig];
  return files.filter(Boolean).map((f) => `${f}=${statKey(f)}`).join('\n');
}

// Calls onChange when any source file changes, so open boards re-receive the
// agents frame. Polls stats rather than fs.watch: several of these files are
// replaced by rename, and some directories may not exist yet.
export function watchAutoEffortSources(onChange, intervalMs = 15_000) {
  let last = sourcesSignature();
  const t = setInterval(() => {
    const next = sourcesSignature();
    if (next === last) return;
    last = next;
    onChange();
  }, intervalMs);
  t.unref?.();
  return t;
}
