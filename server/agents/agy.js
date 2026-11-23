import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { shellQuote } from './claude.js';
import { codexSkillCatalog, mandatorySkillPrompt } from '../agent-skills.js';
import { launchAddDirsOf, launchEnvGuard, launchEnvPrefix } from '../launch-context.js';
import { worktreeGuardrailPrompt } from '../worktree.js';
import { MCP_SERVER_NAME, mcpUrl, prAttachUrl, prModelUrl } from '../mcp/client-config.js';
import { agyCostUsd } from '../pricing.js';
import { PLUGIN_NAME, allowedAgyTools, ensureAgyRoot } from './agy-config.js';
import { AGY_DIR, IDS_DIR, MIRROR_DIR, conversationCwd, discoverAgyLiveId, forEachMirrorLine, syncMirror } from './agy-db.js';
import { createAgyChatScanner, extractAgyLine, mightCarryAgyChat, mightCarryAgyText } from './agy-transcript.js';
import { activityInRangeAgy, agySources, analyzeAgy, listResumableAgy, scanDaily, scanMonth } from './agy-usage.js';
import { readAgySettingsModel, resolveAgyAutoEffort } from './auto-effort.js';

// Google's Antigravity CLI (`agy`, verified against 1.5.13). Next to Gemini CLI:
//   - agy picks its own conversation id; the board's SessionStart hook records
//     it, and a launch without that record finds it by folder (agy-db.js);
//   - the board's MCP server and hooks come from a board-owned plugin folder
//     each launch adds as a workspace (agy-config.js);
//   - its conversations are SQLite; the board reads a JSONL mirror of each;
//   - status is read off the pane;
//   - the board's MCP tools reach a turn only once agy has started the plugin's
//     MCP server, which it does lazily, so the board starts it from the pane
//     before the first turn (`terminal.warmUp`) and types the first prompt
//     after (`launchCarriesIntent: false`);
//   - no fork: agy's `/fork` switches the running pane to the copy, so a board
//     fork would have to open the same conversation in a second agy and type
//     into it. That is left off rather than raced.

const exec = promisify(execFile);

// The launch's mode for each permission mode the dispatch dialog offers. Auto
// is agy's own auto mode (a reviewer approves safe commands); Manual is its
// default, which asks.
const MODE_ARGS = {
  auto: ['--mode', 'auto'],
  manual: [],
  acceptEdits: ['--mode', 'accept-edits'],
  plan: ['--mode', 'plan'],
  bypassPermissions: ['--dangerously-skip-permissions'],
};

export function agyModeArgs(permissionMode) {
  const args = MODE_ARGS[permissionMode ?? 'auto'];
  if (!args) throw new Error(`Permission mode "${permissionMode}" is not supported for agy. Valid values: ${Object.keys(MODE_ARGS).join(', ')}.`);
  return args;
}

// ---- Models ----------------------------------------------------------------

// The models agy offers a Gemini API key sign-in (`agy --model <bad>` lists
// them), each with the efforts it takes. A launch passes the family and the
// effort separately (`--model gemini-4-neon --effort high`); agy records the
// family as the conversation's model.
const E = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high' };
const family = (value, label, pill, efforts, extra = {}) => ({ value, label, pillLabel: pill, transcriptPrefixes: [value], efforts, ...extra });
const MODELS = [
  family('gemini-4-neon', 'Gemini 4 Neon', 'neon 4', ['low', 'medium', 'high', 'xhigh'], { default: true }),
  family('gemini-4-hydrogen', 'Gemini 4 Hydrogen', 'hydrogen 4', ['low', 'medium', 'high', 'xhigh']),
  family('gemini-4-carbon', 'Gemini 4 Carbon', 'carbon 4', ['low', 'medium', 'high']),
  family('gemini-4-argon', 'Gemini 4 Argon', 'argon 4', ['low', 'medium', 'high']),
  family('gemini-3.8-flash', 'Gemini 3.8 Flash', 'flash 3.8', ['low', 'medium', 'high']),
  family('gemini-3.1-pro', 'Gemini 3.1 Pro', 'pro 3.1', ['low', 'high']),
  { value: 'default', label: 'agy default (your /model choice)', pillLabel: 'agy', efforts: [] },
];
const EFFORTS = Object.entries(E).map(([value, label]) => ({ value, label }));

