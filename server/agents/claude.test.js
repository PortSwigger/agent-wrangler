import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getExtensions, _resetExtensionsForTests } from '../extensions/index.js';
import { claude, PR_HOOK_PATH, PR_HOOK_DEP_PATH, ISSUE_TO_PR_SKILL_DIR } from './claude.js';
import { adapterFor, adapterForProcess, adapterForContainerProcess, availableAgents, modelPillFor, maxContextWindowFor, modelsWithDefault } from './index.js';

test('claude adapter identity', () => {
  assert.equal(claude.id, 'claude');
  assert.equal(claude.tmuxPrefix, 'cc_');
  assert.equal(claude.presetsSessionId, true);
  assert.equal(claude.resumeCarriesIntent, true); // buildResume threads the intent (`claude --resume -- <intent>`)
});

test('claude buildLaunch carries session id, auto mode, model, env', () => {
  const cmd = claude.buildLaunch({ sessionId: 'SID', intent: 'do it', model: 'opus', addDirs: [] });
  assert.match(cmd, /'--session-id' 'SID'/);
  assert.match(cmd, /'--permission-mode' 'auto'/);
  assert.match(cmd, /'--model' 'opus'/);
  assert.match(cmd, /AW_SESSION_ID='SID'/);
  // `--` must precede the prompt: the trailing variadic flags would otherwise
  // swallow it as a tool/config value and the session would start empty.
  assert.match(cmd, / -- 'do it'$/);
  assert.match(cmd, /^env -u CLAUDECODE/);
});

test('claude exposes an efforts list with expected levels and no default', () => {
  const values = claude.efforts.map((e) => e.value);
  assert.deepEqual(values, ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.ok(!claude.efforts.some((e) => e.default), 'effort has no built-in default (unset = agent default)');
});

test('claude threads --effort into launch/resume/fork only when set', () => {
  const launch = claude.buildLaunch({ sessionId: 'SID', effort: 'high' });
  const resume = claude.buildResume({ sessionId: 'OWNER', resumeId: 'LIVE', effort: 'max' });
  const fork = claude.buildFork({ sessionId: 'CARD', liveSessionId: 'FL', sourceId: 'SRC', effort: 'low' });
  assert.match(launch, /'--effort' 'high'/);
  assert.match(resume, /'--effort' 'max'/);
  assert.match(fork, /'--effort' 'low'/);
});

test('claude omits --effort entirely when no effort is given', () => {
  assert.doesNotMatch(claude.buildLaunch({ sessionId: 'SID' }), /--effort/);
  assert.doesNotMatch(claude.buildResume({ sessionId: 'OWNER', resumeId: 'LIVE' }), /--effort/);
  assert.doesNotMatch(claude.buildFork({ sessionId: 'CARD', liveSessionId: 'FL', sourceId: 'SRC' }), /--effort/);
});

test('claude maps an auto-compaction threshold on launch, resume, and fork', () => {
  const launch = claude.buildLaunch({ sessionId: 'SID', autoCompactTokens: 200000 });
  const resume = claude.buildResume({ sessionId: 'OWNER', resumeId: 'LIVE', autoCompactTokens: 300000 });
  const fork = claude.buildFork({ sessionId: 'CARD', liveSessionId: 'FL', sourceId: 'SRC', autoCompactTokens: 400000 });
  assert.match(launch, /'--autocompact' '200000'/);
  assert.match(resume, /'--autocompact' '300000'/);
  assert.match(fork, /'--autocompact' '400000'/);
});

test('claude leaves auto-compaction unset when a session has no threshold', () => {
  assert.doesNotMatch(claude.buildLaunch({ sessionId: 'SID' }), /--autocompact/);
  assert.doesNotMatch(claude.buildResume({ sessionId: 'OWNER', resumeId: 'LIVE' }), /--autocompact/);
  assert.doesNotMatch(claude.buildFork({ sessionId: 'CARD', liveSessionId: 'FL', sourceId: 'SRC' }), /--autocompact/);
});

test('every Claude launch/resume/fork loads the wrangler-meta skills plugin', () => {
  const launch = claude.buildLaunch({ sessionId: 'SID' });
  const resume = claude.buildResume({ sessionId: 'OWNER', resumeId: 'LIVE' });
  const fork = claude.buildFork({ sessionId: 'CARD', liveSessionId: 'FORKLIVE', sourceId: 'SRC' });
  for (const cmd of [launch, resume, fork]) assert.match(cmd, /'--plugin-dir' '[^']*\/agent-skills'/);
});

// An extension's skill is not in the in-repo plugin root, so it rides as a
// plugin of its own — on every launch path, and only while the gate keeps it.
// The registry is primed here rather than injected because buildInnerCommand
// reads the memo directly, exactly as production does.
test('an extension-shipped skill is a --plugin-dir on every launch path, and the gate takes it away', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-ext-skill-'));
  const skillDir = path.join(dir, 'skills', 'job-worker');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: job-worker\ndescription: The bounded-step protocol.\n---\n\nBody.\n');
  _resetExtensionsForTests();
  getExtensions({ cfg: {}, builtin: [{ id: 'jobs', label: 'Jobs', defaultEnabled: true, dir, skills: ['job-worker'] }] });
  try {
    const cmds = [
      claude.buildLaunch({ sessionId: 'SID' }),
      claude.buildResume({ sessionId: 'OWNER', resumeId: 'LIVE' }),
      claude.buildFork({ sessionId: 'CARD', liveSessionId: 'FORKLIVE', sourceId: 'SRC' }),
    ];
    for (const cmd of cmds) assert.match(cmd, new RegExp(`'--plugin-dir' '${skillDir}'`));
    assert.doesNotMatch(claude.buildLaunch({ sessionId: 'SID', disabledSkills: ['job-worker'] }), /job-worker/);
  } finally {
    _resetExtensionsForTests();
  }
});

