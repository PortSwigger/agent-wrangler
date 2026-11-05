import { adapterFor } from './agents/index.js';
import path from 'node:path';
import { getExtensions, hookPayloadFor } from './extensions/index.js';
import { tomlString } from './codex-notify-config.js';
import { logError } from './log.js';

// The `session.launchContext` seam: what a session's launch needs from the
// extensions that are on. Each enabled extension's `hooks['session.launchContext']`
// is asked, per launch, and answers
// `{ env?, secretEnv?, addDirs?, codexConfig?, claudeHooks?, refuse?, refuseIfSet? }`:
//   refuse  — a non-empty reason that fails the launch; later hooks are not asked.
//   refuseIfSet — UPPER_SNAKE variable names checked in the pane itself, after
//             the user's shell has started (tmux global env, ~/.zshenv), where
//             this server cannot see: the launch exits naming the first one set
//             (even to empty) before the agent runs. Values are never read.
//   env     — extra environment variables for the agent process (task-memory's
//             AW_TASK_MEMORY). Names must be UPPER_SNAKE (they are written into a
//             shell command line); values are strings and are quoted by the
//             adapter. Core's own variables are written AFTER these, so an
//             extension can never override AW_SESSION_ID and friends.
//   secretEnv — like `env`, but for values that must never be written where
//             another process or a person can read them: argv, the tmux pane
//             command, logs, the graph or the mappings file. A pane launch writes
//             them to a 0600 file the pane sources and deletes before the agent
//             starts (launch-secrets.js); a headless launch gets them in-process
//             (launchProcessEnv). A name in both wins as a secret. Never cached in
//             lastBySession and never named with its value in any log line.
//   addDirs — extra directories the agent is granted (`--add-dir`), absolute.
//   codexConfig — nonsecret Codex config overrides, `{ 'dotted.key': value }`,
//             passed to a Codex launch as `-c key=value` (Claude ignores them).
//             Values are strings, finite numbers or booleans and core writes the
//             TOML. Keys core or codexPolicy own, and credential-shaped keys or
//             values, are dropped: they land in argv, `ps` and the tmux pane.
//   claudeHooks — Claude Code hooks for this launch, `{ PreToolUse?, PostToolUse? }`,
//             each a list of `{ matcher?, hooks: [{ type: 'command', command, timeout? }] }`
//             groups. Appended AFTER core's own groups in the launch's --settings,
//             so an extension adds hooks but never displaces core's PR-attach hook.
//             Codex ignores them. The command is visible in argv like the rest of
//             --settings, so it must carry no secret.
// The hook may be async and may do work (task-memory binds the session's
// by-session symlink here), so callers AWAIT collectLaunchContext before they
// build the launch command. Reasons a launch asks:
//   dispatch | resume | fork | message | snooze-wake | spawn | assign | adopt | headless
// `assign` and `adopt` are not launches (a running session was re-pointed, or
// the server adopted it at boot); the hook still runs so side effects land and
// the caller discards the result.
//
// Fork payloads include parentId, the parent card id, before inherited state is saved.
// A hook that throws, or answers something unusable, is logged and skipped:
// one broken extension must not keep a session from launching.
export const LAUNCH_REASONS = ['dispatch', 'resume', 'fork', 'message', 'snooze-wake', 'spawn', 'assign', 'adopt', 'headless'];

export const CLAUDE_HOOK_EVENTS = ['PreToolUse', 'PostToolUse'];

export const EMPTY_LAUNCH_CONTEXT = Object.freeze({ env: Object.freeze({}), addDirs: Object.freeze([]) });

const ENV_NAME_RE = /^[A-Z][A-Z0-9_]*$/;

const CODEX_KEY_RE = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/;
const CODEX_VALUE_MAX = 1024;
const CODEX_RESERVED = [
  'developer_instructions', 'notify', 'mcp_servers', 'model', 'model_reasoning_effort', 'model_auto_compact_token_limit',
  'sandbox_mode', 'approval_policy', 'sandbox_workspace_write', 'projects', 'profile', 'profiles',
];
const SECRET_SEGMENT_RE = /(^|_)(api_?key|token|secret|password|passwd|bearer|cookie|credentials?|private_?key|authorization|headers)$/i;
const SECRET_TABLE_SEGMENTS = new Set(['env', 'http_headers', 'env_http_headers']);
const SECRET_VALUE_RE = /^(sk-|sk_|ghp_|gho_|ghu_|ghs_|github_pat_|xox[abposr]-|glpat-|AKIA|ASIA|eyJ[A-Za-z0-9_-]+\.)|^bearer\s|^basic\s/i;

