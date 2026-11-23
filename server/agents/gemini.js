import { geminiCostUsd } from '../pricing.js';
import { GEMINI_TMP, cwdForConversation, findConversation, forEachConversationLine, geminiSources } from './gemini-files.js';
import { createGeminiChatScanner, extractGeminiLine, mightCarryGeminiChat, mightCarryGeminiText } from './gemini-transcript.js';
import { activityInRangeGemini, analyzeGemini, geminiContextWindow, listResumableGemini, scanDaily, scanMonth } from './gemini-usage.js';

// Google's Gemini CLI (`gemini`), kept only to read the conversations it left
// behind: agy (Antigravity CLI, agy.js) replaced it as the board's Gemini
// agent. Nothing starts, resumes, forks, adopts or runs a headless call on it
// (`dispatchable: false`, no build functions, no `headless`). What stays is
// what an old card or search result reads: its chat, its usage and estimated
// cost, its model pill, and status for a pane still running from before.

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

// ---- Models ----------------------------------------------------------------

// The models its sessions ran, for an old card's model pill and context window.
// `auto` was the CLI's own default (it routed each turn between Pro and Flash).
const MODELS = [
  { value: 'auto', label: 'Auto · Gemini picks Pro or Flash', pillLabel: 'auto', default: true, contextWindow: 1_048_576 },
  { value: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro (preview)', pillLabel: 'pro 3.1', transcriptPrefixes: ['gemini-3.1-pro'], contextWindow: 1_048_576 },
  { value: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', pillLabel: 'pro 2.5', transcriptPrefixes: ['gemini-2.5-pro'], contextWindow: 1_048_576 },
  { value: 'gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash-Lite', pillLabel: 'flash-lite 3.1', transcriptPrefixes: ['gemini-3.1-flash-lite'], contextWindow: 1_048_576 },
  { value: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash', pillLabel: 'flash 3.5', transcriptPrefixes: ['gemini-3.5-flash'], contextWindow: 1_048_576 },
];

export const gemini = {
  id: 'gemini',
  label: 'Gemini CLI',
  tmuxPrefix: 'gm_',
  reviewPriority: 30,
  dispatchable: false,
  // A Background model still set to Gemini CLI runs agy's (headless.js).
  replacedBy: 'agy',
  models: MODELS,
  efforts: [],
  // `auto` runs whichever model Gemini routes a turn to, so it names no one id.
  modelId: (value) => (value === 'auto' ? null : value),
  contextWindow: geminiContextWindow,
  unavailableMessage: 'This is a Gemini CLI conversation. Agent Wrangler no longer runs Gemini CLI, so it can be read but not resumed: start an agy session instead.',
  // The card id is the conversation id (it was fixed at launch with `--session-id`).
  presetsSessionId: true,
  supportsRemoteControl: false,
  supportsDisallowedTools: false,
  headlessArchiveReview: false,
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
    // The modes its sessions were launched in, for an old card's mode chip.
    permissionModes: ['auto', 'manual', 'acceptEdits', 'plan'],
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

  async isAvailable() { return false; },

  // `gemini` is a node script: ps shows `node /path/to/bin/gemini …`, twice
  // (the CLI relaunches itself with a larger heap).
  matchProcess(command) {
    return /(?:^|\/)gemini(?:\.js)?(?:\s|$)/.test(command || '');
  },

  async discoverLiveId({ sessionId }) { return sessionId; },
  readLive() { return null; },
  analyze(liveSid, opts) { return analyzeGemini(liveSid, opts); },
  listResumable(excludeIds, opts) { return listResumableGemini(excludeIds, opts); },
  activityInRange(liveSid, startMs, endMs, dir) { return activityInRangeGemini(liveSid, startMs, endMs, dir); },
  transcriptPath(liveSid, dir) { return findConversation(liveSid, dir); },
  subagentDetail: async () => null,
};