test('a plain launch still carries --append-system-prompt for the mandatory-skill nudge (task memory)', () => {
  // taskMemory pinned so this doesn't depend on the live config.json (the
  // disabled path is covered in agent-skills.test.js).
  const plain = claude.buildLaunch({ sessionId: 'SID', taskMemory: true });
  assert.match(plain, /--append-system-prompt/);
  assert.match(plain, /AW_TASK_MEMORY/);
  assert.doesNotMatch(plain, /already running inside a dedicated git worktree/);
});

test('a worktree launch appends both the mandatory-skill nudge and the guardrail', () => {
  const wt = claude.buildLaunch({ sessionId: 'SID', worktree: { path: '/v/p-worktree-x', branch: 'x' } });
  assert.match(wt, /--append-system-prompt/);
  assert.match(wt, /AW_TASK_MEMORY/);
  assert.match(wt, /already running inside a dedicated git worktree/);
});

test('a workflow launch loads BOTH the wrangler-meta and issue-to-pr plugins', () => {
  const wf = claude.buildLaunch({ sessionId: 'SID', workflow: true });
  assert.match(wf, /'--plugin-dir' '[^']*\/agent-skills'/);
  assert.match(wf, /'--plugin-dir' '[^']*\/skills\/issue-to-pr'/);
});

test('claude buildLaunch presets a distinct live --session-id; memory stays on the card id', () => {
  const cmd = claude.buildLaunch({ sessionId: 'CARD', liveSessionId: 'LIVE', intent: 'go' });
  assert.match(cmd, /'--session-id' 'LIVE'/);
  assert.match(cmd, /AW_SESSION_ID='CARD'/);
});

test('claude buildLaunch falls back to the card id as session id when no live id given (legacy)', () => {
  const cmd = claude.buildLaunch({ sessionId: 'CARD' });
  assert.match(cmd, /'--session-id' 'CARD'/);
});

test('claude buildLaunch injects the worktree guardrail only when launched in a worktree', () => {
  const plain = claude.buildLaunch({ sessionId: 'BID' });
  const wt = claude.buildLaunch({ sessionId: 'BID', worktree: { path: '/v/proj-worktree-x', branch: 'x' } });
  assert.doesNotMatch(plain, /already running inside a dedicated git worktree/);
  assert.match(wt, /already running inside a dedicated git worktree/);
});