// Why a Codex override is dropped, or null when it passes. Never names the value.
function codexOverrideProblem(key, value) {
  if (!CODEX_KEY_RE.test(key)) return `key must be bare dotted segments matching ${CODEX_KEY_RE}`;
  const segments = key.split('.');
  if (CODEX_RESERVED.includes(segments[0])) return 'key is reserved for Agent Wrangler';
  if (segments.some((s) => SECRET_SEGMENT_RE.test(s) || SECRET_TABLE_SEGMENTS.has(s))) return 'key looks like a credential';
  if (segments[0] === 'shell_environment_policy' && segments[1] === 'set') return 'key looks like a credential';
  if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return null;
  if (typeof value !== 'string') return 'value must be a string, finite number or boolean';
  if (value.length > CODEX_VALUE_MAX) return `value is longer than ${CODEX_VALUE_MAX} characters`;
  if (/[\u0000-\u001f\u007f]/.test(value)) return 'value contains a control character';
  if (SECRET_VALUE_RE.test(value.trim())) return 'value looks like a credential';
  return null;
}

// The `claudeHooks` an extension answered, keeping only well-formed groups. Each
// dropped piece is reported through `drop(reason)`; nothing here is a secret, but
// the command is not echoed either, since it may be long.
function claudeHookGroups(raw, drop) {
  const out = {};
  if (raw == null) return out;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    drop('claudeHooks must be an object keyed by hook event');
    return out;
  }
  for (const [event, groups] of Object.entries(raw)) {
    if (!CLAUDE_HOOK_EVENTS.includes(event)) {
      drop(`claudeHooks ${JSON.stringify(event)} dropped (events are ${CLAUDE_HOOK_EVENTS.join(', ')})`);
      continue;
    }
    if (!Array.isArray(groups)) {
      drop(`claudeHooks ${event} dropped (must be an array of { matcher?, hooks } groups)`);
      continue;
    }
    for (const g of groups) {
      const problem = claudeHookGroupProblem(g);
      if (problem) {
        drop(`claudeHooks ${event} group dropped (${problem})`);
        continue;
      }
      const group = { hooks: g.hooks.map(({ command, timeout }) => ({ type: 'command', command, ...(timeout === undefined ? {} : { timeout }) })) };
      if (g.matcher !== undefined) group.matcher = g.matcher;
      (out[event] ||= []).push(group);
    }
  }
  return out;
}

function claudeHookGroupProblem(g) {
  if (!g || typeof g !== 'object' || Array.isArray(g)) return 'a group must be an object';
  if (g.matcher !== undefined && typeof g.matcher !== 'string') return 'matcher must be a string';
  if (!Array.isArray(g.hooks) || !g.hooks.length) return 'hooks must be a non-empty array';
  for (const h of g.hooks) {
    if (!h || typeof h !== 'object' || h.type !== 'command') return "each hook must be { type: 'command', command }";
    if (typeof h.command !== 'string' || !h.command.trim() || /[\u0000-\u0008\u000a-\u001f\u007f]/.test(h.command)) return 'command must be a non-empty single-line string';
    if (h.timeout !== undefined && !(typeof h.timeout === 'number' && Number.isFinite(h.timeout) && h.timeout > 0)) return 'timeout must be a positive number of seconds';
  }
  return null;
}

// sid -> the last context collected for it. Not for launches (those always
// re-collect) but for the few synchronous readers that need to know which
// directories the agent was granted — paste-store.js, which drops pasted images
// somewhere the agent can already read.
const lastBySession = new Map();

export function lastLaunchContext(sid) {
  return lastBySession.get(sid) || EMPTY_LAUNCH_CONTEXT;
}

export function _resetLaunchContextForTests() {
  lastBySession.clear();
}

