import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { linkPathFor, addDirFor } from '../memory-store.js';
import { analyze, listResumable, activityInRange } from '../transcript-reader.js';
import { liveState } from '../claude-paths.js';
import { worktreeGuardrailPrompt } from '../worktree.js';
import { claudeMcpConfigArg, allowedToolsArg, prAttachUrl } from '../mcp/client-config.js';
import { AGENT_SKILLS_PLUGIN_DIR, mandatorySkillPrompt } from '../agent-skills.js';

// The autopilot issue-to-pr skill ships in-repo (skills/issue-to-pr) and is loaded
// as a plugin only on workflow launches (below), so it's available no matter which
// repo the workflow's worktree belongs to — without a user-level ~/.claude/skills
// symlink. Resolved from this module's own path, so the running install (worktree
// or merged main checkout) always points at its own bundled copy.
export const ISSUE_TO_PR_SKILL_DIR = fileURLToPath(new URL('../../skills/issue-to-pr', import.meta.url));

export function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

// Absolute path to the PostToolUse PR-attach hook (this file is server/agents/).
export const PR_HOOK_PATH = path.join(fileURLToPath(import.meta.url), '..', '..', '..', 'scripts', 'pr-attach-hook.mjs');
// The .mjs imports `../server/pr-hook.js` at runtime; the devcontainer runtime copies
// this file to the sibling container location so that relative import resolves.
export const PR_HOOK_DEP_PATH = path.join(fileURLToPath(import.meta.url), '..', '..', 'pr-hook.js');

// Inline --settings value for every Claude launch. Claude merges --settings with
// the user's own settings.json (additive) and an explicit --settings key wins over
// the file, so this forces behaviour regardless of the user's global config:
//   - tui: 'fullscreen' pins the alternate-screen renderer on (CLI 2.1.89+) so a
//     spawned pane never falls back to the inline renderer, whatever the user set.
//   - the PR-attach hook on Bash; a user's own hooks still run alongside it. Passive:
//     the hook exits 0 with no stdout, never blocking a tool.
function launchSettings() {
  return JSON.stringify({
    tui: 'fullscreen',
    hooks: { PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: PR_HOOK_PATH }] }] },
  });
}

// Defined here (not imported from tmux-scraper) to keep agents a leaf layer.
function isClaudeCommand(c) {
  return /(?:^|\/)claude(?:\s|$)/.test(c) || /claude\/versions\//.test(c);
}

// Pull a single-token flag value out of a process command line, accepting either
// `--flag value` or `--flag=value`.
function flagValue(command, flag) {
  const m = String(command || '').match(new RegExp(`${flag}(?:[=\\s]+)(\\S+)`));
  return m ? m[1] : null;
}

// An "agent team" member is a full `claude` launched by the team lead with a
// distinct pane in the lead's tmux session; its command carries team flags
// (`--agent-name`, `--agent-type`, `--team-name`, `--parent-session-id`,
// `--agent-color`) that an ordinary launch never has. Returns the member's
// identity when those markers are present, else null (a normal session). The
// lead is linked by `parentLiveId` (the lead's LIVE session id) — but grouping
// is primarily by shared tmux session, since a member pane lives in the lead's.
// A team member writes NO ~/.claude/sessions/<pid>.json, so this command-line
// parse is the only signal the wrangler has for it.
function parseTeamMember(command) {
  const teamName = flagValue(command, '--team-name');
  const parentLiveId = flagValue(command, '--parent-session-id');
  if (!teamName && !parentLiveId) return null;
  return {
    name: flagValue(command, '--agent-name'),
    agentType: flagValue(command, '--agent-type'),
    color: flagValue(command, '--agent-color'),
    teamName,
    parentLiveId,
  };
}

const NESTED_CLAUDE_ENV = [
  'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_EXECPATH', 'CLAUDE_CODE_TMPDIR', 'CLAUDE_JOB_DIR',
];

