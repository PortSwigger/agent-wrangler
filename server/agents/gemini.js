import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { shellQuote } from './claude.js';
import { codexSkillCatalog, mandatorySkillPrompt } from '../agent-skills.js';
import { launchAddDirsOf, launchEnvGuard, launchEnvPrefix } from '../launch-context.js';
import { worktreeGuardrailPrompt } from '../worktree.js';
import { prAttachUrl, prModelUrl } from '../mcp/client-config.js';
import { installPath } from '../install-root.js';
import { geminiCostUsd } from '../pricing.js';
import { ensureGeminiHome, HEADLESS_POLICY_PATH } from './gemini-config.js';
import { GEMINI_TMP, cwdForConversation, findConversation, forEachConversationLine, geminiSources } from './gemini-files.js';
import { createGeminiChatScanner, extractGeminiLine, mightCarryGeminiChat, mightCarryGeminiText } from './gemini-transcript.js';
import { activityInRangeGemini, analyzeGemini, geminiContextWindow, listResumableGemini, scanDaily, scanMonth } from './gemini-usage.js';

// Google's Gemini CLI (`gemini`, verified against 0.66). What it can and cannot
// do next to Claude and Codex is in the supported-agents skill; in short:
//   - its conversation id is chosen at launch (`--session-id`), so it is preset;
//   - it runs in a Gemini home of the board's (GEMINI_CLI_HOME, gemini-config.js)
//     whose settings add the board's MCP server and hooks to the user's own;
//     the session token reaches them through $AW_SESSION_TOKEN;
//   - instructions and the skills catalog reach it through a SessionStart hook,
//     as context rather than a system prompt;
//   - status is read off the pane; there is no live status file;
//   - a fork copies the conversation under a new id (gemini-fork.js) and resumes it.

const exec = promisify(execFile);
const FORK_SCRIPT = installPath(fileURLToPath(new URL('./gemini-fork.js', import.meta.url)));

// The launch's approval mode for each permission mode the dispatch dialog offers.
// Gemini has no auto-approval classifier: "auto" is its YOLO mode, so a session
// nobody watches never stalls on a prompt; pick another mode to be asked.
const APPROVAL_MODES = { auto: 'yolo', manual: 'default', acceptEdits: 'auto_edit', plan: 'plan' };

export function geminiApprovalArgs(permissionMode) {
  const mode = APPROVAL_MODES[permissionMode ?? 'auto'];
  if (!mode) throw new Error(`Permission mode "${permissionMode}" is not supported for Gemini. Valid values: ${Object.keys(APPROVAL_MODES).join(', ')}.`);
  return ['--approval-mode', mode];
}

// The instructions every launch hands Gemini: a mandatory skill's nudge, card
// naming, the skills catalog (each SKILL.md read on demand by absolute path, as
// Codex does) and, in a worktree, its guardrail.
export function geminiInstructions({ sessionId, worktree = null, disabledSkills }) {
  const title = `Once you understand the first substantive task, name your Agent Wrangler card with a concise 3-8 word description. Call the agent-wrangler rename_session MCP tool with {"target":"${sessionId}","name":"<short task title>","only_if_unnamed":true}. Do not use the folder name or copy the full prompt. The tool preserves an existing custom title.`;
  const parts = [mandatorySkillPrompt(undefined, { disabledSkills }), title, codexSkillCatalog(undefined, { disabledSkills })];
  if (worktree) parts.push(worktreeGuardrailPrompt(worktree));
  return parts.filter(Boolean).join('\n\n');
}

// The extensions' env first and core's after, so an extension adds variables
// but never overrides ours (the last assignment of a name wins).
function envPrefix({ sessionId, spawnedBy, launchContext, worktree, disabledSkills, home }) {
  let env = launchEnvGuard(launchContext, shellQuote) + launchEnvPrefix(launchContext, shellQuote)
    + `AW_SESSION_ID=${shellQuote(sessionId)} AW_PR_ATTACH_URL=${shellQuote(prAttachUrl())} AW_PR_MODEL_URL=${shellQuote(prModelUrl())} `
    + `GEMINI_CLI_HOME=${shellQuote(home)} AW_GEMINI_CONTEXT=${shellQuote(geminiInstructions({ sessionId, worktree, disabledSkills }))} `;
  if (spawnedBy) env += `AW_SPAWNER_SESSION_ID=${shellQuote(spawnedBy)} `;
  return env;
}

