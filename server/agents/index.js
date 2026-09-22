import { claude } from './claude.js';
import { codex } from './codex.js';
import { codexContextWindow } from './codex-rollout.js';
import { logWarn } from '../log.js';

const ALL = [claude, codex];

export function adapterFor(id) {
  return ALL.find((a) => a.id === id) || claude;
}

// Shared by modelPillFor and maxContextWindowFor: resolve the model ENTRY a
// transcript's live model (or, absent that, the launch model) maps to. Prefers
// the launch entry when its transcriptPrefixes already match the transcript
// model — two launch values can share one prefix (sonnet vs sonnet[1m] both
// transcript as "claude-sonnet-"), and only the launch value tells them apart.
function findModelEntry(models, currentModel, launchModel) {
  const find = (model) => models.find((entry) => entry.value === model
    || entry.transcriptPrefixes?.some((prefix) => model.startsWith(prefix)));
  if (currentModel) {
    const launchEntry = models.find((entry) => entry.value === launchModel);
    return launchEntry?.transcriptPrefixes?.some((prefix) => currentModel.startsWith(prefix))
      ? launchEntry
      : find(currentModel);
  }
  return launchModel ? find(launchModel) || null : null;
}

export function modelPillFor(agentId, currentModel, launchModel) {
  const models = adapterFor(agentId).models;
  if (currentModel) {
    const entry = findModelEntry(models, currentModel, launchModel);
    return { label: entry?.pillLabel || currentModel, title: currentModel };
  }
  if (!launchModel) return null;
  const entry = findModelEntry(models, null, launchModel);
  return entry ? { label: entry.pillLabel, title: launchModel } : { label: launchModel, title: launchModel };
}

// The model's own context-window ceiling — used only to INFER a max-context
// pill for a session with no explicit auto-compaction threshold (see
// state-reader.js). Codex's window is read from its own live-refreshed models
// cache (codexContextWindow); every other agent's is hand-carried on its
// `models` entries (claude.js `contextWindow`). Null when unknown — an unset
// pill is honest, a guessed number is not, which is also why this does NOT
// just call findModelEntry: a transcript model with no disambiguating launch
// value (adopt() deliberately stores `model: null`; so do legacy entries) can
// share one transcriptPrefix across launch values with DIFFERENT windows
// (sonnet vs sonnet[1m], both "claude-sonnet-") — findModelEntry's own
// first-match guess is fine for modelPillFor's label (cosmetic), but here it
// would render a confidently WRONG number, not just a mislabelled one.
export function maxContextWindowFor(agentId, currentModel, launchModel) {
  if (agentId === 'codex') return codexContextWindow(currentModel || launchModel);
  const models = adapterFor(agentId).models;
  if (!currentModel) return launchModel ? (findModelEntry(models, null, launchModel)?.contextWindow ?? null) : null;
  const launchEntry = models.find((entry) => entry.value === launchModel);
  if (launchEntry?.transcriptPrefixes?.some((prefix) => currentModel.startsWith(prefix))) {
    return launchEntry.contextWindow ?? null;
  }
  // No launch value disambiguated this transcript model — stay silent unless
  // every entry it could plausibly be names the SAME window.
  const candidates = models.filter((entry) => entry.value === currentModel
    || entry.transcriptPrefixes?.some((prefix) => currentModel.startsWith(prefix)));
  const windows = new Set(candidates.map((entry) => entry.contextWindow ?? null));
  return windows.size === 1 ? [...windows][0] : null;
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

// An error message when `effort` is not one of `agentId`'s reasoning-effort
// levels, else null. Same shape and same reason as modelError: the levels differ
// per adapter (claude has xhigh/max, codex has minimal) and an unrecognised one
// is either silently dropped or rejected by the CLI in the pane, where the agent
// that spawned the session never sees it. Self-safe against an unknown agent for
// the same reason modelError is.
export function effortError(agentId, effort) {
  if (effort == null || effort === '') return null;
  const wrongAgent = agentError(agentId);
  if (wrongAgent) return wrongAgent;
  const adapter = adapterFor(agentId);
  const efforts = adapter.efforts || [];
  if (efforts.some((e) => e.value === effort)) return null;
  const valid = efforts.map((e) => e.value).join(', ');
  return `Unknown effort "${effort}" for agent "${adapter.id}". Valid efforts: ${valid}.`;
}

// All three checks in the order they must run, for a call site that takes them.
// `effort` is optional: the UI dispatch paths pick it from a dropdown and pass
// nothing here, where the MCP tools take it as a free string from an agent.
export function launchTargetError(agentId, model, effort) {
  return agentError(agentId) || modelError(agentId, model) || effortError(agentId, effort);
}

// The `effort` parameter's own description text on those tools, generated from
// the adapters — the counterpart to modelChoicesText, and for the same reason:
// a tool schema is the only enumeration of the effort vocabulary an agent reads.
export function effortChoicesText() {
  return ALL
    .map((a) => `${a.id}: ${(a.efforts || []).map((e) => e.value).join(', ')}`)
    .join('; ');
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
    // Efforts ride the same generated block rather than a second one: they are
    // per-adapter vocabulary picked at the same moment as the model, and a
    // hand-written list here is exactly the drift this generator exists to stop.
    const efforts = (a.efforts || []).map((e) => `\`${e.value}\``).join(', ');
    const effortRow = efforts ? [`- \`effort\`: ${efforts}`] : [];
    return [`**${a.label}** (\`agent: "${a.id}"\`):`, ...rows, ...effortRow].join('\n');
  }).join('\n\n');
}
