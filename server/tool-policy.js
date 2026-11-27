import crypto from 'node:crypto';
import semver from 'semver';

// Required tool policies: tools an enabled extension says no agent Agent
// Wrangler launches may call. A manifest declares `toolPolicy`, a function
// asked on every launch (dispatch, spawn, resume, restore, mail and snooze
// wakes, fork) BEFORE anything is created or killed:
//
//   toolPolicy({ sid, parentId?, task, agent, runtime, reason, host })
//     -> { rules: [{ tool | pattern, agents?, reason? }] } | Promise of it
//
//   tool    — one exact tool name as the agent itself names it
//             (`mcp__server__tool` for Claude and Codex, `mcp(server/tool)`
//             for agy).
//   pattern — a regular expression over those names, anchored at both ends.
//             Lookaround and backreferences are refused: Codex matches hooks
//             with a regex engine that has neither.
//   agents  — the agent ids the rule applies to; every agent when omitted.
//   reason  — the single line the agent is shown when a call is blocked.
//
// FAIL-CLOSED. Unlike `session.launchContext`, where a broken extension is
// skipped, anything that keeps a policy from being collected or enforced
// refuses the launch: the callback throwing, timing out or answering anything
// malformed; an agent or runtime that cannot enforce a rule; and an extension
// whose requirement was recorded but is not running now (quarantined, missing,
// failed to load). The requirement is recorded in config.json the first time
// the extension is active, and only a human turning it off or uninstalling it
// clears it (clearToolPolicyRequirement).
//
// Enforcement is the agents' own: Claude gets `permissions.deny` for exact
// names plus a blocking PreToolUse hook per rule, Codex a synchronous trusted
// PreToolUse hook per rule, agy `permissions.deny` (exact names only). The
// hook is an inline shell command, so nothing needs to exist on disk wherever
// the agent runs. These are native-tool controls: a process running as the
// same OS user can still reach the human's credentials directly.

export const TOOL_POLICY_TIMEOUT_MS = 5000;
export const TOOL_POLICY_CONFIG_KEY = 'toolPolicyRequirements';
const MAX_RULES = 200;
const TOOL_RE = /^[\x21-\x7e]{1,200}$/;
const FORBIDDEN_TOOL_CHARS = /['"`\\]/;
const REASON_RE = /^[\x20-\x7e]{1,200}$/;
const POLICY_KEYS = new Set(['rules']);
const RULE_KEYS = new Set(['tool', 'pattern', 'agents', 'reason']);
const HOOK_TIMEOUT_SEC = 10;

export class ToolPolicyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ToolPolicyError';
    this.code = 'tool-policy';
  }
}

const fail = (message) => { throw new ToolPolicyError(message); };

function patternProblem(source) {
  if (typeof source !== 'string' || !source || source.length > 500 || /[\u0000-\u001f\u007f]/.test(source)) {
    return 'pattern must be a single-line regular expression of 1-500 characters';
  }
  if (/\(\?<?[=!]/.test(source)) return 'pattern may not use lookaround';
  if (/\\[1-9]|\\k</.test(source)) return 'pattern may not use a backreference';
  try { new RegExp(source); } catch { return 'pattern does not compile'; }
  return null;
}

export function normalizeToolPolicy(extId, out, { agentIds }) {
  const where = `Extension ${extId} tool policy`;
  if (!out || typeof out !== 'object' || Array.isArray(out)) fail(`${where} must return { rules }`);
  for (const k of Object.keys(out)) if (!POLICY_KEYS.has(k)) fail(`${where}: unknown key "${k}"`);
  if (!Array.isArray(out.rules)) fail(`${where}: rules must be an array`);
  if (out.rules.length > MAX_RULES) fail(`${where}: at most ${MAX_RULES} rules`);
  return out.rules.map((r, i) => {
    const at = `${where}: rule ${i}`;
    if (!r || typeof r !== 'object' || Array.isArray(r)) fail(`${at} must be an object`);
    for (const k of Object.keys(r)) if (!RULE_KEYS.has(k)) fail(`${at}: unknown key "${k}"`);
    if ((r.tool === undefined) === (r.pattern === undefined)) fail(`${at} must have exactly one of tool or pattern`);
    if (r.tool !== undefined && (typeof r.tool !== 'string' || !TOOL_RE.test(r.tool) || FORBIDDEN_TOOL_CHARS.test(r.tool))) {
      fail(`${at}: tool must be 1-200 printable characters with no spaces or quotes`);
    }
    if (r.pattern !== undefined) {
      const problem = patternProblem(r.pattern);
      if (problem) fail(`${at}: ${problem}`);
    }
    let agents = null;
    if (r.agents !== undefined) {
      if (!Array.isArray(r.agents) || !r.agents.length) fail(`${at}: agents must be a non-empty array of agent ids`);
      for (const a of r.agents) if (!agentIds.includes(a)) fail(`${at}: unknown agent "${a}" (known: ${agentIds.join(', ')})`);
      agents = [...new Set(r.agents)];
    }
    if (r.reason !== undefined && (typeof r.reason !== 'string' || !REASON_RE.test(r.reason))) {
      fail(`${at}: reason must be one printable line of at most 200 characters`);
    }
    return {
      extId,
      kind: r.tool !== undefined ? 'tool' : 'pattern',
      value: r.tool ?? r.pattern,
      agents,
      reason: r.reason ?? `Blocked by an Agent Wrangler tool policy (${extId}).`,
    };
  });
}

function withTimeout(promise, ms, onTimeout) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new ToolPolicyError(onTimeout())), ms); }),
  ]).finally(() => clearTimeout(timer));
}

