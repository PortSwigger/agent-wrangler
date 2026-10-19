import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { logWarn } from '../log.js';

const exec = promisify(execFile);

// Pi's own model catalog — `pi --list-models`, the models pi has credentials
// for across every provider it knows — so the dispatch dialog and launch
// validation follow the user's pi setup without a code change. A model is named
// `provider/id`, the exact form `pi --model` takes, so two providers serving the
// same id (an Anthropic model direct and through a gateway) stay distinct.
//
// When pi's settings.json scopes the model cycle (`enabledModels`, the list
// Ctrl+P walks), only those are offered: a user who has narrowed pi to a few
// models does not want the dialog to list every one their keys could reach.
// Pi's `defaultProvider`/`defaultModel` marks the default.
const REFRESH_MS = 60 * 60 * 1000;

// `pi --thinking` levels, in pi's own order.
export const PI_EFFORTS = [
  { value: 'off', label: 'Off' },
  { value: 'minimal', label: 'Minimal' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'Extra high' },
  { value: 'max', label: 'Max' },
];

export function piAgentDir(env = process.env) {
  return env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent');
}

// "128K" → 128000, "1.0M" → 1000000; null when unreadable.
function parseTokens(s) {
  const m = String(s || '').match(/^([\d.]+)([KM]?)$/i);
  if (!m) return null;
  const n = Number(m[1]) * ({ K: 1000, M: 1_000_000 }[m[2].toUpperCase()] || 1);
  return Number.isFinite(n) ? Math.round(n) : null;
}

// The `pi --list-models` table → [{ provider, id, contextWindow, thinking }].
// Columns are whitespace-separated and none of the first two hold spaces, so a
// split is exact; the header row is recognised by its own column names.
export function parseListModels(stdout) {
  const out = [];
  for (const line of String(stdout || '').split('\n')) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 2 || (cols[0] === 'provider' && cols[1] === 'model')) continue;
    const [provider, id, context, , thinking] = cols;
    out.push({ provider, id, contextWindow: parseTokens(context), thinking: thinking === 'yes' });
  }
  return out;
}

// `enabledModels` patterns: exact `provider/id`, a bare id, or a `*` glob.
function matchesPattern(model, pattern) {
  const full = `${model.provider}/${model.id}`;
  const p = String(pattern || '').replace(/:[a-z]+$/, '');
  if (!p.includes('*')) return p === full || p === model.id;
  const re = new RegExp(`^${p.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
  return re.test(full) || re.test(model.id);
}

function readSettings(dir = piAgentDir()) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')) || {}; } catch { return {}; }
}

export function derivePiModels(listed, settings = {}) {
  const scoped = Array.isArray(settings.enabledModels) && settings.enabledModels.length
    ? listed.filter((m) => settings.enabledModels.some((p) => matchesPattern(m, p)))
    : listed;
  const models = scoped.length ? scoped : listed;
  const isDefault = (m) => m.id === settings.defaultModel
    && (!settings.defaultProvider || m.provider === settings.defaultProvider);
  const def = models.find(isDefault) || models[0];
  return models.map((m) => ({
    value: `${m.provider}/${m.id}`,
    label: `${m.id} · ${m.provider}`,
    pillLabel: m.id,
    // Pi's assistant messages name the bare model id, never the provider.
    transcriptPrefixes: [m.id],
    ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}),
    ...(m === def ? { default: true } : {}),
  }));
}

let live = [];
let derived = null;
let version = 0;
const listeners = new Set();

export function piModels() {
  if (!derived) derived = derivePiModels(live, readSettings());
  return derived;
}

export function defaultPiModel() {
  return piModels().find((m) => m.default)?.value || null;
}

export function piCatalogVersion() {
  return version;
}

export function onPiCatalogChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

async function runListModels() {
  const { stdout } = await exec('pi', ['--list-models', '--offline'], { timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

// Re-read the catalog from the installed pi CLI. Returns true when it changed.
// Never throws — no pi on PATH is the normal state for an install without it.
export async function refreshPiCatalog({ run = runListModels, settings = readSettings } = {}) {
  let next;
  try {
    next = parseListModels(await run());
  } catch (err) {
    if (err.code !== 'ENOENT') logWarn(`[agent-wrangler] pi model catalog refresh failed: ${err.message}`);
    return false;
  }
  if (!next.length) return false;
  const nextDerived = derivePiModels(next, settings());
  const changed = JSON.stringify(nextDerived) !== JSON.stringify(derived);
  live = next;
  derived = nextDerived;
  if (changed) {
    version += 1;
    for (const fn of listeners) fn();
  }
  return changed;
}

export function startPiCatalogRefresh() {
  refreshPiCatalog();
  const t = setInterval(() => refreshPiCatalog(), REFRESH_MS);
  t.unref?.();
  return t;
}

export function _resetPiCatalogForTest() {
  live = [];
  derived = null;
}