test('claude buildResume continues the session in place (plain --resume, no fork)', () => {
  const cmd = claude.buildResume({ sessionId: 'OWNER', resumeId: 'LIVE' });
  assert.match(cmd, /'--resume' 'LIVE'/);
  assert.doesNotMatch(cmd, /--fork-session/);
  assert.match(cmd, /AW_SESSION_ID='OWNER'/);
});

test('claude buildFork presets a distinct --session-id for the fork and resumes the source', () => {
  const cmd = claude.buildFork({ sessionId: 'CARD', liveSessionId: 'FORKLIVE', sourceId: 'SRC' });
  assert.match(cmd, /'--resume' 'SRC' '--fork-session'/);
  assert.match(cmd, /'--session-id' 'FORKLIVE'/);
  assert.match(cmd, /AW_SESSION_ID='CARD'/); // memory/identity stays on the card id
});

test('workflow launch loads the issue-to-pr skill as a plugin; a plain launch does not', () => {
  const wf = claude.buildLaunch({ sessionId: 'SID', workflow: true });
  const plain = claude.buildLaunch({ sessionId: 'SID' });
  assert.match(wf, /'--plugin-dir' '[^']*\/skills\/issue-to-pr'/);
  assert.doesNotMatch(plain, /\/skills\/issue-to-pr/);
});

test('resume of a workflow entry reloads the skill plugin; a plain resume does not', () => {
  const wf = claude.buildResume({ sessionId: 'OWNER', resumeId: 'LIVE', workflow: true });
  const plain = claude.buildResume({ sessionId: 'OWNER', resumeId: 'LIVE' });
  assert.match(wf, /'--plugin-dir' '[^']*\/skills\/issue-to-pr'/);
  assert.doesNotMatch(plain, /\/skills\/issue-to-pr/);
});

test('a fork never loads the workflow skill plugin (a fork is not a tracked run)', () => {
  const cmd = claude.buildFork({ sessionId: 'CARD', liveSessionId: 'FORKLIVE', sourceId: 'SRC' });
  assert.doesNotMatch(cmd, /\/skills\/issue-to-pr/);
});

test('claude launch injects the wrangler MCP server + allow entry keyed on the card id', () => {
  const cmd = claude.buildLaunch({ sessionId: 'CARD', liveSessionId: 'LIVE', intent: '' });
  assert.match(cmd, /--mcp-config/);
  assert.match(cmd, /mcp__agent-wrangler__list_sessions/);
  assert.match(cmd, /mcp__agent-wrangler__spawn_session/);
  // The card id rides as the X-AW-Session header inside the --mcp-config JSON.
  assert.match(cmd, /X-AW-Session/);
  assert.match(cmd, /CARD/);
});

test('claude launch injects the PR-attach hook on Bash + the attach-url env', () => {
  const cmd = claude.buildLaunch({ sessionId: 'CARD', liveSessionId: 'LIVE', intent: '' });
  assert.match(cmd, /--settings/);
  assert.match(cmd, /PostToolUse/);
  assert.match(cmd, /pr-attach-hook\.mjs/);
  assert.match(cmd, /AW_PR_ATTACH_URL='http:\/\/127\.0\.0\.1:\d+\/pr-attach'/);
});

test('claude resume + fork also inject the PR-attach hook (all paths share buildInnerCommand)', () => {
  const resume = claude.buildResume({ sessionId: 'OWNER', resumeId: 'LIVE' });
  const fork = claude.buildFork({ sessionId: 'CARD', liveSessionId: 'FORKLIVE', sourceId: 'SRC' });
  assert.match(resume, /pr-attach-hook\.mjs/);
  assert.match(fork, /pr-attach-hook\.mjs/);
});

test('claude discoverLiveId returns the preset id', async () => {
  assert.equal(await claude.discoverLiveId({ sessionId: 'SID', cwd: '/x' }), 'SID');
});