function inactiveReason(entry) {
  if (!entry) return 'is not installed or failed to load';
  if (entry.quarantine) return `is quarantined: ${entry.quarantine}`;
  if (entry.enabled) return 'no longer declares one';
  return 'is disabled';
}

export function policyFingerprint(sources, rules) {
  const body = JSON.stringify({ sources, rules: rules.map(({ extId, kind, value, agents, reason }) => [extId, kind, value, agents, reason]) });
  return crypto.createHash('sha256').update(body).digest('hex').slice(0, 16);
}

// The policy for one launch: `{ sources, rules, fingerprint }`, frozen, or
// null when no extension declares one and none is required. Throws a
// ToolPolicyError, which the caller turns into a refused launch.
export async function collectToolPolicy(
  { sid = null, parentId, task = null, agent = 'claude', runtime = 'local', reason = 'dispatch' } = {},
  { ext, required = [], hostApiFor = () => undefined, timeoutMs = TOOL_POLICY_TIMEOUT_MS, agentIds } = {},
) {
  const contributors = ext?.toolPolicies || [];
  const active = new Set(contributors.map((c) => c.id));
  for (const id of required) {
    if (!active.has(id)) fail(`Launch refused: the ${id} extension requires a tool policy but ${inactiveReason(ext?.list?.find((e) => e.id === id))}. Fix or turn off the extension in Settings › Extensions.`);
  }
  if (!contributors.length) return null;
  const rules = [];
  for (const { id, fn } of contributors) {
    let out;
    try {
      out = await withTimeout(
        Promise.resolve().then(() => fn({ sid, task, agent, runtime, reason, ...(parentId === undefined ? {} : { parentId }), host: hostApiFor(id) })),
        timeoutMs,
        () => `Launch refused: the ${id} extension's tool policy did not answer within ${timeoutMs} ms.`,
      );
    } catch (err) {
      if (err instanceof ToolPolicyError) throw err;
      fail(`Launch refused: the ${id} extension's tool policy failed: ${err?.message || err}`);
    }
    rules.push(...normalizeToolPolicy(id, out, { agentIds }));
  }
  const sources = contributors.map((c) => c.id);
  return deepFreeze({ sources, rules, fingerprint: policyFingerprint(sources, rules) });
}

function deepFreeze(v) {
  if (v && typeof v === 'object') {
    for (const x of Object.values(v)) deepFreeze(x);
    Object.freeze(v);
  }
  return v;
}

export function rulesForAgent(policy, agent) {
  return (policy?.rules || []).filter((r) => !r.agents || r.agents.includes(agent));
}

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const ruleSource = (rule) => (rule.kind === 'tool' ? escapeRegex(rule.value) : rule.value);

export function policyMatcher(rules) {
  return `^(?:${rules.map(ruleSource).join('|')})$`;
}

export function ruleMatchesTool(rule, toolName) {
  return new RegExp(policyMatcher([rule])).test(toolName);
}

const quote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

export function denyCommand(reason) {
  return `echo ${quote(reason)} >&2; exit 2`;
}

// Why this launch cannot carry the policy, or null. Asked once the agent and
// runtime are known and before anything is created.
export function toolPolicyRefusal(policy, { agent, adapter, runtime }) {
  const rules = rulesForAgent(policy, agent);
  if (!rules.length) return null;
  const owners = [...new Set(rules.map((r) => r.extId))].join(', ');
  const label = adapter?.label || agent;
  if (!adapter?.toolPolicy) return `Launch refused: ${label} can't enforce the tool policy required by ${owners}.`;
  if (!adapter.toolPolicy.patterns && rules.some((r) => r.kind === 'pattern')) {
    return `Launch refused: ${label} can't enforce pattern rules in the tool policy required by ${owners}.`;
  }
  if (runtime?.buildLaunch) return `Launch refused: runtime ${runtime.id} builds its own launch, so it can't carry the tool policy required by ${owners}.`;
  if (runtime?.toolPolicy !== true) return `Launch refused: the ${runtime?.label || runtime?.id || 'unknown'} runtime does not carry tool policies, which ${owners} requires.`;
  return null;
}

