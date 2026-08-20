import { claude } from './claude.js';
import { codex } from './codex.js';

const ALL = [claude, codex];

export function adapterFor(id) {
  return ALL.find((a) => a.id === id) || claude;
}

export function modelPillFor(agentId, currentModel, launchModel) {
  const models = adapterFor(agentId).models;
  const find = (model) => models.find((entry) => entry.value === model
    || entry.transcriptPrefixes?.some((prefix) => model.startsWith(prefix)));
  if (currentModel) {
    const entry = find(currentModel);
    return { label: entry?.pillLabel || currentModel, title: currentModel };
  }
  if (!launchModel) return null;
  const entry = find(launchModel);
  return entry ? { label: entry.pillLabel, title: launchModel } : { label: launchModel, title: launchModel };
}

export function adapterForProcess(command) {
  return ALL.find((a) => a.matchProcess(command)) || null;
}

// Like adapterForProcess, but for a container-exec wrapper of an agent (the agent
// binary is an argument, not the executable). Returns null for a plain host command.
export function adapterForContainerProcess(command) {
  return ALL.find((a) => a.matchContainerized?.(command)) || null;
}

export function ownedPrefixes() {
  return ALL.map((a) => a.tmuxPrefix);
}

export function isOwnedTmux(name) {
  return ownedPrefixes().some((p) => (name || '').startsWith(p));
}

export async function availableAgents() {
  const flags = await Promise.all(ALL.map((a) => a.isAvailable().catch(() => false)));
  return ALL.filter((_, i) => flags[i]);
}

// The pre-selected model in the dispatch dialog is baked into each adapter via a
// model's `default: true` flag. `AW_DEFAULT_MODEL` lets the service re-point it
// (e.g. launch new sessions on sonnet) without a code change: it re-marks the
// matching model on whichever agent owns that value. An unset or unrecognised
// value leaves the adapter's built-in default standing (see validateDefaultModel).
export function modelsWithDefault(agent, env = process.env) {
  const override = env.AW_DEFAULT_MODEL;
  if (!override || !agent.models.some((m) => m.value === override)) return agent.models;
  return agent.models.map((m) => ({ ...m, default: m.value === override }));
}

// One-shot startup check: warn if AW_DEFAULT_MODEL names a model no agent offers,
// so a typo surfaces in the log instead of silently falling back.
export function validateDefaultModel(env = process.env) {
  const override = env.AW_DEFAULT_MODEL;
  if (!override) return;
  if (!ALL.some((a) => a.models.some((m) => m.value === override))) {
    console.warn(`[agent-wrangler] AW_DEFAULT_MODEL="${override}" matches no known model; using built-in default`);
  }
}
