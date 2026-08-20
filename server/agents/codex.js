import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { linkPathFor, addDirFor } from '../memory-store.js';
import { codexSkillCatalog, mandatorySkillPrompt } from '../agent-skills.js';
import { shellQuote } from './claude.js';
import { analyzeCodex, listResumableCodex, activityInRangeCodex } from './codex-rollout.js';
import { discoverCodexLiveId } from './codex-discover.js';
import { worktreeGuardrailPrompt } from '../worktree.js';
import { codexMcpConfigArgs, MCP_TOKEN_ENV } from '../mcp/client-config.js';

const exec = promisify(execFile);
// `*-codex`-suffixed models (e.g. gpt-5.5-codex) are rejected on ChatGPT-account
// logins ("not supported when using Codex with a ChatGPT account") and only work
// with API-key auth; plain model ids are broadly valid. gpt-5.6-sol (frontier,
// no -codex suffix) is confirmed to work on a ChatGPT-account login — default
// to it as the strongest broadly-valid model.
const DEFAULT_MODEL = 'gpt-5.6-sol';

// A TOML double-quoted string for a `-c key=value` override. Escapes backslash
// and double-quote per TOML basic-string rules; the memory prompt has neither
// today, but escape defensively so a future prompt edit can't break the arg.
function tomlString(s) {
  return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

// Env assignments + the `codex` binary. `sessionId` is always the OWNER/board id
// (the memory key), even for a fork (its own fresh board id).
function envPrefix(sessionId, spawnedBy) {
  let env = `AW_SESSION_ID=${shellQuote(sessionId)} AW_TASK_MEMORY=${shellQuote(linkPathFor(sessionId))} `
    + `${MCP_TOKEN_ENV}=${shellQuote(sessionId)} `;
  if (spawnedBy) env += `AW_SPAWNER_SESSION_ID=${shellQuote(spawnedBy)} `;
  return env;
}

// Flags shared by launch/resume/fork: autonomy, network, memory write-grant, and
// the additive developer-instructions channel (verified equivalent of Claude's
// --append-system-prompt; injected as a `developer`-role message). The memory dir
// derives from the OWNER sessionId — the single source of truth — so callers
// needn't pass it (matches the Claude adapter; guards against a caller dropping
// it, which once produced `--add-dir undefined`). Directory trust is NOT handled
// here: verified against the installed binary that Codex's interactive trust
// dialog ignores a `-c projects.<path>.trust_level` CLI override entirely — only
// an entry already persisted in `~/.codex/config.toml` at process start
// suppresses it. See `ensureCodexTrust` (codex-trust.js), which the caller runs
// before this launch command is ever spawned.
function commonFlags({ sessionId, cwd, addDirs = [], worktree = null, taskMemory }) {
  // memory/links are wrangler-meta skills now; Codex gets a read-only catalog of
  // them in developer_instructions and reads a SKILL.md on demand (workspace-write
  // allows reads outside cwd). A mandatory skill's nudge (task-memory) still rides
  // this always-on text too — the catalog alone doesn't guarantee it's read at
  // session start. The worktree guardrail still appends when present. `taskMemory`
  // is only threaded so tests can pin it; undefined (the production path) falls
  // through to the live-config default inside both skill helpers.
  const base = [mandatorySkillPrompt(undefined, { taskMemory }), codexSkillCatalog(undefined, { taskMemory })].filter(Boolean).join('\n\n');
  const instructions = worktree ? `${base}\n\n${worktreeGuardrailPrompt(worktree)}` : base;
  const args = [
    '--sandbox', 'workspace-write',
    '--ask-for-approval', 'never',
    '-c', 'sandbox_workspace_write.network_access=true',
  ];
  args.push('-c', `developer_instructions=${tomlString(instructions)}`);
  args.push('--add-dir', addDirFor(sessionId));
  for (const d of addDirs) args.push('--add-dir', d);
  args.push(...codexMcpConfigArgs());
  return args;
}

export const codex = {
  id: 'codex',
  label: 'Codex',
  tmuxPrefix: 'cx_',
  presetsSessionId: false,
  // `codex resume` takes no trailing prompt, so buildResume can't thread an `intent`
  // into the relaunch (it's a silent no-op). A dormant-wake nudge must instead be
  // pasted into the now-live pane after resume() resolves (see pr-nudge-runner).
  resumeCarriesIntent: false,
  models: [
    { value: 'gpt-5.5', label: 'GPT-5.5 · frontier', pillLabel: 'gpt-5.5' },
    { value: 'gpt-5.4', label: 'GPT-5.4 · everyday coding', pillLabel: 'gpt-5.4' },
    { value: 'gpt-5.4-mini', label: 'GPT-5.4 mini · fast & cheap', pillLabel: 'gpt-5.4 mini' },
    { value: 'gpt-5.6-sol', label: 'GPT-5.6 Sol · frontier', pillLabel: 'gpt-5.6 sol', default: true },
    { value: 'gpt-5.6-terra', label: 'GPT-5.6 Terra · everyday coding', pillLabel: 'gpt-5.6 terra' },
    { value: 'gpt-5.6-luna', label: 'GPT-5.6 Luna · fast & cheap', pillLabel: 'gpt-5.6 luna' },
  ],
  efforts: [
    { value: 'minimal', label: 'Minimal' },
    { value: 'low', label: 'Low' },
    { value: 'medium', label: 'Medium' },
    { value: 'high', label: 'High' },
  ],

  async isAvailable() {
    // `command -v` (POSIX sh builtin) over `which` — the latter is a separate,
    // sometimes-absent package on slim Linux.
    try {
      const { stdout } = await exec('sh', ['-c', 'command -v codex']);
      return Boolean(stdout.trim());
    } catch {
      return false;
    }
  },

  matchProcess(command) {
    return /(?:^|\/)codex(?:\s|$)/.test(command || '');
  },

  // Symmetric with claude's matchContainerized (see there for the rationale);
  // codex-in-container isn't wired up yet but discovery must be ready when it is.
  matchContainerized(command) {
    const c = command || '';
    return /\b(?:devcontainer|docker)\s+exec\b/.test(c) && /(?:^|\s)codex(?:\s|$)/.test(c);
  },

  buildLaunch({ sessionId, intent = '', model, effort, addDirs = [], worktree = null, spawnedBy, taskMemory }) {
    const args = ['-m', model || DEFAULT_MODEL];
    if (effort) args.push('-c', `model_reasoning_effort=${effort}`);
    args.push(...commonFlags({ sessionId, addDirs, worktree, taskMemory }));
    let inner = `${envPrefix(sessionId, spawnedBy)}codex ${args.map(shellQuote).join(' ')}`;
    if (intent.trim()) inner += ` ${shellQuote(intent.trim())}`;
    return inner;
  },

  buildResume({ sessionId, resumeId, effort, addDirs = [], spawnedBy, taskMemory }) {
    const args = ['resume', resumeId];
    if (effort) args.push('-c', `model_reasoning_effort=${effort}`);
    args.push(...commonFlags({ sessionId, addDirs, taskMemory }));
    return `${envPrefix(sessionId, spawnedBy)}codex ${args.map(shellQuote).join(' ')}`;
  },

  buildFork({ sessionId, sourceId, model, effort, intent = '', addDirs = [], taskMemory }) {
    // `codex fork <SESSION_ID> [PROMPT]` branches the transcript into a new thread
    // (verified against codex 0.139.0): the prompt trails as the last positional.
    const args = ['fork', sourceId, '-m', model || DEFAULT_MODEL];
    if (effort) args.push('-c', `model_reasoning_effort=${effort}`);
    args.push(...commonFlags({ sessionId, addDirs, taskMemory }));
    let inner = `${envPrefix(sessionId)}codex ${args.map(shellQuote).join(' ')}`;
    if (intent.trim()) inner += ` ${shellQuote(intent.trim())}`;
    return inner;
  },

  discoverLiveId(opts) { return discoverCodexLiveId(opts); },

  // No per-pid status file; status is derived from the pane by the shared
  // classify(). readLive only resolves the live rollout id for enrichment.
  readLive() { return null; },

  // No `since` bound (the fork double-count fix Claude gets): a Codex rollout carries
  // no per-turn usage to filter — analyzeCodex reads the CUMULATIVE
  // total_token_usage off the last token_count event — so bounding a `codex fork` by
  // time is impossible without also knowing the parent's cumulative total at the fork
  // instant. Codex cost is already an explicit estimate (shown with `~`).
  analyze(liveSid) { return analyzeCodex(liveSid); },
  listResumable(excludeIds, opts) { return listResumableCodex(excludeIds, opts); },
  activityInRange(liveSid, startMs, endMs, dir) { return activityInRangeCodex(liveSid, startMs, endMs, dir); },
};
