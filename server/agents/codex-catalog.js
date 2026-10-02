import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { logWarn } from '../log.js';

const exec = promisify(execFile);

// Codex's own model catalog — `codex debug models`, the same list its /model
// picker shows (bundled with the binary, refreshed from OpenAI) — so the dispatch
// dialog, launch validation and effort list follow Codex without a code change.
// Until the first refresh lands (or when it fails) the bundled snapshot stands
// in; `npm run gen:catalog` refreshes it.
const SNAPSHOT_PATH = new URL('./codex-models.snapshot.json', import.meta.url);
const REFRESH_MS = 60 * 60 * 1000;

// gpt-6-sol is confirmed to launch on a ChatGPT-account login (the `*-codex`
// ids are API-key-only) — preferred as the default while Codex lists it,
// otherwise Codex's own first-listed model.
const PREFERRED_DEFAULT = 'gpt-6-sol';

const EFFORT_LABELS = { minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max', ultra: 'Ultra' };

// The raw `codex debug models` JSON → the few fields we use, listed models in
// Codex's own priority order.
export function reduceCodexCatalog(raw) {
  const models = Array.isArray(raw?.models) ? raw.models : [];
  return models
    .filter((m) => m && typeof m.slug === 'string')
    .map((m) => ({
      slug: m.slug,
      displayName: m.display_name || m.slug,
      description: m.description || '',
      visibility: m.visibility || 'list',
      priority: Number.isFinite(m.priority) ? m.priority : 1000,
      efforts: (m.supported_reasoning_levels || []).map((l) => l?.effort).filter(Boolean),
      contextWindow: Number.isFinite(m.context_window) ? m.context_window : null,
    }))
    .sort((a, b) => a.priority - b.priority);
}

function readSnapshot() {
  try { return JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf8')).models || []; } catch { return []; }
}

const snapshot = readSnapshot();
let live = null;
let liveVersion = 0;
let derived = null;
const listeners = new Set();

function catalog() {
  return live || snapshot;
}

// "gpt-6-sol" → "gpt-6 sol", "gpt-5.4-mini" → "gpt-5.4 mini".
function pillLabelFor(slug) {
  return slug.replace(/-(?=[a-z])/g, ' ');
}

function derive() {
  const listed = catalog().filter((m) => m.visibility === 'list');
  const def = listed.some((m) => m.slug === PREFERRED_DEFAULT) ? PREFERRED_DEFAULT : listed[0]?.slug;
  const models = listed.map((m) => ({
    value: m.slug,
    label: m.description ? `${m.displayName} · ${m.description.replace(/\.$/, '')}` : m.displayName,
    pillLabel: pillLabelFor(m.slug),
    ...(m.slug === def ? { default: true } : {}),
  }));
  // The union across models, longest list first so its order leads: the list is
  // per-AGENT where Codex's is per-MODEL, and refusing a level some model offers
  // is the worse failure (the service decides per model).
  const order = [];
  for (const m of [...listed].sort((a, b) => b.efforts.length - a.efforts.length)) {
    for (const e of m.efforts) if (!order.includes(e)) order.push(e);
  }
  const efforts = order.map((value) => ({ value, label: EFFORT_LABELS[value] || value[0].toUpperCase() + value.slice(1) }));
  return { models, efforts, defaultModel: def || PREFERRED_DEFAULT };
}

function current() {
  if (!derived) derived = derive();
  return derived;
}

export function codexModels() {
  return current().models;
}

export function codexEfforts() {
  return current().efforts;
}

export function defaultCodexModel() {
  return current().defaultModel;
}

// The context window Codex itself reported this run, or null before the first
// refresh (callers then fall back to Codex's on-disk models cache).
export function liveCodexContextWindow(slug) {
  return live?.find((m) => m.slug === slug)?.contextWindow ?? null;
}

// Bumps whenever a refresh changes the catalog — fold into caches of derived values.
export function codexCatalogVersion() {
  return liveVersion;
}

export function onCodexCatalogChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

async function runCodexDebugModels() {
  const { stdout } = await exec('codex', ['debug', 'models'], { timeout: 30_000, maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(stdout);
}

// Re-read the catalog from the installed Codex CLI. Returns true when it changed.
// Never throws — a failed read (no codex, bad output) keeps the current list.
export async function refreshCodexCatalog({ run = runCodexDebugModels } = {}) {
  let next;
  try {
    next = reduceCodexCatalog(await run());
  } catch (err) {
    // No codex on PATH is the normal state for a Claude-only install.
    if (err.code !== 'ENOENT') logWarn(`[agent-wrangler] codex model catalog refresh failed: ${err.message}`);
    return false;
  }
  if (!next.some((m) => m.visibility === 'list')) return false;
  const changed = JSON.stringify(next) !== JSON.stringify(live);
  live = next;
  if (changed) {
    derived = null;
    liveVersion += 1;
    for (const fn of listeners) fn();
  }
  return changed;
}

export function startCodexCatalogRefresh() {
  refreshCodexCatalog();
  const t = setInterval(() => refreshCodexCatalog(), REFRESH_MS);
  t.unref?.();
  return t;
}

// Test seam: reset to the bundled snapshot.
export function _resetCodexCatalogForTest() {
  live = null;
  derived = null;
}