// Flags every launch, resume and fork carries. `--skip-trust` trusts the launch
// directory for this session only (Gemini's own trust file is never written).
function commonFlags({ model, permissionMode, addDirs = [], launchContext, policyPath }) {
  const args = ['--skip-trust', ...geminiApprovalArgs(permissionMode), '--policy', policyPath];
  if (model) args.push('-m', model);
  for (const d of [...launchAddDirsOf(launchContext), ...addDirs]) args.push('--include-directories', d);
  return args;
}

// `--prompt-interactive=<text>` rather than a positional or `-i <text>`, so an
// intent starting with `-` cannot be read as a flag.
const intentArg = (intent) => (intent.trim() ? [`--prompt-interactive=${intent.trim()}`] : []);

function command(opts, args, before = '') {
  const { home, policyPath } = ensureGeminiHome();
  const env = envPrefix({ ...opts, home });
  return `${before ? `${env}${before} && ` : ''}${env}gemini ${[...args, ...commonFlags({ ...opts, policyPath })].map(shellQuote).join(' ')}`;
}

// ---- The pane --------------------------------------------------------------

const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
const plain = (text) => String(text || '').replace(ANSI, '');
const PLACEHOLDER = 'Type your message or @path/to/file';
// The composer: its glyph is `>` (`*` in YOLO mode, `!` in shell mode).
const COMPOSER_RE = /^\s*[>*!]\s(.*)$/;
const NEEDS_YOU_RE = /Waiting for user confirmation|Allow execution of|Apply this change\?|Do you want to proceed|Do you trust the (?:files in this folder|following folders)|Enter Gemini API Key|How would you like to authenticate|Waiting for auth/i;

function recentLines(text, n = 40) {
  return plain(text).split('\n').filter((l) => l.trim()).slice(-n);
}

// The composer's line between its ▄▄▄ and ▀▀▀ rules, or null when the pane shows none.
function composerLine(text) {
  const lines = recentLines(text);
  const top = lines.findLastIndex((l) => /^▄{10,}/.test(l.trim()));
  const bottom = lines.findLastIndex((l) => /^▀{10,}/.test(l.trim()));
  if (top < 0 || bottom <= top) return null;
  const line = lines.slice(top + 1, bottom).find((l) => COMPOSER_RE.test(l));
  return line ? COMPOSER_RE.exec(line)[1] : null;
}