// A wrangler first started from inside a Claude session keeps CLAUDECODE /
// CLAUDE_CODE_* in its env; spawned panes inherit them and the launched claude
// looks nested, so (CLI 2.1.169+) it drops its transcript and can't be resumed or
// forked. Strip the non-prefixed markers (static list) PLUS every inherited
// CLAUDE_CODE_* — the latter dynamically, so newer vars like
// CLAUDE_CODE_CHILD_SESSION are covered without the list going stale.
export function withCleanClaudeEnv(cmd) {
  const dynamic = Object.keys(process.env).filter((k) => k.startsWith('CLAUDE_CODE_'));
  const vars = [...new Set([...NESTED_CLAUDE_ENV, ...dynamic])];
  return `env ${vars.map((v) => `-u ${v}`).join(' ')} ${cmd}`;
}

export function buildInnerCommand({ args, intent = '', sessionId, worktree = null, workflow = false, spawnedBy, taskMemory }) {
  // memory/links are wrangler-meta skills now (loaded via --plugin-dir below), but
  // skill discovery alone isn't reliable for one that must be followed at every
  // session start regardless of task relevance — so a mandatory skill's nudge
  // still rides the always-on appended prompt, alongside the conditional
  // worktree guardrail. `taskMemory` is only threaded so tests can pin it; left
  // undefined here (the production path) it falls through to the live-config
  // default inside mandatorySkillPrompt.
  const appendPrompt = [mandatorySkillPrompt(undefined, { taskMemory }), worktree ? worktreeGuardrailPrompt(worktree) : '']
    .filter(Boolean).join('\n\n');
  const full = [
    ...args,
    '--add-dir', addDirFor(sessionId),
  ];
  if (appendPrompt) full.push('--append-system-prompt', appendPrompt);
  full.push(
    '--mcp-config', claudeMcpConfigArg(sessionId),
    '--allowedTools', allowedToolsArg(),
    '--settings', launchSettings(),
    // The wrangler-meta skills (task-memory, links, spawn-session) load on every
    // launch, fork, and resume — cwd-independent, surviving a mid-session cd.
    '--plugin-dir', AGENT_SKILLS_PLUGIN_DIR,
  );
  // Workflow runs additionally name the issue-to-pr skill in their launch prompt;
  // load it as a second plugin so it resolves without a user-level symlink.
  // --plugin-dir merges with the user's own plugins and stacks. Scoped to workflow
  // launches so it doesn't appear in every session's skill list.
  if (workflow) full.push('--plugin-dir', ISSUE_TO_PR_SKILL_DIR);
  let inner = `AW_SESSION_ID=${shellQuote(sessionId)} AW_TASK_MEMORY=${shellQuote(linkPathFor(sessionId))} `
    + `AW_PR_ATTACH_URL=${shellQuote(prAttachUrl())} `;
  if (spawnedBy) inner += `AW_SPAWNER_SESSION_ID=${shellQuote(spawnedBy)} `;
  inner += `claude ${full.map(shellQuote).join(' ')}`;
  // `--` terminates option parsing: the trailing flags (--mcp-config,
  // --allowedTools) are variadic, so without it the bare positional prompt is
  // greedily swallowed as another value and the session starts empty.
  if (intent.trim()) inner += ` -- ${shellQuote(intent.trim())}`;
  return inner;
}