export async function collectLaunchContext(
  { sid, task = null, agent = 'claude', runtime = 'local', reason = 'dispatch', parentId, ext: dispatchExt = null } = {},
  { ext = getExtensions(), hostApiFor = () => undefined, onError = logError } = {},
) {
  const adapter = adapterFor(agent);
  const env = {};
  const envOwner = {};
  const secretEnv = {};
  const secretOwner = {};
  const claudeHooks = {};
  const addDirs = [];
  const codexConfig = {};
  const codexOwner = {};
  const refuseIfSet = [];
  for (const { extId, fn } of ext.hooks?.['session.launchContext'] || []) {
    let out;
    try {
      out = await fn({ ...hookPayloadFor(extId, { ext: dispatchExt }), sid, task, agent, grantPaths: adapter.launch.grantPaths, runtime, reason, ...(parentId === undefined ? {} : { parentId }), host: hostApiFor(extId) });
    } catch (err) {
      onError(`[ext:${extId}] session.launchContext failed — skipped`, err);
      continue;
    }
    if (out == null) continue;
    if (typeof out !== 'object' || Array.isArray(out)) {
      onError(`[ext:${extId}] session.launchContext must return { env?, secretEnv?, addDirs?, codexConfig?, claudeHooks?, refuse?, refuseIfSet? } — ignored`);
      continue;
    }
    if (typeof out.refuse === 'string' && out.refuse.trim()) throw new Error(out.refuse.trim());
    for (const [k, v] of Object.entries(out.env || {})) {
      if (!ENV_NAME_RE.test(k) || typeof v !== 'string') {
        onError(`[ext:${extId}] session.launchContext env ${JSON.stringify(k)} dropped (name must match ${ENV_NAME_RE}, value must be a string)`);
        continue;
      }
      if (Object.hasOwn(env, k)) onError(`[launch-context] env ${k} set by ${envOwner[k]} and ${extId}; ${extId} wins`);
      env[k] = v;
      envOwner[k] = extId;
    }
    // Never echo a secret value: errors name the variable and the extension only.
    const secrets = out.secretEnv && typeof out.secretEnv === 'object' && !Array.isArray(out.secretEnv) ? out.secretEnv : {};
    for (const [k, v] of Object.entries(secrets)) {
      if (!ENV_NAME_RE.test(k) || typeof v !== 'string' || v.includes('\0')) {
        onError(`[ext:${extId}] session.launchContext secretEnv ${JSON.stringify(k)} dropped (name must match ${ENV_NAME_RE}, value must be a string without NUL)`);
        continue;
      }
      if (Object.hasOwn(secretEnv, k)) onError(`[launch-context] secretEnv ${k} set by ${secretOwner[k]} and ${extId}; ${extId} wins`);
      secretEnv[k] = v;
      secretOwner[k] = extId;
    }
    for (const [event, groups] of Object.entries(claudeHookGroups(out.claudeHooks, (why) => onError(`[ext:${extId}] session.launchContext ${why}`)))) {
      (claudeHooks[event] ||= []).push(...groups);
    }
    for (const d of Array.isArray(out.addDirs) ? out.addDirs : []) {
      if (typeof d !== 'string' || !path.isAbsolute(d)) {
        onError(`[ext:${extId}] session.launchContext addDir ${JSON.stringify(d)} dropped (must be an absolute path)`);
        continue;
      }
      if (!addDirs.includes(d)) addDirs.push(d);
    }
    const overrides = out.codexConfig && typeof out.codexConfig === 'object' && !Array.isArray(out.codexConfig) ? out.codexConfig : {};
    for (const [k, v] of Object.entries(overrides)) {
      const problem = codexOverrideProblem(k, v);
      if (problem) {
        onError(`[ext:${extId}] session.launchContext codexConfig ${JSON.stringify(k)} dropped (${problem})`);
        continue;
      }
      if (Object.hasOwn(codexConfig, k)) onError(`[launch-context] codexConfig ${k} set by ${codexOwner[k]} and ${extId}; ${extId} wins`);
      codexConfig[k] = v;
      codexOwner[k] = extId;
    }
    for (const n of Array.isArray(out.refuseIfSet) ? out.refuseIfSet : []) {
      if (typeof n !== 'string' || !ENV_NAME_RE.test(n)) {
        onError(`[ext:${extId}] session.launchContext refuseIfSet ${JSON.stringify(n)} dropped (name must match ${ENV_NAME_RE})`);
        continue;
      }
      if (!refuseIfSet.includes(n)) refuseIfSet.push(n);
    }
  }
  // A name set both ways is delivered as a secret only: left in `env` too, its
  // value would be written inline into the launch command.
  for (const k of Object.keys(secretEnv)) {
    if (!Object.hasOwn(env, k)) continue;
    onError(`[launch-context] env ${k} set by ${envOwner[k]} is also a secretEnv of ${secretOwner[k]}; delivered as a secret`);
    delete env[k];
  }
  const result = { env, addDirs };
  if (Object.keys(codexConfig).length) result.codexConfig = codexConfig;
  if (refuseIfSet.length) result.refuseIfSet = refuseIfSet;
  if (Object.keys(claudeHooks).length) result.claudeHooks = claudeHooks;
  // Cached WITHOUT the secrets: the cache only answers which dirs were granted,
  // and a secret must not outlive the launch that needed it.
  if (sid && reason !== 'headless') lastBySession.set(sid, result);
  return Object.keys(secretEnv).length ? { ...result, secretEnv } : result;
}

