import { registeredAgents, modelsWithDefault, resolvedModelId } from './index.js';
import { withAutoEffort } from './auto-effort.js';

// The model list the dispatch dialog and the client `api.agents()` read: the
// adapter's live models with the AW_DEFAULT_MODEL re-pointing, each model's Auto
// effort, and `resolved`, the full id the value runs today (opus →
// claude-opus-5-5; null when it runs more than one, opusplan).
export function dispatchModels(adapter, env = process.env) {
  return withAutoEffort(adapter, modelsWithDefault(adapter, env))
    .map((m) => ({ ...m, resolved: resolvedModelId(adapter, m.value) }));
}

// What a host launching an agent may lean on, read off the adapter rather than
// its id, so a new adapter answers for itself:
//   disallowedTools  — spawn({ disallowedTools }) is honoured on launch, fork and resume.
//   remoteControl    — spawn({ remoteControl }) gives it phone control.
//   askUserTool      — the tool that asks the human in the pane, which a host
//                      blocks (through disallowedTools) when nobody watches; null if none.
//   sandbox          — it runs under an OS sandbox an extension's codexPolicy
//                      shapes, whose `addDirs` are its extra writable folders.
//   mailWhileWorking — mail reaches it mid-turn; without it, a paste waits for idle.
export function agentCapabilities(adapter) {
  return {
    disallowedTools: adapter.supportsDisallowedTools === true,
    remoteControl: adapter.supportsRemoteControl === true,
    askUserTool: adapter.askUserTool || null,
    sandbox: adapter.launch?.codexPolicy === true,
    mailWhileWorking: adapter.terminal?.socketMail === true,
  };
}

// `host.agents.list()`: every registered agent, installed or not, with what it
// offers. Models carry `efforts` (the effort values a launch of that model accepts) and
// `autoEffort` (what it runs at with none passed, null when unknown).
export async function agentList({ adapters = registeredAgents(), env = process.env } = {}) {
  const available = await Promise.all(adapters.map((a) => Promise.resolve().then(() => a.isAvailable()).catch(() => false)));
  return adapters.map((a, i) => {
    const efforts = (a.efforts || []).map(({ value, label }) => ({ value, label }));
    return {
      id: a.id,
      label: a.label,
      available: available[i] === true,
      models: dispatchModels(a, env).map((m) => ({
        value: m.value,
        resolved: m.resolved,
        label: m.label ?? m.value,
        default: m.default === true,
        efforts: (a.effortsForModel?.(m.value) ?? efforts).map((e) => e.value),
        autoEffort: m.autoEffort ?? null,
      })),
      efforts,
      capabilities: agentCapabilities(a),
    };
  });
}