export function geminiClassify(text) {
  const recent = recentLines(text).join('\n');
  const ask = NEEDS_YOU_RE.exec(recent);
  if (ask) return { status: 'needs-you', waitingFor: ask[0] };
  if (/\(esc to cancel/i.test(recent)) return { status: 'working' };
  // Startup hooks (ours hands over the instructions) run before typed input is safe.
  if (/Executing Hook/.test(recentLines(text, 10).join('\n'))) return { status: 'working' };
  if (composerLine(text) !== null) return { status: 'idle' };
  return { status: 'unknown' };
}

function composerIsReady(text) {
  return composerLine(text) !== null && geminiClassify(text).status === 'idle';
}

function composerIsEmpty(text, { allowWhileWorking = false } = {}) {
  const line = composerLine(text);
  if (line === null) return false;
  if (!allowWhileWorking && geminiClassify(text).status !== 'idle') return false;
  const typed = line.trim();
  return !typed || typed === PLACEHOLDER;
}

// ---- Headless --------------------------------------------------------------

// `gemini -p` with the payload on stdin (Gemini puts it ahead of the prompt),
// every tool denied by a policy, no extensions and no MCP server. The id is
// fixed with `--session-id`, and it runs in the board's Gemini home, so usage
// finds and bills the recorded conversation. The user's own settings still
// apply (the home's settings are theirs plus ours): no flag skips them.
const geminiHeadless = {
  defaultModel: () => 'gemini-3.1-flash-lite',
  command({ prompt, model, env = {} }) {
    const liveSessionId = crypto.randomUUID();
    const { home } = ensureGeminiHome();
    const args = [
      '-p', prompt, '-o', 'json', '-m', model, '--session-id', liveSessionId, '--skip-trust',
      '-e', 'none', '--allowed-mcp-server-names', 'agent-wrangler-headless-none', '--policy', HEADLESS_POLICY_PATH,
    ];
    return { file: 'gemini', args, env: { ...process.env, ...env, GEMINI_CLI_HOME: home }, liveSessionId };
  },
  // `-o json` prints one object: { session_id, response, stats, error? }.
  parse(stdout) {
    const text = String(stdout);
    const start = text.indexOf('{');
    const parsed = JSON.parse(start > 0 ? text.slice(start) : text);
    return {
      text: typeof parsed.response === 'string' ? parsed.response.trim() : null,
      liveSessionId: typeof parsed.session_id === 'string' ? parsed.session_id : undefined,
      error: parsed.error ? (parsed.error.message || 'Gemini failed') : null,
    };
  },
};

// ---- Models ----------------------------------------------------------------

// `auto` is the CLI's own default (it routes each turn between Pro and Flash);
// the rest are full model ids the CLI accepts, so each runs exactly that model.
const MODELS = [
  { value: 'auto', label: 'Auto · Gemini picks Pro or Flash', pillLabel: 'auto', default: true, contextWindow: 1_048_576 },
  { value: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro (preview)', pillLabel: 'pro 3.1', transcriptPrefixes: ['gemini-3.1-pro'], contextWindow: 1_048_576 },
  { value: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', pillLabel: 'pro 2.5', transcriptPrefixes: ['gemini-2.5-pro'], contextWindow: 1_048_576 },
  { value: 'gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash-Lite', pillLabel: 'flash-lite 3.1', transcriptPrefixes: ['gemini-3.1-flash-lite'], contextWindow: 1_048_576 },
  { value: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash', pillLabel: 'flash 3.5', transcriptPrefixes: ['gemini-3.5-flash'], contextWindow: 1_048_576 },
];

export const gemini = {
  id: 'gemini',
  label: 'Gemini',
  tmuxPrefix: 'gm_',
  reviewPriority: 30,
  models: MODELS,
  efforts: [],
  // `auto` runs whichever model Gemini routes a turn to, so it names no one id.
  modelId: (value) => (value === 'auto' ? null : value),
  contextWindow: geminiContextWindow,
  unavailableMessage: "This is a Gemini conversation, but the `gemini` binary isn't on PATH — install Gemini CLI (or put it on the launchd PATH) to resume Gemini sessions.",
  presetsSessionId: true,
  // A resume intent is pasted once the pane is up (see pr-nudge-runner): a
  // `--prompt-interactive` prompt races Gemini's own resume (gemini-fork.js).
  resumeCarriesIntent: false,
  supportsRemoteControl: false,
  supportsDisallowedTools: false,
  headlessArchiveReview: false,
  headless: geminiHeadless,
  history: {
    branches: false,
    directory: ({ geminiDir } = {}) => geminiDir ?? GEMINI_TMP,
    findFile: (id, { geminiDir } = {}) => findConversation(id, geminiDir ?? GEMINI_TMP),
    async findFiles(id, options) {
      const file = await this.findFile(id, options);
      return file ? [file] : [];
    },
    async launchCwd(id) {
      const file = await findConversation(id);
      return file ? cwdForConversation(file) : null;
    },
    async resolveResumeDir(id, { graphCwd, entryCwd } = {}) {
      return (await this.launchCwd(id)) || graphCwd || entryCwd || null;
    },
    forEachLine: forEachConversationLine,
    createScanner: createGeminiChatScanner,
    mightCarryChat: mightCarryGeminiChat,
    mightCarryText: mightCarryGeminiText,
    extractLine: extractGeminiLine,
    discoverSources: () => geminiSources(),
  },
  usage: { billingProviders: [{ id: 'google', label: 'Google' }], scanDaily, scanMonth, costUsd: geminiCostUsd, unknownModelLabel: 'gemini (est.)' },
  labels: { liveTitle: false, summaryFirst: true },
  statusSource: 'pane',
  presentation: { icon: 'gemini', color: '#4285f4', estimatedCost: true },
  controls: {
    switchModel: false,
    permissionModes: Object.keys(APPROVAL_MODES),
  },
  launch: { grantPaths: 'realpath', trust: null, gitMetadataGrants: false, codexPolicy: false, recoverMissingConversation: false },
  terminal: {
    readySignal: 'composer',
    contextSource: 'analysis',
    modelLabel: () => null,
    contextPercent: () => null,
    imageCount: () => null,
    classify: (text) => geminiClassify(text),
    editingKeys: { newline: '\n', wordLeft: '\x1bb', wordRight: '\x1bf', clearLine: '\x15' },
    clearKeys: ['C-u'],
    composerIsReady,
    composerIsEmpty,
    composerDraft: () => null,
    suggestion: () => null,
    composerMark: ' > ',
    paneMetadata: false,
    restoreDraft: false,
    allowWhileWorking: false,
    imageAcknowledgement: false,
    interruptKeys: ['Escape'],
  },

  async isAvailable() {
    try {
      const { stdout } = await exec('sh', ['-c', 'command -v gemini']);
      return Boolean(stdout.trim());
    } catch {
      return false;
    }
  },

  // `gemini` is a node script: ps shows `node /path/to/bin/gemini …`, twice
  // (the CLI relaunches itself with a larger heap).
  matchProcess(command) {
    return /(?:^|\/)gemini(?:\.js)?(?:\s|$)/.test(command || '');
  },

  buildLaunch({ sessionId, liveSessionId, intent = '', model, permissionMode, addDirs = [], worktree = null, spawnedBy, launchContext, disabledSkills }) {
    const opts = { sessionId, spawnedBy, launchContext, worktree, disabledSkills, model, permissionMode, addDirs };
    return command(opts, ['--session-id', liveSessionId || sessionId, ...intentArg(intent)]);
  },

  buildResume({ sessionId, resumeId, model, permissionMode, addDirs = [], worktree = null, spawnedBy, launchContext, disabledSkills }) {
    const opts = { sessionId, spawnedBy, launchContext, worktree, disabledSkills, model, permissionMode, addDirs };
    return command(opts, ['--resume', resumeId]);
  },

  // The copy lands where `--resume` looks for the fork's directory, then the
  // fork resumes it under its own id. Its first prompt is typed in by the fork
  // script once the resume is open (see gemini-fork.js for why not argv).
  buildFork({ sessionId, liveSessionId, sourceId, model, permissionMode, intent = '', addDirs = [], launchContext, disabledSkills }) {
    const newId = liveSessionId || crypto.randomUUID();
    const copy = [process.execPath, FORK_SCRIPT, sourceId, newId, ...(intent.trim() ? [intent.trim()] : [])].map(shellQuote).join(' ');
    const opts = { sessionId, launchContext, disabledSkills, model, permissionMode, addDirs };
    return command(opts, ['--resume', newId], copy);
  },

  async discoverLiveId({ sessionId }) { return sessionId; },
  readLive() { return null; },
  analyze(liveSid, opts) { return analyzeGemini(liveSid, opts); },
  listResumable(excludeIds, opts) { return listResumableGemini(excludeIds, opts); },
  activityInRange(liveSid, startMs, endMs, dir) { return activityInRangeGemini(liveSid, startMs, endMs, dir); },
  transcriptPath(liveSid, dir) { return findConversation(liveSid, dir); },
  subagentDetail: async () => null,
};