test('registry resolves claude, defaults unknown agent to claude', () => {
  assert.equal(adapterFor('claude').id, 'claude');
  assert.equal(adapterFor(undefined).id, 'claude');
  assert.equal(adapterFor('bogus').id, 'claude');
});

test('adapterForProcess matches a claude command', () => {
  assert.equal(adapterForProcess('/usr/bin/claude --session-id x')?.id, 'claude');
  assert.equal(adapterForProcess('/bin/zsh -l'), null);
});

test('matchContainerized: a devcontainer/docker exec wrapping claude matches; a plain host claude does not', () => {
  const dc = "node /x/node_modules/.bin/devcontainer exec --workspace-folder /r sh -lc env AW_SESSION_ID='s' claude '--session-id' '1a0f' '--model' 'sonnet'";
  const dk = "docker exec -i -t -u node CID sh -lc env claude '--session-id' '1a0f'";
  assert.equal(adapterForContainerProcess(dc)?.id, 'claude');
  assert.equal(adapterForContainerProcess(dk)?.id, 'claude');
  assert.equal(adapterForContainerProcess('/usr/bin/claude --session-id x'), null); // plain host = not containerized
  assert.equal(adapterForContainerProcess('docker exec CID /bin/sh'), null);        // wrapper but no agent
});

test('availableAgents always includes claude', async () => {
  const ids = (await availableAgents()).map((a) => a.id);
  assert.ok(ids.includes('claude'));
});

test('claude offers fable', () => {
  assert.ok(claude.models.some((m) => m.value === 'fable'));
});

test('claude offers opusplan as a selectable model', () => {
  assert.ok(claude.models.some((m) => m.value === 'opusplan'));
});

test('modelPillFor shortens a transcript model and falls back to the launch model', () => {
  assert.deepEqual(modelPillFor('claude', 'claude-sonnet-4-5-20250929', 'opus'), {
    label: 'sonnet', title: 'claude-sonnet-4-5-20250929',
  });
  assert.deepEqual(modelPillFor('codex', null, 'gpt-5.6-sol'), {
    label: 'gpt-5.6 sol', title: 'gpt-5.6-sol',
  });
  assert.deepEqual(modelPillFor('claude', 'claude-sonnet-4-5-20250929', 'sonnet[1m]'), {
    label: 'sonnet 1m', title: 'claude-sonnet-4-5-20250929',
  });
});

test('maxContextWindowFor: reads the ceiling off the claude model entry, respecting the 1M/200K split', () => {
  assert.equal(maxContextWindowFor('claude', null, 'sonnet'), 200_000);
  assert.equal(maxContextWindowFor('claude', null, 'sonnet[1m]'), 1_000_000);
  // The transcript prefix alone can't tell sonnet from sonnet[1m] — the launch
  // value is what disambiguates (same precedence as modelPillFor).
  assert.equal(maxContextWindowFor('claude', 'claude-sonnet-4-5-20250929', 'sonnet[1m]'), 1_000_000);
  assert.equal(maxContextWindowFor('claude', 'claude-sonnet-4-5-20250929', 'sonnet'), 200_000);
  // opusplan has no single window to report.
  assert.equal(maxContextWindowFor('claude', null, 'opusplan'), null);
});

// Regression (found in adversarial review of PR #178): an adopted session, or
// a legacy entry, deliberately carries `model: null` (see session-manager.js
// SessionManager.adopt()), so `launchModel` here is genuinely absent — not
// merely "didn't happen to be passed". Same story after a live /model switch
// to a value the launch model never recorded. With no launch value to
// disambiguate, sonnet and sonnet[1m]'s shared transcript prefix must NOT
// silently resolve to sonnet's 200K — that would render a confidently WRONG
// number for a real 1M session, which is strictly worse than showing nothing.
test('maxContextWindowFor: an ambiguous transcript model with no disambiguating launch model stays null, not a guess', () => {
  assert.equal(maxContextWindowFor('claude', 'claude-sonnet-4-5-20250929', null), null);
  assert.equal(maxContextWindowFor('claude', 'claude-sonnet-4-5-20250929', undefined), null);
  // An unrelated launch model (doesn't disambiguate either) is the same as none.
  assert.equal(maxContextWindowFor('claude', 'claude-sonnet-4-5-20250929', 'opus'), null);
  // A currentModel with only ONE possible match is still inferred correctly —
  // the fix must not turn every unset-launch-model case into a null.
  assert.equal(maxContextWindowFor('claude', 'claude-opus-4-20250514', null), 1_000_000);
  assert.equal(maxContextWindowFor('claude', 'claude-haiku-4-5-20251001', null), 200_000);
});

