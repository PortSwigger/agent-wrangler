import { readCodexConfigEffort, resolveCodexAutoEffort } from './auto-effort.js';
import { paneComposerIsReady, paneComposerIsEmpty, paneComposerDraft, parseGhostSuggestion } from './composer-parsers.js';
import { scanDaily, scanMonth } from './codex-usage.js';
import { codexCostUsd } from '../pricing.js';
import { codexHistory } from './codex-history.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { launchAddDirArgs, launchCodexConfigArgs, launchEnvGuard, launchEnvPrefix } from '../launch-context.js';
import { codexSkillCatalog, mandatorySkillPrompt } from '../agent-skills.js';
import { shellQuote } from './claude.js';
import { analyzeCodex, listResumableCodex, activityInRangeCodex, codexContextWindow, codexSubagentDetail, findRollout } from './codex-rollout.js';
import { discoverCodexLiveId } from './codex-discover.js';
import { worktreeGuardrailPrompt } from '../worktree.js';
import { codexMcpConfigArgs, MCP_TOKEN_ENV, prModelUrl } from '../mcp/client-config.js';
import { codexPolicyArgs } from '../extensions/codex-policy.js';
import { codexModels, codexEfforts, defaultCodexModel } from './codex-catalog.js';
import { tomlString, notifyOverride } from '../codex-notify-config.js';
import { postToolHookOverrides } from '../codex-hook-config.js';
import { fileURLToPath } from 'node:url';
import { installPath } from '../install-root.js';

const exec = promisify(execFile);

const HOOK_PATH = installPath(fileURLToPath(new URL('../codex-notify-hook.js', import.meta.url)));
// The PR model footer's PostToolUse hook (scripts/codex-pr-footer-hook.mjs).
const PR_FOOTER_HOOK_PATH = installPath(fileURLToPath(new URL('../../scripts/codex-pr-footer-hook.mjs', import.meta.url)));

// The pane-side refuseIfSet guard, env assignments + the `codex` binary. `sessionId` is always the OWNER/board id,
// even for a fork (its own fresh board id). The extensions' env comes FIRST and
// core's after, so an extension adds variables but can never override ours (the
// last assignment of a name wins in a shell prefix). A path an extension hands
// Codex (task-memory's) is already the launch-time REAL path: its hook is told
// `agent: 'codex'`, because Codex 0.149+ rejects a symlinked writable root.
function envPrefix(sessionId, spawnedBy, launchContext) {
  let env = launchEnvGuard(launchContext, shellQuote) + launchEnvPrefix(launchContext, shellQuote)
    + `AW_SESSION_ID=${shellQuote(sessionId)} ${MCP_TOKEN_ENV}=${shellQuote(sessionId)} AW_PR_MODEL_URL=${shellQuote(prModelUrl())} `;
  if (spawnedBy) env += `AW_SPAWNER_SESSION_ID=${shellQuote(spawnedBy)} `;
  return env;
}

// Flags shared by launch/resume/fork: autonomy, network, the extensions' config overrides and directory grants, and
// the additive developer-instructions channel. Autonomy (sandbox, approval, the
// network grant, --approve-for-me or bypass) comes from an extension's
// `codexPolicy` answer when one answers (codexPolicyArgs,
// extensions/codex-policy.js); otherwise the core defaults apply:
// --sandbox workspace-write --ask-for-approval never plus the workspace-write
// network grant. Everything else is unconditional, bypass included, the
// notify hook and the PR model footer's PostToolUse hook among it (pre-trusted
// in the same flags, codex-hook-config.js; it never attaches a PR to a card).
// Developer instructions are the verified equivalent of Claude's
// --append-system-prompt; injected as a `developer`-role message). Directory trust is NOT handled
// here: verified against the installed binary that Codex's interactive trust
// dialog ignores a `-c projects.<path>.trust_level` CLI override entirely — only
// an entry already persisted in `~/.codex/config.toml` at process start
// suppresses it. See `ensureCodexTrust` (codex-trust.js), which the caller runs
// before this launch command is ever spawned.
function commonFlags({ sessionId, cwd, addDirs = [], worktree = null, launchContext, disabledSkills, codexPolicy }) {
  // memory/links are wrangler-meta skills now; Codex gets a read-only catalog of
  // them in developer_instructions and reads a SKILL.md on demand (workspace-write
  // allows reads outside cwd). A mandatory skill's nudge (task-memory) still rides
  // this always-on text too — the catalog alone doesn't guarantee it's read at
  // session start. The worktree guardrail still appends when present.
  const titlePrompt = `Once you understand the first substantive task, name your Agent Wrangler card with a concise 3-8 word description. Call the agent-wrangler rename_session MCP tool with {"target":"${sessionId}","name":"<short task title>","only_if_unnamed":true}. Do not use the folder name or copy the full prompt. The tool preserves an existing custom title.`;
  const base = [mandatorySkillPrompt(undefined, { disabledSkills }), titlePrompt, codexSkillCatalog(undefined, { disabledSkills })].filter(Boolean).join('\n\n');
  const instructions = worktree ? `${base}\n\n${worktreeGuardrailPrompt(worktree)}` : base;
  const args = codexPolicyArgs(codexPolicy);
  args.push(...launchCodexConfigArgs(launchContext));
  args.push('-c', `developer_instructions=${tomlString(instructions)}`);
  args.push('-c', notifyOverride(process.execPath, HOOK_PATH));
  for (const o of postToolHookOverrides(`${shellQuote(process.execPath)} ${shellQuote(PR_FOOTER_HOOK_PATH)}`)) args.push('-c', o);
  args.push(...launchAddDirArgs(launchContext));
  for (const d of addDirs) args.push('--add-dir', d);
  args.push(...codexMcpConfigArgs());
  return args;
}

