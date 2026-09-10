import { claude } from './claude.js';
import { codex } from './codex.js';
import { logWarn } from '../log.js';

const ALL = [claude, codex];

export function adapterFor(id) {
  return ALL.find((a) => a.id === id) || claude;
}

export function modelPillFor(agentId, currentModel, launchModel) {
  const models = adapterFor(agentId).models;
  const find = (model) => models.find((entry) => entry.value === model
    || entry.transcriptPrefixes?.some((prefix) => model.startsWith(prefix)));
  if (currentModel) {
    const launchEntry = models.find((entry) => entry.value === launchModel);
    const entry = launchEntry?.transcriptPrefixes?.some((prefix) => currentModel.startsWith(prefix))
      ? launchEntry
      : find(currentModel);
    return { label: entry?.pillLabel || currentModel, title: currentModel };
  }
  if (!launchModel) return null;
  const entry = find(launchModel);
  return entry ? { label: entry.pillLabel, title: launchModel } : { label: launchModel, title: launchModel };
}

// Mint-time floor for the fallback id lookup a discover-id agent (Codex) does when an
// entry has no cached live id. A rollout minted before the card existed cannot be that
// card's conversation, and whatever is resolved gets persisted — so an unbounded scan
// lets a superseded session in a since-reused directory capture the card for good.
// Legacy entries predate createdAt: they keep the old unbounded behaviour rather than
// becoming unresumable.
export function discoveryFloor(entry) {
  const created = Number(entry?.createdAt);
  return Number.isFinite(created) && created > 0 ? created : 0;
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
    logWarn(`[agent-wrangler] AW_DEFAULT_MODEL="${override}" matches no known model; using built-in default`);
  }
}

// ---------------------------------------------------------------------------
// Launch-target validation, for the MCP tools that take `agent`/`model` as free
// strings from an agent rather than from a UI dropdown (spawn_session,
// spawn_workflow, schedule_session). Lives here because the registry owns the
// model vocabulary — see set-session-model.js, which validates a live /model
// switch the same way against the same arrays. There is deliberately no second
// list anywhere: everything below is derived from the adapters.

export function knownAgentIds() {
  return ALL.map((a) => a.id);
}

// An error message when `id` names no adapter, else null. Needed because
// adapterFor FALLS BACK to claude, so an unvalidated `agent: "codx"` quietly
// launches Claude — and must be checked BEFORE the model, or the resulting
// "unknown model for claude" hides the typo that actually caused it.
export function agentError(id) {
  if (id == null || id === '' || ALL.some((a) => a.id === id)) return null;
  return `Unknown agent "${id}". Valid agents: ${knownAgentIds().join(', ')}.`;
}

// An error message when `model` is not one of `agentId`'s launch models, else
// null. Matched on `value` ALONE — never transcriptPrefixes, which exist to map
// a transcript's `message.model` back to a pill and would happily accept
// "claude-opus-5", a string the CLI itself rejects at launch.
//
// The cross-agent case gets its own hint because it is the mistake this check
// exists to catch: spawn's "inherit the caller's model" default only fires for
// the SAME agent, so a deliberate opposite-provider spawn (the
// adversarial-pr-review skill's whole shape) is exactly where a Claude session
// reaches for `model: "opus"` against `agent: "codex"`.
export function modelError(agentId, model) {
  if (model == null || model === '') return null;
  // Self-safe: adapterFor falls back to claude, so an unknown agent would
  // otherwise produce "unknown model … for claude" — the exact misleading
  // message this whole check exists to avoid. launchTargetError already runs
  // agentError first; this makes the guarantee structural rather than a
  // convention a future direct caller has to know about.
  const wrongAgent = agentError(agentId);
  if (wrongAgent) return wrongAgent;
  const adapter = adapterFor(agentId);
  if (adapter.models.some((m) => m.value === model)) return null;
  const other = ALL.find((a) => a !== adapter && a.models.some((m) => m.value === model));
  const hint = other ? ` "${model}" is a ${other.id} model — did you mean agent: "${other.id}"?` : '';
  const valid = adapter.models.map((m) => m.value).join(', ');
  return `Unknown model "${model}" for agent "${adapter.id}". Valid models: ${valid}.${hint}`;
}

// Both checks in the order they must run, for a call site that takes both.
export function launchTargetError(agentId, model) {
  return agentError(agentId) || modelError(agentId, model);
}

// The `model` parameter's own description text on those tools, generated from
// the adapters. This is the ONLY enumeration of the model vocabulary an agent
// ever reads: a tool schema is in context at every call, where a skill body is
// only loaded when the agent judges the skill relevant — which is why the
// spawn-session skill points here rather than keeping a hand-copied table (one
// that had already drifted: `opusplan` was missing from it).
export function modelChoicesText() {
  return ALL
    .map((a) => `${a.id}: ${a.models.map((m) => `${m.value} (${m.label})`).join(', ')}`)
    .join('; ');
}

// The same vocabulary as markdown, for the generated block in the spawn-session
// skill. A second rendering rather than a second SOURCE — both read the adapters.
// It exists because MCP input-schema descriptions are not equally readable to
// every agent: measured in a real Codex session, the parameter descriptions are
// NOT in its initial tool catalog (it had to search the tool declarations to
// reach them), where a loaded SKILL.md body is plainly in front of it. So the
// skill keeps a table after all — generated, never hand-copied.
export function modelTableMarkdown() {
  return ALL.map((a) => {
    const rows = a.models.map((m) => `- \`${m.value}\` — ${m.label}${m.default ? ' (default)' : ''}`);
    return [`**${a.label}** (\`agent: "${a.id}"\`):`, ...rows].join('\n');
  }).join('\n\n');
}