// codexContextWindow's own read-a-real-cache-entry behaviour is covered with
// controlled fixtures in codex-rollout.test.js; this only checks the thin
// wrapper delegates to it for the codex branch, so a deliberately impossible
// slug (never a real Codex model) keeps the result deterministic regardless
// of whatever happens to be cached at ~/.codex/models_cache.json on the host.
test('maxContextWindowFor: codex delegates to codexContextWindow, null for a slug it could never have cached', () => {
  assert.equal(maxContextWindowFor('codex', null, 'not-a-real-model-xyz'), null);
});

test('modelsWithDefault leaves the built-in default when AW_DEFAULT_MODEL is unset or unknown', () => {
  const builtin = claude.models.find((m) => m.default).value;
  assert.equal(modelsWithDefault(claude, {}).find((m) => m.default).value, builtin);
  assert.equal(modelsWithDefault(claude, { AW_DEFAULT_MODEL: 'nope' }).find((m) => m.default).value, builtin);
});

test('modelsWithDefault re-points the default to AW_DEFAULT_MODEL when it matches', () => {
  const models = modelsWithDefault(claude, { AW_DEFAULT_MODEL: 'sonnet' });
  assert.equal(models.filter((m) => m.default).length, 1);
  assert.equal(models.find((m) => m.default).value, 'sonnet');
  assert.ok(!claude.models.find((m) => m.value === 'sonnet').default, 'must not mutate the adapter');
});

test('exported launch-input paths resolve to real files/dirs', () => {
  assert.ok(fs.existsSync(PR_HOOK_PATH), 'pr-attach-hook.mjs missing');
  assert.ok(fs.existsSync(PR_HOOK_DEP_PATH), 'server/pr-hook.js missing');
  assert.ok(PR_HOOK_PATH.endsWith('/scripts/pr-attach-hook.mjs'));
  assert.ok(PR_HOOK_DEP_PATH.endsWith('/server/pr-hook.js'));
  assert.ok(fs.existsSync(ISSUE_TO_PR_SKILL_DIR), 'skills/issue-to-pr missing');
});

test('parseTeamMember pulls the agent-team identity off a member command line', () => {
  const cmd = '/Users/x/.local/share/claude/versions/2.1.211 --agent-id worker-arm@session-8fa334d2 '
    + '--agent-name worker-arm --team-name session-8fa334d2 --agent-color blue '
    + '--parent-session-id b318d00c-f5fb-45c3-b058-ae70e9b5ea63 --agent-type general-purpose '
    + '--permission-mode auto --model claude-opus-4-8';
  assert.deepEqual(claude.parseTeamMember(cmd), {
    name: 'worker-arm',
    agentType: 'general-purpose',
    color: 'blue',
    teamName: 'session-8fa334d2',
    parentLiveId: 'b318d00c-f5fb-45c3-b058-ae70e9b5ea63',
  });
});

test('parseTeamMember accepts --flag=value form too', () => {
  const m = claude.parseTeamMember('claude --team-name=t1 --parent-session-id=P --agent-name=recon --agent-type=explorer');
  assert.equal(m.name, 'recon');
  assert.equal(m.teamName, 't1');
  assert.equal(m.parentLiveId, 'P');
});

test('parseTeamMember returns null for an ordinary (non-team) launch', () => {
  assert.equal(claude.parseTeamMember('claude --session-id SID --permission-mode auto --model opus'), null);
  assert.equal(claude.parseTeamMember(''), null);
});
