import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { shellQuote } from './claude.js';
import { launchAddDirArgs, launchEnvGuard, launchEnvPrefix } from '../launch-context.js';
import { INSTALL_ROOT } from '../install-root.js';
import { serverPort } from '../runtime.js';
import { agyModels, agyEfforts, resolveAgyModel } from './agy-catalog.js';
import { agyPane } from './agy-pane.js';
import { agyHistory, analyzeAgy, agySubagentDetail, listResumableAgy, activityInRangeAgy, agyTranscriptPath } from './agy-history.js';
import { readAgyLive } from '../agy-hooks.js';
import { agyIntegrationReady } from '../agy-plugin.js';
import { scanDaily, scanMonth, agyCostUsd } from './agy-usage.js';
const exec = promisify(execFile);
export function agyModeArgs(mode = 'auto') {
  const args = { 'edit-only': ['--sandbox'], auto: ['--mode', 'auto'], 'full-access': ['--dangerously-skip-permissions'] }[mode];
  if (!args) throw new Error(`Unknown Antigravity mode: ${mode}`);
  return args;
}
function command(options, conversation) {
  const { sessionId, cwd = '', launchContext, spawnedBy, addDirs = [], intent = '' } = options;
  const { model, effort } = resolveAgyModel(options.model || undefined, options.effort || undefined);
  const args = [...agyModeArgs(), '--model', model];
  if (effort) args.push('--effort', effort);
  if (conversation) args.push('--conversation', conversation);
  else if (intent) args.push('-i', intent);
  args.push(...launchAddDirArgs(launchContext));
  for (const dir of addDirs) args.push('--add-dir', dir);
  const clean = [...Object.keys(process.env).filter((k) => k.startsWith('ANTIGRAVITY_')), 'AGY_ADC_AUTH', 'GOOGLE_APPLICATION_CREDENTIALS', 'GEMINI_API_KEY', 'AGY_ACCOUNT'];
  const env = `${launchEnvPrefix({ ...launchContext, env: Object.fromEntries(Object.entries(launchContext?.env || {}).filter(([k]) => !k.startsWith('ANTIGRAVITY_') && !['AGY_ADC_AUTH', 'GOOGLE_APPLICATION_CREDENTIALS', 'GEMINI_API_KEY', 'AGY_ACCOUNT'].includes(k))) }, shellQuote)}AW_SESSION_ID=${shellQuote(sessionId)} AW_CWD=${shellQuote(cwd)} AW_INSTALL_ROOT=${shellQuote(INSTALL_ROOT)} AW_NODE=${shellQuote(process.execPath)} AW_PORT=${shellQuote(String(serverPort()))} AW_AGY_WORKTREE=${shellQuote(JSON.stringify(options.worktree || null))} AW_AGY_DISABLED_SKILLS=${shellQuote(JSON.stringify(options.disabledSkills || []))} `
    + (spawnedBy ? `AW_SPAWNER_SESSION_ID=${shellQuote(spawnedBy)} ` : '');
  const cleanup = String.raw`for aw_agy_key in $(env | sed -n 's/^\(ANTIGRAVITY_[A-Z0-9_]*\)=.*/\1/p'); do unset "$aw_agy_key"; done;`;
  return `${launchEnvGuard(launchContext, shellQuote)}( unset ${clean.join(' ')}; ${cleanup} ${env}exec agy ${args.map(shellQuote).join(' ')} )`;
}
export const agy = {
  id: 'agy', label: 'Antigravity', reviewPriority: 30, tmuxPrefix: 'ag_', presetsSessionId: false,
  resumeCarriesIntent: false, hookIdentity: true, interactiveFork: true,
  unavailableMessage: 'Enable Manage agy integration in Settings and install agy on PATH to dispatch or resume Antigravity.',
  presentation: { icon: 'agy', color: '#4285f4', estimatedCost: true },
  controls: { switchModel: true, permissionModes: ['auto'], autoCompact: {} },
  labels: { liveTitle: false, summaryFirst: true },
  launch: { grantPaths: 'realpath', gitMetadataGrants: true, localOnly: true, trust: 'agy' },
  terminal: {
    guardEverySend: true,
    readySignal: 'composer', contextSource: 'analysis', modelLabel: (text) => agyPane.model(text), contextPercent: () => null,
    classify: (text) => agyPane.classify(text), imageCount: (text) => agyPane.imageCount(text),
    composerHoldsText: (pane, text) => agyPane.ready(pane) && agyPane.draft(pane).trimEnd() === String(text).trimEnd(),
    composerIsReady: (text) => agyPane.ready(text), composerIsEmpty: (text) => agyPane.empty(text), composerDraft: (text) => agyPane.draft(text),
    suggestion: () => null, composerMark: '>', paneMetadata: false, restoreDraft: true, allowWhileWorking: true,
    editingKeys: { newline: '\x1b\r', wordLeft: '\x1bb', wordRight: '\x1bf', clearLine: '\x15' },
    clearKeys: ['C-u'], interruptKeys: ['Escape'], imageAcknowledgement: true,
    backgroundShellPattern: /active subagents|background tasks/i,
  },
  get models() { return agyModels(); },
  contextWindow: (model) => agyModels().find((m) => m.value === model || (m.value === 'gemini-3.8-flash' && /^gemini-3\.8-flash-(low|medium|high)$/.test(model || '')))?.contextWindow || null,
  get efforts() { return agyEfforts('gemini-3.8-flash'); },
  autoEffortResolver: () => (model) => agyModels().find((m) => m.value === model)?.defaultEffort || null,
  effortsForModel: (model) => agyEfforts(model || 'gemini-3.8-flash'),
  modelCommand: (model) => { const picked = resolveAgyModel(model); return `/model ${picked.model}${picked.effort ? `-${picked.effort}` : ''}`; },
  history: agyHistory, subagentDetail: agySubagentDetail,
  usage: { billingProviders: [{ id: 'gemini', label: 'Gemini' }, { id: 'anthropic', label: 'Anthropic' }, { id: 'openai', label: 'OpenAI' }], scanDaily, scanMonth, costUsd: agyCostUsd, unknownModelLabel: 'unknown (tokens only)' },
  async isAvailable() {
    if (!agyIntegrationReady()) return false;
    try { return Boolean((await exec('sh', ['-c', 'command -v agy'])).stdout.trim()); } catch { return false; }
  },
  matchProcess(command) { return /^(?:\S*\/)?agy(?:\s|$)/.test(command || ''); },
  buildLaunch: (opts) => command(opts), buildResume: (opts) => command(opts, opts.resumeId), buildFork: (opts) => command(opts, opts.sourceId),
  discoverLiveId: async () => null,
  readLive: readAgyLive, analyze: analyzeAgy, listResumable: listResumableAgy, activityInRange: activityInRangeAgy, transcriptPath: agyTranscriptPath,
};