export const claude = {
  id: 'claude',
  label: 'Claude',
  tmuxPrefix: 'cc_',
  presetsSessionId: true,
  // buildResume threads `intent` into the relaunch command (`claude --resume … --
  // <intent>`), so a dormant-wake nudge handed as the resume intent is delivered by
  // the relaunch itself — no post-resume pane paste needed (see pr-nudge-runner).
  resumeCarriesIntent: true,
  models: [
    { value: 'fable', label: 'Fable 5 · 1M context' },
    { value: 'opus', label: 'Opus 5 · 1M context', default: true },
    { value: 'opusplan', label: 'Opus plan · Sonnet execution' },
    { value: 'sonnet', label: 'Sonnet 5 · 200K context' },
    { value: 'sonnet[1m]', label: 'Sonnet 5 · 1M context' },
    { value: 'haiku', label: 'Haiku 4.5 · 200K context' },
  ],
  efforts: [
    { value: 'low', label: 'Low' },
    { value: 'medium', label: 'Medium' },
    { value: 'high', label: 'High' },
    { value: 'xhigh', label: 'Extra high' },
    { value: 'max', label: 'Max' },
  ],

  async isAvailable() { return true; },
  matchProcess(command) { return isClaudeCommand(command || ''); },
  parseTeamMember(command) { return parseTeamMember(command || ''); },

  // A `devcontainer exec`/`docker exec` wrapping the claude CLI: the binary is an
  // ARGUMENT (e.g. `docker exec … sh -lc 'env … claude --session-id …'`), so the
  // executable-anchored matchProcess misses it. Recognizing the wrapper + the claude
  // token lets discovery surface a devcontainer session so its runtime hook can drive
  // status/cost (the host pid found is the wrapper's — used only for cpu/tty).
  matchContainerized(command) {
    const c = command || '';
    return /\b(?:devcontainer|docker)\s+exec\b/.test(c) && /(?:^|\s)claude(?:\s|$)/.test(c);
  },

  buildLaunch({ sessionId, liveSessionId, intent = '', model, effort, addDirs = [], worktree = null, workflow = false, spawnedBy, taskMemory }) {
    // The conversation runs under its own live id (distinct from the card id) so the
    // card id is never also a conversation id. Memory/identity stays on the card id.
    // Falls back to the card id when no live id is supplied (legacy callers).
    const args = ['--session-id', liveSessionId || sessionId, '--permission-mode', 'auto'];
    if (model) args.push('--model', model);
    if (effort) args.push('--effort', effort);
    for (const d of addDirs) args.push('--add-dir', d);
    return withCleanClaudeEnv(buildInnerCommand({ args, intent, sessionId, worktree, workflow, spawnedBy, taskMemory }));
  },

  buildResume({ sessionId, resumeId, effort, workflow = false, intent = '', spawnedBy, taskMemory }) {
    // Plain --resume continues the conversation in place under its own id (no
    // --fork-session), so the live id stays equal to resumeId and the transcript
    // grows rather than duplicating. Safe because resume() kills the old tmux first.
    // A scheduled resume may carry an `intent` to queue as the first prompt
    // (buildInnerCommand appends it after `--`); empty for an interactive resume.
    // effort is re-threaded here because it is NOT transcript-restored on resume.
    const args = ['--resume', resumeId, '--permission-mode', 'auto'];
    if (effort) args.push('--effort', effort);
    return withCleanClaudeEnv(buildInnerCommand({ args, intent, sessionId, workflow, spawnedBy, taskMemory }));
  },

  buildFork({ sessionId, liveSessionId, sourceId, model, effort, intent = '', taskMemory }) {
    // Branch the source conversation into a *new* id we choose (liveSessionId), so
    // the fork's conversation is known at launch and lives under its board id — no
    // phantom, so the fork is resumable. Memory/identity stays on the card id.
    const args = ['--resume', sourceId, '--fork-session'];
    if (liveSessionId) args.push('--session-id', liveSessionId);
    args.push('--permission-mode', 'auto');
    if (model) args.push('--model', model);
    if (effort) args.push('--effort', effort);
    return withCleanClaudeEnv(buildInnerCommand({ args, intent, sessionId, taskMemory }));
  },

  // Claude is given its id at launch, so the live id is the board id.
  async discoverLiveId({ sessionId }) { return sessionId; },

  readLive({ pid }) { return liveState(pid); },
  analyze(liveSid, opts) { return analyze(liveSid, undefined, opts); },
  listResumable(excludeIds, opts) { return listResumable(excludeIds, opts); },
  activityInRange(liveSid, startMs, endMs, dir) { return activityInRange(liveSid, startMs, endMs, dir); },
};