export function agyEffortsFor(model) {
  const m = MODELS.find((x) => x.value === model);
  if (!m) return EFFORTS;
  return EFFORTS.filter((e) => m.efforts.includes(e.value));
}

export function agyModelArgs(model, effort) {
  if (!model || model === 'default') return [];
  const args = ['--model', model];
  if (effort && agyEffortsFor(model).some((e) => e.value === effort)) args.push('--effort', effort);
  return args;
}

// ---- Launch ----------------------------------------------------------------

// The instructions a fresh conversation is handed (agy-hook.js injects them):
// a mandatory skill's nudge, card naming, the skills catalog (each SKILL.md read
// on demand by absolute path) and, in a worktree, its guardrail. The board's
// plugin folder is a second workspace agy may sort first, so the working
// directory is named outright.
// agy names a plugin's MCP server `<plugin>_<server>`, and each of its
// always-loaded tools (agy-mcp-bridge.js) `mcp_<that server>_<tool>`.
export const AGY_MCP_SERVER = `${PLUGIN_NAME}_${MCP_SERVER_NAME}`;
export const AGY_TOOL_PREFIX = `mcp_${AGY_MCP_SERVER}_`;

export function agyInstructions({ sessionId, cwd, worktree = null, disabledSkills }) {
  const tools = `Agent Wrangler's board tools are your functions named ${AGY_TOOL_PREFIX}<tool>. Wherever these instructions or a prompt name a board tool by its bare name (rename_session, job_report, read_mail, …), call that function.`;
  const title = `Once you understand the first substantive task, name your Agent Wrangler card with a concise 3-8 word description. Call ${AGY_TOOL_PREFIX}rename_session with {"target":"${sessionId}","name":"<short task title>","only_if_unnamed":true}. Do not use the folder name or copy the full prompt. The tool preserves an existing custom title.`;
  const where = cwd ? `Your working directory is ${cwd}. Run shell commands there, and pass it explicitly as the command's working directory. The workspace folder ending in agy/root is Agent Wrangler's plugin folder: never work in it.` : '';
  const parts = [where, tools, mandatorySkillPrompt(undefined, { disabledSkills }), title, codexSkillCatalog(undefined, { disabledSkills })];
  if (worktree) parts.push(worktreeGuardrailPrompt(worktree));
  return parts.filter(Boolean).join('\n\n');
}

function readUserSettings(agyDir = AGY_DIR) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(agyDir, 'settings.json'), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

// The launch's `--settings` (this session only, never saved): the launch folder
// trusted, and the board's always-on MCP tools allowed. Each list keeps the
// user's own entries, since a session setting replaces the saved one.
export function agySessionSettings({ cwd, user = readUserSettings(), ext } = {}) {
  const trusted = [...new Set([...(Array.isArray(user.trustedWorkspaces) ? user.trustedWorkspaces : []), ...(cwd ? [cwd] : [])])];
  const perms = user.permissions && typeof user.permissions === 'object' ? user.permissions : {};
  const grants = allowedAgyTools({ ext }).flatMap((t) => [`mcp(${MCP_SERVER_NAME}/${t})`, `mcp(${MCP_SERVER_NAME}_${MCP_SERVER_NAME}/${t})`]);
  const allow = [...new Set([...(Array.isArray(perms.allow) ? perms.allow : []), ...grants])];
  const settings = { permissions: { ...perms, allow } };
  if (trusted.length) settings.trustedWorkspaces = trusted;
  return settings;
}

// The extensions' env first and core's after, so an extension adds variables
// but never overrides ours. GEMINI_API_KEY is never written here: it reaches
// the pane through the launch's secret-variable file (agyLaunchSecretEnv).
function envPrefix({ sessionId, cwd, spawnedBy, launchContext, worktree, disabledSkills }) {
  let env = launchEnvGuard(launchContext, shellQuote) + launchEnvPrefix(launchContext, shellQuote)
    + `AW_SESSION_ID=${shellQuote(sessionId)} AW_PR_ATTACH_URL=${shellQuote(prAttachUrl())} AW_PR_MODEL_URL=${shellQuote(prModelUrl())} `
    + `AW_AGY_MCP_URL=${shellQuote(mcpUrl())} AW_AGY_IDS_DIR=${shellQuote(IDS_DIR)} `
    + (cwd ? `AW_AGY_CWD=${shellQuote(cwd)} ` : '')
    + `AW_AGY_CONTEXT=${shellQuote(agyInstructions({ sessionId, cwd, worktree, disabledSkills }))} `;
  if (spawnedBy) env += `AW_SPAWNER_SESSION_ID=${shellQuote(spawnedBy)} `;
  return env;
}