// Why the installed CLI cannot be trusted with the rules, or null: enforcement
// is only claimed from the version it was verified on (`toolPolicy.minVersion`).
export function toolPolicyVersionRefusal(adapter, version) {
  const floor = adapter?.toolPolicy?.minVersion;
  if (!floor) return null;
  const label = adapter.label || adapter.id;
  if (!version || !semver.valid(version)) return `Launch refused: could not read the installed ${label} version to check it enforces tool policies.`;
  if (semver.lt(version, floor)) return `Launch refused: ${label} ${version} is older than ${floor}, the oldest version verified to enforce tool policies. Update ${label}.`;
  return null;
}

// The `--settings` keys a Claude launch adds for its rules, or null.
export function claudeToolPolicySettings(rules) {
  if (!rules.length) return null;
  return {
    disableAllHooks: false,
    permissions: { deny: rules.filter((r) => r.kind === 'tool').map((r) => r.value) },
    hooks: {
      PreToolUse: rules.map((r) => ({
        matcher: policyMatcher([r]),
        hooks: [{ type: 'command', command: denyCommand(r.reason), timeout: HOOK_TIMEOUT_SEC, onFailure: 'block' }],
      })),
    },
  };
}

// Codex hooks (codex-hook-config.js codexHookOverrides) for the rules.
export function codexToolPolicyHooks(rules) {
  return rules.map((r) => ({ event: 'PreToolUse', matcher: policyMatcher([r]), command: denyCommand(r.reason), async: false }));
}

// agy `permissions.deny` entries. agy matches whole names only (verified on
// 1.5.18: `mcp(*/probe_w*)` blocks nothing), so a pattern cannot be carried.
export function agyToolPolicyDeny(rules) {
  return rules.map((r) => {
    if (r.kind !== 'tool') throw new ToolPolicyError(`agy can't enforce the pattern rule of ${r.extId}`);
    return r.value;
  });
}

// Whether a one-tool background run of `tool` for extension `callerId` is
// blocked by ANOTHER extension's rules. The caller's own rules are exempt for
// its own run; nothing else is.
export function headlessToolRefusal(policy, tool, callerId) {
  const hit = rulesForAgent(policy, 'claude').find((r) => r.extId !== callerId && ruleMatchesTool(r, tool));
  return hit ? `${hit.extId}'s tool policy blocks ${tool}.` : null;
}

export function toolPolicyRequirements(cfg) {
  const v = cfg?.[TOOL_POLICY_CONFIG_KEY];
  return v && typeof v === 'object' && !Array.isArray(v) ? Object.keys(v) : [];
}

const requirementsOf = (cfg) => {
  const v = cfg?.[TOOL_POLICY_CONFIG_KEY];
  return v && typeof v === 'object' && !Array.isArray(v) ? { ...v } : {};
};

// Whether a row's manifest declares a policy and is switched on: enabled, or
// quarantined (by a failed first activation too) without an explicit off in
// config. Fail-closed: a declared policy counts before it has ever run.
export function declaresToolPolicy(e, cfg) {
  if (!e?.toolPolicy) return false;
  return e.quarantine ? cfg?.extensions?.[e.id] !== false : Boolean(e.enabled);
}

// Records a requirement for every row that declares a policy and is switched
// on. Never removes one: only a human turning the extension off or
// uninstalling it does (clearToolPolicyRequirement). An update that drops
// `toolPolicy` keeps its requirement, so its launches refuse until a human
// turns it off.
export function syncToolPolicyRequirements(list, { cfg, write, now = Date.now }) {
  const next = requirementsOf(cfg);
  let changed = false;
  for (const e of list) {
    if (declaresToolPolicy(e, cfg) && !next[e.id]) { next[e.id] = { since: new Date(now()).toISOString() }; changed = true; }
  }
  if (changed) Object.assign(cfg, write({ [TOOL_POLICY_CONFIG_KEY]: next }));
  return changed;
}

// The ids a launch must collect a policy from: recorded in config, declared
// and switched on now, or remembered by this process (so a requirement whose
// write failed still holds until restart).
export function requiredToolPolicyIds({ cfg, list = [], remembered = new Set() }) {
  return [...new Set([...toolPolicyRequirements(cfg), ...list.filter((e) => declaresToolPolicy(e, cfg)).map((e) => e.id), ...remembered])];
}

export function clearToolPolicyRequirement(id, { cfg, write }) {
  const next = requirementsOf(cfg);
  if (!next[id]) return false;
  delete next[id];
  Object.assign(cfg, write({ [TOOL_POLICY_CONFIG_KEY]: next }));
  return true;
}
