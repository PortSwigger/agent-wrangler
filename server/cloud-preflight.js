import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { gitRepoRoot } from './worktree.js';

const exec = promisify(execFile);

// Env vars that switch Claude Code onto a non-subscription credential. A cloud
// session authenticates as the *account*, not as this machine's env, so any of
// these means the local launch would authenticate one way and the VM another —
// which surfaces as an opaque failure inside the pane rather than here.
const AUTH_VARS = [
  ['ANTHROPIC_API_KEY', 'ANTHROPIC_API_KEY is set'],
  ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_BEDROCK is set'],
  ['CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_VERTEX is set'],
];

// A bare `ANTHROPIC_API_KEY=` (or `CLAUDE_CODE_USE_BEDROCK=0`) is how a wrapper
// script *unsets* one of these for a child, so emptiness/`0`/`false` must read as
// absent — treating them as present would refuse every launch from such a shell.
function truthyEnv(v) {
  const s = String(v ?? '').trim().toLowerCase();
  return s !== '' && s !== '0' && s !== 'false';
}

// Same rule as runtimes/cloud.js's `classifyEnvironmentId`, deliberately restated
// here rather than imported: that module imports THIS one for its `preflight`, so
// importing back would be a cycle — and the two boundaries want different
// failures. There a garbage id must *throw* (a mistyped id must never silently
// pick a launch form); here it must become a human sentence a dialog can render.
function environmentIdRefusal(environmentId) {
  const id = String(environmentId || '').trim();
  if (!id) return null;
  if (id.startsWith('env_') || id.startsWith('ccpool_')) return null;
  return {
    code: 'cloud-bad-environment',
    message: `"${id}" isn't a cloud environment id — Anthropic-hosted ids start with env_, self-hosted runner ids with ccpool_.`,
  };
}

// The VM clones the repo from its GitHub remote, so an `origin` that isn't
// GitHub (a local path, a GitLab/Bitbucket URL) is as unusable as none at all.
// Matches both remote spellings: `https://github.com/o/r.git` and `git@github.com:o/r.git`.
function looksLikeGithubRemote(url) {
  return /(^|[@/.])github\.com([:/]|$)/i.test(String(url || '').trim());
}

// Run a git probe, resolving `null` on ANY failure instead of throwing: every
// caller below treats "couldn't tell" as "don't warn", since a preflight that
// blows up on an unexpected git edge case is worse than one that stays quiet.
async function gitOut(run, cwd, args) {
  try {
    const { stdout } = await run('git', ['-C', cwd, ...args]);
    return String(stdout ?? '');
  } catch {
    return null;
  }
}

// Can this cwd become a cloud session, and what should the human be told first?
// All git/env probing, no tmux and no session-manager import — a leaf, so the
// runtime, the live control handler and any future caller share one answer.
//
// `refusals` block dispatch; `warnings` are things to proceed *through*. Refusal
// order is deliberate, cheapest-and-most-actionable first (agent, then flags,
// then this machine's env, then the id we were handed, and only then git):
// callers show the FIRST refusal, so "cloud is Claude-only" must never be buried
// behind a git probe about a repo the user was never going to use.
//
// `run` (a promisified execFile) and `repoRoot` are injectable because the tests
// must not touch a real repo; `repoRoot` is a second seam only because
// `gitRepoRoot` — the canonical "which repo is this" probe, reused rather than
// re-derived — carries its own private runner.
//
// `ref` is accepted but not probed: it's the branch the VM checks out, resolved
// against the *remote* at clone time. Validating it here would mean a network
// round trip per keystroke of the dialog, and a ref that exists locally but was
// never pushed would still pass. The dirty/unpushed warnings below are the
// honest local signal about what the VM will actually see.
export async function cloudPreflight({
  cwd,
  agent = 'claude',
  workflow = false,
  environmentId = '',
  ref = '',
  env = process.env,
  run = exec,
  repoRoot = gitRepoRoot,
} = {}) {
  const refusals = [];
  const warnings = [];

  if (agent === 'codex') {
    refusals.push({
      code: 'cloud-codex',
      message: 'Cloud sessions are Claude-only — Codex has no cloud runtime. Pick Claude, or run this locally.',
    });
  }

  if (workflow) {
    refusals.push({
      code: 'cloud-workflow',
      message: 'Autopilot workflows can\'t run in the cloud — the issue-to-pr skill is loaded with --plugin-dir, which only exists on this machine.',
    });
  }

  for (const [name, phrase] of AUTH_VARS) {
    if (truthyEnv(env?.[name])) {
      refusals.push({
        code: 'cloud-auth',
        message: `${phrase} in the launch environment — cloud sessions need subscription (OAuth) auth, not an API key or a Bedrock/Vertex credential.`,
      });
      break;
    }
  }

  const badId = environmentIdRefusal(environmentId);
  if (badId) refusals.push(badId);

  const folder = String(cwd || '').trim();
  const root = folder ? await repoRoot(folder) : null;
  if (!root) {
    refusals.push({
      code: 'cloud-not-git',
      message: folder
        ? `${folder} isn't a git repository — a cloud session works from a pushed GitHub repo.`
        : 'No folder selected — a cloud session works from a pushed GitHub repo.',
    });
    // Every remaining probe is a `git -C` call in a repo we just proved isn't
    // one; there is nothing further to learn, and no warning worth emitting.
    return { refusals, warnings };
  }

  const origin = await gitOut(run, folder, ['remote', 'get-url', 'origin']);
  if (!origin || !looksLikeGithubRemote(origin)) {
    refusals.push({
      code: 'cloud-no-origin',
      message: origin
        ? `origin (${origin.trim()}) isn't a GitHub remote — the cloud VM clones from GitHub.`
        : 'This repo has no GitHub `origin` remote — the cloud VM clones from the remote, so there\'d be nothing to check out.',
    });
  }

  // `@{u}..HEAD` errors out when the branch has no upstream (a never-pushed
  // branch, or a detached HEAD). That's not a warning of its own — the missing
  // upstream tells us nothing about what the VM will see beyond what the
  // no-origin refusal or the dirty-tree warning already say.
  const ahead = await gitOut(run, folder, ['rev-list', '--count', '@{u}..HEAD']);
  const aheadCount = ahead === null ? 0 : Number.parseInt(ahead.trim(), 10) || 0;
  if (aheadCount > 0) {
    warnings.push({
      code: 'cloud-unpushed',
      message: `${aheadCount} commit${aheadCount === 1 ? '' : 's'} not pushed to the remote — the cloud session clones the pushed ref, so it won't see ${aheadCount === 1 ? 'it' : 'them'}.`,
    });
  }

  const status = await gitOut(run, folder, ['status', '--porcelain']);
  if (status && status.trim()) {
    warnings.push({
      code: 'cloud-dirty',
      message: 'Uncommitted local changes — the cloud session works from the pushed ref, so your working-tree edits are invisible to it.',
    });
  }

  return { refusals, warnings };
}