export const codex = {
  id: 'codex',
  history: codexHistory,
  autoEffortResolver(paths) {
    const configEffort = readCodexConfigEffort(paths.codexConfig);
    return (value) => resolveCodexAutoEffort(value, { configEffort });
  },
  subagentDetail: codexSubagentDetail,
  subagentDetailOverride: 'codexSubagentDetail',
  usage: { billingProviders: [{ id: 'openai', label: 'OpenAI' }], scanDaily, scanMonth, costUsd: codexCostUsd, unknownModelLabel: 'gpt (codex est.)' },
  labels: { liveTitle: false, summaryFirst: true },
  statusSource: 'codex-rollout',
  presentation: { icon: 'codex', color: '#10a37f', estimatedCost: true },
  controls: {
    switchModel: false,
    permissionModes: ['auto'],
    autoCompact: { min: 50000, presets: [50000, 100000, 250000] },
  },
  launch: { grantPaths: 'realpath', availabilityOverride: 'codexAvailable', trust: 'codex', gitMetadataGrants: true, codexPolicy: true, recoverMissingConversation: true },
  terminal: {
    readySignal: 'composer',
    contextSource: 'analysis',
    modelLabel: () => null,
    contextPercent: () => null,
    imageCount: () => null,
    backgroundShellPattern: /\d+\s+background terminals?\s+running/i,
    classify: (text, options, parse) => parse(text, options),
    editingKeys: { newline: '\x1b\r', wordLeft: '\x1bb', wordRight: '\x1bf', clearLine: '\x15' },
    clearKeys: ['C-u'],
    composerIsReady: (text) => paneComposerIsReady(text, 'codex'),
    composerIsEmpty: (text, options) => paneComposerIsEmpty(text, 'codex', options),
    composerDraft: () => null,
    suggestion: () => null,
    composerMark: '›',
    paneMetadata: false,
    restoreDraft: false,
    allowWhileWorking: true,
    imageAcknowledgement: false,
    interruptKeys: ['Escape'],
  },
  contextWindow: codexContextWindow,
  reviewPriority: 20,
  label: 'Codex',
  unavailableMessage: "This is a Codex conversation, but the `codex` binary isn't on PATH — install it (or put it on the launchd PATH) to resume Codex sessions.",
  tmuxPrefix: 'cx_',
  presetsSessionId: false,
  // `codex resume` takes no trailing prompt, so buildResume can't thread an `intent`
  // into the relaunch (it's a silent no-op). A dormant-wake nudge must instead be
  // pasted into the now-live pane after resume() resolves (see pr-nudge-runner).
  resumeCarriesIntent: false,
  // Codex's own catalog (codex-catalog.js): the models its /model picker lists,
  // and the union of their reasoning levels.
  get models() {
    return codexModels();
  },
  get efforts() {
    return codexEfforts();
  },

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

  buildLaunch({ sessionId, intent = '', model, effort, autoCompactTokens, addDirs = [], worktree = null, spawnedBy, launchContext, disabledSkills, codexPolicy }) {
    const args = ['-m', model || defaultCodexModel()];
    if (effort) args.push('-c', `model_reasoning_effort=${effort}`);
    if (autoCompactTokens) args.push('-c', `model_auto_compact_token_limit=${autoCompactTokens}`);
    args.push(...commonFlags({ sessionId, addDirs, worktree, launchContext, disabledSkills, codexPolicy }));
    let inner = `${envPrefix(sessionId, spawnedBy, launchContext)}codex ${args.map(shellQuote).join(' ')}`;
    if (intent.trim()) inner += ` ${shellQuote(intent.trim())}`;
    return inner;
  },

  buildResume({ sessionId, resumeId, effort, autoCompactTokens, addDirs = [], spawnedBy, launchContext, disabledSkills, codexPolicy }) {
    const args = ['resume', resumeId];
    if (effort) args.push('-c', `model_reasoning_effort=${effort}`);
    if (autoCompactTokens) args.push('-c', `model_auto_compact_token_limit=${autoCompactTokens}`);
    args.push(...commonFlags({ sessionId, addDirs, launchContext, disabledSkills, codexPolicy }));
    return `${envPrefix(sessionId, spawnedBy, launchContext)}codex ${args.map(shellQuote).join(' ')}`;
  },

  buildFork({ sessionId, sourceId, model, effort, autoCompactTokens, intent = '', addDirs = [], launchContext, disabledSkills, codexPolicy }) {
    // `codex fork <SESSION_ID> [PROMPT]` branches the transcript into a new thread
    // (verified against codex 0.139.0): the prompt trails as the last positional.
    const args = ['fork', sourceId, '-m', model || defaultCodexModel()];
    if (effort) args.push('-c', `model_reasoning_effort=${effort}`);
    if (autoCompactTokens) args.push('-c', `model_auto_compact_token_limit=${autoCompactTokens}`);
    args.push(...commonFlags({ sessionId, addDirs, launchContext, disabledSkills, codexPolicy }));
    let inner = `${envPrefix(sessionId, undefined, launchContext)}codex ${args.map(shellQuote).join(' ')}`;
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
  transcriptPath(liveSid, dir) { return findRollout(liveSid, dir); },
};
