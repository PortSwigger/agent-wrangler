import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { launchEnvPrefix } from '../launch-context.js';
import { mandatorySkillPrompt, piSkillDirs } from '../agent-skills.js';
import { shellQuote, ISSUE_TO_PR_SKILL_DIR } from './claude.js';
import { renameTitlePrompt } from './codex.js';
import { worktreeGuardrailPrompt } from '../worktree.js';
import { mcpUrl, MCP_TOKEN_ENV } from '../mcp/client-config.js';
import { piModels, PI_EFFORTS } from './pi-catalog.js';
import { findPiSession, piLaunchCwd, analyzePi, piActivityInRange, piTurns } from './pi-session.js';

const exec = promisify(execFile);

// The extension every launch loads with `-e`: it registers the wrangler's MCP
// tools as pi tools (see the file for why that is not pi's own MCP config).
export const PI_EXTENSION_PATH = fileURLToPath(new URL('./pi-extension/agent-wrangler.js', import.meta.url));

// Env assignments + the `pi` binary. The extensions' env comes first and core's
// after, so an extension adds variables but never overrides ours (the last
// assignment of a name wins in a shell prefix). AW_MCP_URL is how the extension
// finds this server; AW_SESSION_ID is the card id it identifies the caller by.
function envPrefix(sessionId, spawnedBy, launchContext) {
  let env = launchEnvPrefix(launchContext, shellQuote)
    + `AW_SESSION_ID=${shellQuote(sessionId)} ${MCP_TOKEN_ENV}=${shellQuote(sessionId)} AW_MCP_URL=${shellQuote(mcpUrl())} `;
  if (spawnedBy) env += `AW_SPAWNER_SESSION_ID=${shellQuote(spawnedBy)} `;
  return env;
}

// Flags shared by launch/resume/fork: the always-on prompt (mandatory skill
// nudges, the card-title request, the worktree guardrail when there is one), the
// wrangler extension, and every active skill. Pi has no OS sandbox and no
// directory grants: it reads and writes wherever its user can, so addDirs and
// the extensions' launch-context directories need no flag.
function commonFlags({ sessionId, worktree = null, workflow = false, disabledSkills }) {
  const prompt = [mandatorySkillPrompt(undefined, { disabledSkills }), renameTitlePrompt(sessionId), worktree ? worktreeGuardrailPrompt(worktree) : '']
    .filter(Boolean).join('\n\n');
  const args = ['--append-system-prompt', prompt, '-e', PI_EXTENSION_PATH];
  for (const dir of piSkillDirs(undefined, { disabledSkills })) args.push('--skill', dir);
  if (workflow) args.push('--skill', ISSUE_TO_PR_SKILL_DIR);
  return args;
}

// `--` ends option parsing, so an intent that starts with a dash is still the
// first message rather than a flag.
function command(sessionId, spawnedBy, launchContext, args, intent) {
  let inner = `${envPrefix(sessionId, spawnedBy, launchContext)}pi ${args.map(shellQuote).join(' ')}`;
  if (intent.trim()) inner += ` -- ${shellQuote(intent.trim())}`;
  return inner;
}

export const pi = {
  id: 'pi',
  label: 'Pi',
  tmuxPrefix: 'pi_',
  // `pi --session-id <id>` creates the session under an id we choose, and
  // `--fork <src> --session-id <id>` names the fork's, so the live id is known
  // at launch exactly as it is for Claude.
  presetsSessionId: true,
  // `pi --session <id> -- <message>` resumes and sends the message as the first
  // turn, so a dormant-wake nudge rides the relaunch itself.
  resumeCarriesIntent: true,
  // Where get_session_activity / read_session_transcript find this agent's
  // files in their deps; absent there, pi-session.js's own default applies.
  transcriptDirDep: 'piSessionsDir',
  // No pi flag sets its compaction threshold (that lives in its settings.json),
  // so a card cannot carry one.
  autoCompactMinTokens: null,
  // Pi queues a prompt sent mid-turn as a steering message that interrupts the
  // running turn's next step, so notifications wait for idle as Claude's do.
  acceptsInputWhileWorking: false,
  // The chat view has no reader for pi's session format yet, so a pi card
  // opens in the terminal (see conversation-file.js).
  chatView: false,
  get models() {
    return piModels();
  },
  modelsDoc: 'any `provider/id` that `pi --list-models` prints on this machine (only those in pi\'s `enabledModels` when that is set), e.g. `anthropic/claude-sonnet-5-5`; omit `model` for pi\'s own default',
  efforts: PI_EFFORTS,

  async isAvailable() {
    try {
      const { stdout } = await exec('sh', ['-c', 'command -v pi']);
      return Boolean(stdout.trim());
    } catch {
      return false;
    }
  },

  // Pi sets its process title to a bare `pi`, so the command line carries no
  // arguments to match on — only the executable name.
  matchProcess(command) {
    return /(?:^|\/)pi(?:\s|$)/.test(command || '');
  },

  buildLaunch({ sessionId, liveSessionId, intent = '', model, effort, worktree = null, workflow = false, spawnedBy, launchContext, disabledSkills }) {
    const args = ['--session-id', liveSessionId || sessionId];
    if (model) args.push('--model', model);
    if (effort) args.push('--thinking', effort);
    args.push(...commonFlags({ sessionId, worktree, workflow, disabledSkills }));
    return command(sessionId, spawnedBy, launchContext, args, intent);
  },

  // The model and thinking level are restored from the session file (its
  // model_change / thinking_level_change entries); effort is passed again only
  // when the card carries one, matching the other adapters.
  buildResume({ sessionId, resumeId, effort, worktree = null, workflow = false, intent = '', spawnedBy, launchContext, disabledSkills }) {
    const args = ['--session', resumeId];
    if (effort) args.push('--thinking', effort);
    args.push(...commonFlags({ sessionId, worktree, workflow, disabledSkills }));
    return command(sessionId, spawnedBy, launchContext, args, intent);
  },

  buildFork({ sessionId, liveSessionId, sourceId, model, effort, intent = '', launchContext, disabledSkills }) {
    const args = ['--fork', sourceId];
    if (liveSessionId) args.push('--session-id', liveSessionId);
    if (model) args.push('--model', model);
    if (effort) args.push('--thinking', effort);
    args.push(...commonFlags({ sessionId, disabledSkills }));
    return command(sessionId, undefined, launchContext, args, intent);
  },

  async discoverLiveId({ sessionId }) { return sessionId; },

  // No per-pid status file: status is scraped from the pane by classify().
  readLive() { return null; },
  analyze(liveSid, opts = {}) { return analyzePi(liveSid, { since: opts.since }); },
  // Adopting a pi session started outside the board is not supported yet.
  async listResumable() { return []; },
  activityInRange(liveSid, startMs, endMs, dir) { return piActivityInRange(liveSid, startMs, endMs, dir); },
  transcriptPath(liveSid, dir) { return findPiSession(liveSid, dir); },
  readTurns(file) { return piTurns(file); },
  // The directory a resume must run in for `pi --session <id>` to find the file.
  launchCwd(liveSid) { return piLaunchCwd(liveSid); },
};