// The adapters' shared reading of a context: tolerant of a launch that passes
// none (a direct caller or a test), so every builder spells the default once.
export function launchEnvOf(launchContext) {
  return launchContext?.env && typeof launchContext.env === 'object' ? launchContext.env : {};
}

// The secret variables of a context ({} when none). Only the pane launch's
// secret file (launch-secrets.js) and a headless process env read them.
export function launchSecretEnvOf(launchContext) {
  const s = launchContext?.secretEnv;
  return s && typeof s === 'object' && !Array.isArray(s) ? s : {};
}

// The context minus its secrets, for code that has no business with them.
export function withoutSecretEnv(launchContext) {
  if (!launchContext || typeof launchContext !== 'object' || !('secretEnv' in launchContext)) return launchContext;
  const { secretEnv: _secretEnv, ...rest } = launchContext;
  return rest;
}

// The whole environment a HEADLESS launch adds to its child process: `env` and
// `secretEnv` together, in-process (execFile's env), so no value reaches argv.
export function launchProcessEnv(launchContext) {
  return { ...launchEnvOf(launchContext), ...launchSecretEnvOf(launchContext) };
}

// The extensions' Claude hook groups, re-validated because a direct caller can
// hand a builder any context. `{ PreToolUse?: [...], PostToolUse?: [...] }`.
export function launchClaudeHooksOf(launchContext) {
  return claudeHookGroups(launchContext?.claudeHooks, () => {});
}

export function launchAddDirsOf(launchContext) {
  return Array.isArray(launchContext?.addDirs) ? launchContext.addDirs : [];
}

// `K='v' K2='v2' ` — the env assignments a launch command line is prefixed with
// (trailing space included, empty string when there are none). `quote` is the
// adapter's own shellQuote, passed in so this module does not import the agents.
export function launchEnvPrefix(launchContext, quote) {
  return Object.entries(launchEnvOf(launchContext)).map(([k, v]) => `${k}=${quote(v)} `).join('');
}

// `/bin/sh -c '<check>' && ` — the pane-side refusal for `refuseIfSet`, run
// under /bin/sh whatever the user's shell is, with the environment the agent
// would inherit; empty string when there is nothing to check. Names are
// re-validated here because they are written into shell source.
export function launchEnvGuard(launchContext, quote) {
  const names = (Array.isArray(launchContext?.refuseIfSet) ? launchContext.refuseIfSet : []).filter((n) => ENV_NAME_RE.test(n));
  if (!names.length) return '';
  const check = names.map((n) => `[ -z "\${${n}+x}" ] || { echo "Agent Wrangler refused this launch: ${n} is set in the pane environment" >&2; exit 1; }`).join('; ');
  return `/bin/sh -c ${quote(check)} && `;
}

// `--add-dir <d>` pairs for each directory the extensions granted.
export function launchAddDirArgs(launchContext) {
  return launchAddDirsOf(launchContext).flatMap((d) => ['--add-dir', d]);
}

// `-c key=value` pairs for the extensions' Codex overrides, re-validated here
// because a direct caller can hand a builder any context.
export function launchCodexConfigArgs(launchContext) {
  const overrides = launchContext?.codexConfig;
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) return [];
  return Object.entries(overrides)
    .filter(([k, v]) => !codexOverrideProblem(k, v))
    .flatMap(([k, v]) => ['-c', `${k}=${typeof v === 'string' ? tomlString(v) : String(v)}`]);
}
