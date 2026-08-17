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
// gpt-5.5 is the model valid for ChatGPT-account logins; gpt-5.5-codex is
// rejected there ("not supported when using Codex with a ChatGPT account") and
// only works with API-key auth. Default to the broadly-valid one.
const DEFAULT_MODEL = 'gpt-5.5';

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
// it, which once produced `--add-dir undefined`). `trustCwd` is the resolved
// trustCodexLaunchCwd setting — the caller's job, not this adapter's, to read
// config; this file only honors whatever boolean it's handed.
function commonFlags({ sessionId, cwd, trustCwd, addDirs = [], worktree = null, taskMemory }) {
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
  if (trustCwd && cwd) args.push('-c', `projects.${tomlString(cwd)}.trust_level="trusted"`);
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
    { value: 'gpt-5.5', label: 'GPT-5.5 · frontier', default: true },
    { value: 'gpt-5.4', label: 'GPT-5.4 · everyday coding' },
    { value: 'gpt-5.4-mini', label: 'GPT-5.4 mini · fast & cheap' },
    { value: 'gpt-5.6-sol', label: 'GPT-5.6 Sol · frontier' },
    { value: 'gpt-5.6-terra', label: 'GPT-5.6 Terra · everyday coding' },
    { value: 'gpt-5.6-luna', label: 'GPT-5.6 Luna · fast & cheap' },
  ],
  efforts: [
    { value: 'minimal', label: 'Minimal' },
    { value: 'low', label: 'Low' },
    { value: 'medium', label: 'Medium' },
    { value: 'high', label: 'High' },
  ],

  async isAvailable() {
    try {
      const { stdout } = await exec('which', ['codex']);
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

  buildLaunch({ sessionId, cwd, trustCwd, intent = '', model, effort, addDirs = [], worktree = null, spawnedBy, taskMemory }) {
    const args = ['-m', model || DEFAULT_MODEL];
    if (effort) args.push('-c', `model_reasoning_effort=${effort}`);
    args.push(...commonFlags({ sessionId, cwd, trustCwd, addDirs, worktree, taskMemory }));
    let inner = `${envPrefix(sessionId, spawnedBy)}codex ${args.map(shellQuote).join(' ')}`;
    if (intent.trim()) inner += ` ${shellQuote(intent.trim())}`;
    return inner;
  },

  buildResume({ sessionId, resumeId, cwd, trustCwd, effort, addDirs = [], spawnedBy, taskMemory }) {
    const args = ['resume', resumeId];
    if (effort) args.push('-c', `model_reasoning_effort=${effort}`);
    args.push(...commonFlags({ sessionId, cwd, trustCwd, addDirs, taskMemory }));
    return `${envPrefix(sessionId, spawnedBy)}codex ${args.map(shellQuote).join(' ')}`;
  },

  buildFork({ sessionId, sourceId, cwd, trustCwd, model, effort, intent = '', addDirs = [], taskMemory }) {
    // `codex fork <SESSION_ID> [PROMPT]` branches the transcript into a new thread
    // (verified against codex 0.139.0): the prompt trails as the last positional.
    const args = ['fork', sourceId, '-m', model || DEFAULT_MODEL];
    if (effort) args.push('-c', `model_reasoning_effort=${effort}`);
    args.push(...commonFlags({ sessionId, cwd, trustCwd, addDirs, taskMemory }));
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