// ---- Gemini API key ----------------------------------------------------------

// agy with `"modelProvider": "gemini"` needs GEMINI_API_KEY, which a terminal
// usually gets from a shell function reading the Keychain item Gemini CLI
// writes. The board never runs an interactive shell, so it reads that item
// itself: macOS only, a set GEMINI_API_KEY always wins, and any failure is
// silent (agy then says the key is missing, as before). The value is never
// logged, and only reaches agy: a pane launch through the secret-variable file
// (launch-secrets.js), a headless run through its process env.
const KEYCHAIN_SERVICE = 'gemini-cli-api-key';
const KEYCHAIN_ACCOUNT = 'default-api-key';

// The item holds Gemini CLI's JSON: `{ token: { accessToken } }`.
async function keychainGeminiApiKey() {
  const { stdout } = await exec('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT, '-w'], { timeout: 5000 });
  return JSON.parse(stdout)?.token?.accessToken;
}

// `{ GEMINI_API_KEY }` from the Keychain, or {} when the env already has one,
// off macOS, or when the lookup fails.
export async function agyLaunchSecretEnv({ env = process.env, platform = process.platform, lookup = keychainGeminiApiKey } = {}) {
  if (env.GEMINI_API_KEY || platform !== 'darwin') return {};
  try {
    const key = await lookup();
    return typeof key === 'string' && key.trim() && !key.includes('\0') ? { GEMINI_API_KEY: key.trim() } : {};
  } catch {
    return {};
  }
}

function command(opts, args) {
  const root = ensureAgyRoot();
  const flags = [
    ...agyModeArgs(opts.permissionMode),
    ...agyModelArgs(opts.model, opts.effort),
    '--add-dir', root,
    ...[...launchAddDirsOf(opts.launchContext), ...(opts.addDirs || [])].flatMap((d) => ['--add-dir', d]),
    '--settings', JSON.stringify(agySessionSettings({ cwd: opts.cwd })),
    ...args,
  ];
  return `${envPrefix(opts)}agy ${flags.map(shellQuote).join(' ')}`;
}

// ---- The pane --------------------------------------------------------------

const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
const plain = (text) => String(text || '').replace(ANSI, '');
const RULE = /^\s*─{10,}\s*$/;
// Dialogs that wait on the human: folder trust, tool and command permission,
// sign-in, quota and a missing API key.
const NEEDS_YOU_RE = /Do you trust the contents of this project|Requesting permission|Run this command\?|Allow (?:calling )?this tool\?|Allow this|Authentication required|Select login method|not signed in|Individual quota reached|quota exceeded|GEMINI_API_KEY environment variable is not set/i;
// The footer under the composer reads `? for shortcuts` while agy waits and
// `esc to …` while a turn runs; the slash-command menu also ends in `esc to
// cancel`, under its `↑/↓ Navigate` hint, and is not a turn.
const BUSY_FOOTER_RE = /esc to (?:cancel|interrupt|stop)/i;
const MENU_RE = /↑\/↓ Navigate/;

function lines(text, n = 40) {
  return plain(text).split('\n').filter((l) => l.trim()).slice(-n);
}

// The composer: `> ` between the last two rules, with the footer below. Null
// when the pane shows none. Returns its text (the draft).
export function agyComposer(text) {
  const all = plain(text).split('\n');
  const bottom = all.findLastIndex((l) => RULE.test(l));
  if (bottom < 0) return null;
  let top = bottom - 1;
  while (top >= 0 && !RULE.test(all[top])) top -= 1;
  if (top < 0 || !/^\s*>/.test(all[top + 1] || '')) return null;
  return all.slice(top + 1, bottom)
    .map((l, i) => (i === 0 ? l.replace(/^\s*> ?/, '') : l.replace(/^ {2}/, '')))
    .join('\n').trimEnd();
}

// The lines under the composer's bottom rule.
function agyFooter(text) {
  const all = plain(text).split('\n');
  const bottom = all.findLastIndex((l) => RULE.test(l));
  return bottom < 0 ? '' : all.slice(bottom + 1).join('\n');
}

// The footer's model and effort: `Gemini 4 Neon · high`.
export function agyFooterModel(text) {
  const tail = lines(text, 3).join('\n');
  return /((?:Gemini|Claude|GPT)[^\n·]*?·\s*\w+)\s*$/m.exec(tail)?.[1]?.trim() || null;
}

export function agyClassify(text) {
  const recent = lines(text).join('\n');
  const ask = NEEDS_YOU_RE.exec(recent);
  if (ask) return { status: 'needs-you', waitingFor: ask[0] };
  const footer = agyFooter(text);
  if (BUSY_FOOTER_RE.test(footer) && !MENU_RE.test(lines(text, 8).join('\n'))) return { status: 'working' };
  if (agyComposer(text) !== null) return { status: 'idle' };
  return { status: 'unknown' };
}

// agy (1.5.15) starts a plugin's MCP servers only when something first needs
// them, and a turn is sent with the tools connected at that moment: the turn
// that starts a conversation, or the first one after a resume, never has the
// board's. Its `/mcp` panel starts them without a turn, so before anything is
// typed into a fresh pane the board opens it, waits for the board's server to
// show connected (or failed), and closes it (pane-ready.js warmUpPane).
const SERVER_RE = AGY_MCP_SERVER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const AGY_WARM_UP = {
  keys: '/mcp',
  panel: /^MCP Servers\s*$/m,
  ready: new RegExp(`✓\\s+${SERVER_RE}\\b`),
  failed: new RegExp(`✗\\s+${SERVER_RE}\\s+(.*)`),
  close: 'Escape',
};

const composerIsReady = (text) => agyComposer(text) !== null && agyClassify(text).status === 'idle';
function composerIsEmpty(text, { allowWhileWorking = false } = {}) {
  const draft = agyComposer(text);
  if (draft === null) return false;
  if (!allowWhileWorking && agyClassify(text).status !== 'idle') return false;
  return !draft.trim();
}

// ---- Headless --------------------------------------------------------------

// agy's print mode with every tool denied by a session permission rule, run in
// the caller's empty folder. With a prompt flag agy does not read stdin, so
// the prompt and the payload both go on stdin, payload first, and agy reads a
// piped prompt as print mode. `--output-format json` prints one object.
const DENY_ALL = ['command(*)', 'read_file(*)', 'write_file(*)', 'mcp(*)', 'read_url(*)', 'execute_url(*)'];
const agyHeadless = {
  defaultModel: () => 'gemini-3.8-flash',
  async command({ prompt, model, effort, stdin = '', env = {}, secretEnv = agyLaunchSecretEnv }) {
    const args = ['--output-format', 'json', '--disable-slash-commands', ...agyModelArgs(model, effort || 'low'),
      '--settings', JSON.stringify({ permissions: { deny: DENY_ALL } })];
    const base = { ...process.env, ...env };
    return { file: 'agy', args, env: { ...base, ...(await secretEnv({ env: base })) }, stdin: stdin ? `${stdin}\n\n${prompt}` : prompt };
  },
  // { conversation_id, status, response, error, usage, … }
  parse(stdout) {
    const text = String(stdout);
    const start = text.indexOf('{');
    const parsed = JSON.parse(start > 0 ? text.slice(start) : text);
    return {
      text: typeof parsed.response === 'string' && parsed.response ? parsed.response.trim() : null,
      liveSessionId: typeof parsed.conversation_id === 'string' && parsed.conversation_id ? parsed.conversation_id : undefined,
      error: parsed.error ? String(parsed.error) : (parsed.status && parsed.status !== 'SUCCESS' && !parsed.response ? `agy ${parsed.status}` : null),
    };
  },
};

export const agy = {
  id: 'agy',
  label: 'agy',
  tmuxPrefix: 'ag_',
  reviewPriority: 30,
  models: MODELS,
  efforts: EFFORTS,
  effortsForModel: (model) => agyEffortsFor(model),
  modelId: (value) => (value === 'default' ? null : value),
  // A launch with no --effort (auto-effort.js has what agy runs then).
  autoEffortResolver(paths) {
    const settingsModel = readAgySettingsModel(paths.agySettings);
    return (value) => resolveAgyAutoEffort(value, { settingsModel });
  },
  contextWindow: () => null,
  unavailableMessage: "This is an agy conversation, but the `agy` binary isn't on PATH — install Antigravity CLI (or put it on the launchd PATH) to resume agy sessions.",
  presetsSessionId: false,
  // No prompt goes on agy's command line, since it would start a turn with no
  // board tools: a resume's is pasted once the pane is up (pr-nudge-runner),
  // and a launch's is typed after the MCP warm-up (_prepareFirstTurn).
  resumeCarriesIntent: false,
  launchCarriesIntent: false,
  supportsRemoteControl: false,
  supportsDisallowedTools: false,
  headlessArchiveReview: false,
  headless: agyHeadless,
  // Secret variables for this agent's own launches only (launch-context.js).
  launchSecretEnv: () => agyLaunchSecretEnv(),
  history: {
    branches: false,
    directory: () => MIRROR_DIR,
    findFile: async (id) => syncMirror(id),
    async findFiles(id) {
      const file = syncMirror(id);
      return file ? [file] : [];
    },
    async launchCwd(id) {
      return conversationCwd(id);
    },
    async resolveResumeDir(id, { graphCwd, entryCwd } = {}) {
      return (await this.launchCwd(id)) || entryCwd || graphCwd || null;
    },
    forEachLine: forEachMirrorLine,
    createScanner: createAgyChatScanner,
    mightCarryChat: mightCarryAgyChat,
    mightCarryText: mightCarryAgyText,
    extractLine: extractAgyLine,
    discoverSources: () => agySources(),
  },
  usage: { billingProviders: [{ id: 'google', label: 'Google' }], scanDaily, scanMonth, costUsd: agyCostUsd, unknownModelLabel: 'agy (est.)' },
  labels: { liveTitle: false, summaryFirst: true },
  statusSource: 'pane',
  presentation: { icon: 'agy', color: '#3c7bf5', estimatedCost: true },
  controls: {
    switchModel: false,
    permissionModes: Object.keys(MODE_ARGS),
  },
  launch: { grantPaths: 'realpath', trust: null, gitMetadataGrants: false, codexPolicy: false, recoverMissingConversation: false },
  terminal: {
    readySignal: 'composer',
    contextSource: 'analysis',
    modelLabel: (text) => agyFooterModel(text),
    contextPercent: () => null,
    imageCount: () => null,
    classify: (text) => agyClassify(text),
    editingKeys: { newline: '\x1b\r', wordLeft: '\x1bb', wordRight: '\x1bf', clearLine: '\x15' },
    clearKeys: ['C-u'],
    composerIsReady,
    composerIsEmpty,
    composerDraft: (text) => agyComposer(text),
    suggestion: () => null,
    composerMark: '> ',
    paneMetadata: false,
    restoreDraft: false,
    allowWhileWorking: false,
    imageAcknowledgement: false,
    interruptKeys: ['Escape'],
    warmUp: AGY_WARM_UP,
  },

  async isAvailable() {
    try {
      const { stdout } = await exec('sh', ['-c', 'command -v agy']);
      return Boolean(stdout.trim());
    } catch {
      return false;
    }
  },

  // `agy` is a native binary: ps shows `/path/to/agy …` or `agy …`.
  matchProcess(command) {
    return /^(?:\S*\/)?agy(?:\s|$)/.test(command || '');
  },

  // No intent: the board types it once the MCP warm-up is done (launchCarriesIntent).
  buildLaunch({ sessionId, cwd, model, effort, permissionMode, addDirs = [], worktree = null, spawnedBy, launchContext, disabledSkills }) {
    const opts = { sessionId, cwd, spawnedBy, launchContext, worktree, disabledSkills, model, effort, permissionMode, addDirs };
    return command(opts, []);
  },

  buildResume({ sessionId, cwd, resumeId, model, effort, permissionMode, addDirs = [], worktree = null, spawnedBy, launchContext, disabledSkills }) {
    const opts = { sessionId, cwd, spawnedBy, launchContext, worktree, disabledSkills, model, effort, permissionMode, addDirs };
    return command(opts, ['--conversation', resumeId]);
  },

  discoverLiveId(opts) { return Promise.resolve(discoverAgyLiveId(opts)); },
  readLive() { return null; },
  analyze(liveSid, opts) { return analyzeAgy(liveSid, opts); },
  listResumable(excludeIds, opts) { return listResumableAgy(excludeIds, opts); },
  activityInRange(liveSid, startMs, endMs) { return activityInRangeAgy(liveSid, startMs, endMs); },
  transcriptPath(liveSid) { return syncMirror(liveSid); },
  subagentDetail: async () => null,
};
