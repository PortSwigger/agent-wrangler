import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';

const exec = promisify(execFile);

// Function/filler words dropped from a slug so it keeps the *work*, not the
// framing. Real action verbs and nouns (fix, add, improve, refactor, support…)
// are deliberately kept. The negation/aux fragments (don, doesn, isn, won…) are
// what contraction stripping leaves behind ("don't"→"don"); the reporting/modal
// words (noticed, want, would, please…) are the preamble that buried the subject
// in names like "ve-noticed-workflow".
const STOPWORDS = new Set([
  // articles / prepositions / conjunctions / pronouns / copula
  'the', 'a', 'an', 'to', 'of', 'for', 'on', 'in', 'at', 'and', 'or', 'is',
  'are', 'be', 'with', 'this', 'that', 'these', 'those', 'please', 'can', 'you',
  'i', 'we', 'my', 'our', 'it', 'its', 'they', 'them', 'their', 'he', 'she',
  'as', 'by', 'from', 'but', 'so', 'no', 'not', 'than', 'then', 'about',
  // aux / modal / reporting / filler — the preamble, never the work
  'has', 'have', 'had', 'was', 'were', 'will', 'do', 'does', 'did', 'done',
  'would', 'should', 'could', 'may', 'might', 'must', 'shall', 'need', 'needs',
  'want', 'wants', 'like', 'noticed', 'notice', 'think', 'see', 'seeing', 'seen',
  'also', 'while', 'when', 'what', 'which', 'just', 'very', 'really', 'being',
  'been', 'still', 'here', 'there',
  // negation / aux bases left behind after stripping contraction tails
  'don', 'doesn', 'didn', 'isn', 'wasn', 'aren', 'weren', 'won', 'wouldn',
  'couldn', 'shouldn', 'hasn', 'haven', 'hadn', 'mustn',
]);

const MAX_SLUG = 40;

// Lowercase a string to a git-ref-safe kebab slug: ascii alnum runs joined by
// single dashes, no leading/trailing dash, no empty result handling.
function kebab(s) {
  return (String(s || '').toLowerCase().match(/[a-z0-9]+/g) || []).join('-');
}

// Trim a dash-joined slug to <= max chars on a WORD boundary (never mid-word) so
// names stay clean instead of "…authenticatio". Always keeps the first word
// (hard-cutting it only if it alone exceeds max).
function clampWords(slug, max = MAX_SLUG) {
  if (slug.length <= max) return slug;
  const words = slug.split('-');
  let out = words[0].slice(0, max);
  for (let i = 1; i < words.length; i += 1) {
    const next = `${out}-${words[i]}`;
    if (next.length > max) break;
    out = next;
  }
  return out;
}

// Reduce an arbitrary (possibly user- or agent-supplied) name to a clean,
// ref-safe, length-clamped branch slug. Empty when the input has no alnum.
export function sanitizeBranch(name) {
  return clampWords(kebab(name));
}

// Deterministic branch slug from the dispatch intent. This is a *placeholder*:
// at dispatch time the real work isn't known (a Jira key / GitHub issue only
// reveals its title once the agent runs — see name_branch / renameBranch), so the
// goal here is just a clean, descriptive-as-possible default, never garbage.
// `short` is the session-id prefix used for the fallback when nothing survives.
export function slugFromIntent(intent, { short = '' } = {}) {
  let text = String(intent || '').toLowerCase();
  // A GitHub issue reference carries no prose worth slugging — name it for the
  // issue number (the agent fetches the real title later).
  const ref = text.match(/github\.com\/\S+?\/issues\/(\d+)/) || text.match(/(?:^|\s)#(\d+)\b/);
  if (ref) return `issue-${ref[1]}`;
  // Drop contraction tails so fragments never pollute the slug, keeping the base
  // word: "I've"→"i", "they're"→"they", "workflow's"→"workflow", "don't"→"don".
  text = text.replace(/['’][a-z]+/g, '');
  const words = (text.match(/[a-z0-9]+/g) || [])
    .filter((w) => w.length > 1 && !STOPWORDS.has(w));
  return clampWords(words.join('-')) || `session-${short}`;
}

// Absolute path of the MAIN repo root for any path inside the repo — stable even
// when `cwd` is itself a linked worktree (we anchor on the common git dir).
// Returns null when `cwd` is not inside a git repository.
export async function gitRepoRoot(cwd) {
  try {
    const { stdout } = await exec('git', ['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir']);
    return path.dirname(stdout.trim());
  } catch {
    return null;
  }
}

// True when `cwd` is itself a *linked* worktree (not the main checkout): its own
// git-dir (…/.git/worktrees/<name>) differs from the common git-dir (…/.git).
// Used to warn that a new worktree created from here branches off the main
// checkout, not this worktree.
export async function isLinkedWorktree(cwd) {
  try {
    const { stdout } = await exec('git', ['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir']);
    const [gitDir, commonDir] = stdout.trim().split('\n');
    return Boolean(gitDir && commonDir && gitDir !== commonDir);
  } catch {
    return false;
  }
}

export function worktreeDirName(repoRoot, branch) {
  return `${path.basename(repoRoot)}-worktree-${branch}`;
}

export class WorktreeError extends Error {}

export async function branchExists(repoRoot, branch) {
  try {
    await exec('git', ['-C', repoRoot, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

// resolve a path to its canonical form, tolerating a not-yet-existing target
// (an unmade folder realpaths to itself). Used to compare folder paths against
// git's worktree list across symlinked parents (e.g. macOS /var → /private/var).
function realpathOrSelf(p) {
  try { return fs.realpathSync(p); } catch { return p; }
}

// Registered worktrees of `repoRoot` as [{ path, branch }] (branch null when
// detached). Parsed from `git worktree list --porcelain` — the authoritative
// source, so adoption is a verified fact rather than an fs.existsSync guess.
async function listWorktrees(repoRoot) {
  const { stdout } = await exec('git', ['-C', repoRoot, 'worktree', 'list', '--porcelain']);
  const list = [];
  let cur = null;
  for (const line of stdout.split('\n')) {
    if (line.startsWith('worktree ')) { cur = { path: line.slice(9), branch: null }; list.push(cur); }
    else if (line.startsWith('branch ') && cur) cur.branch = line.slice(7).replace(/^refs\/heads\//, '');
  }
  return list;
}

// Decide what a (folder, branch) pair means and how createWorktree should act on
// it. Asked of git itself. Precedence (load-bearing): adopt → branch-in-use →
// folder-blocked → existing-branch → new — adopt must win over branch-in-use
// because in the adopt case the branch IS checked out, at the target folder.
//   new            — branch absent, folder absent/empty → `add -b`
//   existing-branch— branch exists, folder absent/empty, not checked out → `add` (no -b)
//   adopt          — folder is already this repo's worktree on `branch` → use as-is
//   branch-in-use  — branch checked out in a DIFFERENT worktree → refuse
//   folder-blocked — folder non-empty and not an adoptable worktree → refuse
export async function classifyWorktreeTarget({ repoRoot, folder, branch }) {
  const bExists = await branchExists(repoRoot, branch);
  const worktrees = await listWorktrees(repoRoot);
  const normFolder = realpathOrSelf(folder);
  const wtAtFolder = worktrees.find((w) => realpathOrSelf(w.path) === normFolder);
  if (wtAtFolder && wtAtFolder.branch === branch) return { status: 'adopt', conflictPath: wtAtFolder.path };

  const wtOnBranch = worktrees.find((w) => w.branch === branch);
  if (bExists && wtOnBranch && realpathOrSelf(wtOnBranch.path) !== normFolder) {
    return { status: 'branch-in-use', conflictPath: wtOnBranch.path };
  }

  const exists = fs.existsSync(folder);
  const empty = exists && fs.readdirSync(folder).length === 0;
  if (exists && !empty) return { status: 'folder-blocked' };
  return { status: bExists ? 'existing-branch' : 'new' };
}

// Create or adopt a sibling worktree. `folderName` (basename) defaults to
// `<repo>-worktree-<branch>`. When `auto`, a colliding branch/folder is bumped
// with the smallest free numeric suffix (so auto only ever produces a fresh
// `new`). Otherwise classifyWorktreeTarget drives the action: a fresh target is
// created (`-b` for a new branch, plain `add` to check out an existing one), an
// existing worktree on the branch is adopted as-is (dirty tree tolerated), and a
// genuinely impossible target (branch busy elsewhere, folder occupied) throws
// WorktreeError. Always returns { path, branch, repoRoot }.
export async function createWorktree({ cwd, branch, folderName = '', auto = false }) {
  const repoRoot = await gitRepoRoot(cwd);
  if (!repoRoot) throw new WorktreeError('Not a git repository');
  const parent = path.dirname(repoRoot);
  // A user-supplied `folderName` may be an absolute path (placed anywhere they
  // like) or a bare name (a sibling of the repo). The auto-derived default is a
  // bare name → sibling. `auto` always derives from the branch so the suffix loop
  // can advance.
  const folderFor = (b) => {
    const fn = (!auto && folderName) ? folderName : worktreeDirName(repoRoot, b);
    return path.isAbsolute(fn) ? fn : path.join(parent, fn);
  };

  let b = branch;
  let f = folderFor(b);
  let status = 'new';
  if (auto) {
    let n = 1;
    const base = b;
    while ((await branchExists(repoRoot, b)) || fs.existsSync(f)) {
      n += 1;
      b = `${base}-${n}`;
      f = folderFor(b);
    }
  } else {
    const cls = await classifyWorktreeTarget({ repoRoot, folder: f, branch: b });
    if (cls.status === 'adopt') return { path: f, branch: b, repoRoot };
    if (cls.status === 'branch-in-use') throw new WorktreeError(`Branch ${b} is already checked out at ${cls.conflictPath}`);
    if (cls.status === 'folder-blocked') throw new WorktreeError(`Folder already exists and is not an adoptable worktree: ${f}`);
    status = cls.status;
  }

  // `existing-branch` checks the branch out (no -b); everything else makes a new branch.
  const addArgs = status === 'existing-branch'
    ? ['-C', repoRoot, 'worktree', 'add', f, b]
    : ['-C', repoRoot, 'worktree', 'add', '-b', b, f];
  try {
    await exec('git', addArgs);
  } catch (e) {
    throw new WorktreeError(`git worktree add failed: ${(e.stderr || e.message || '').toString().trim()}`);
  }
  // git worktree add does not initialize submodules; do it now so agents find the expected files.
  if (fs.existsSync(path.join(repoRoot, '.gitmodules'))) {
    try {
      await exec('git', ['-C', f, 'submodule', 'update', '--init', '--recursive']);
    } catch (e) {
      throw new WorktreeError(`git submodule update failed: ${(e.stderr || e.message || '').toString().trim()}`);
    }
  }
  return { path: f, branch: b, repoRoot };
}

// Best-effort main-repo root for a (possibly already-removed) worktree entry.
// Prefers the root stored at creation, then a live git query (works only while
// the dir survives), then the `<repo>-worktree-<branch>` naming convention as a
// last resort for legacy entries whose dir is already gone. Null when none hold.
export async function repoRootForWorktree({ path: wtPath, branch, repoRoot } = {}) {
  if (repoRoot) return repoRoot;
  if (wtPath && fs.existsSync(wtPath)) {
    const r = await gitRepoRoot(wtPath);
    if (r) return r;
  }
  if (wtPath && branch) {
    const suffix = `-worktree-${branch}`;
    const base = path.basename(wtPath);
    if (base.endsWith(suffix)) return path.join(path.dirname(wtPath), base.slice(0, -suffix.length));
  }
  return null;
}

// State of a worktree entry for the client: does its directory still exist, and
// does its branch still exist. Drives the archive toast's cleanup button (delete
// worktree vs delete branch vs nothing). Null for a non-worktree entry.
export async function worktreeStatus(wt) {
  if (!wt?.path) return null;
  const repoRoot = await repoRootForWorktree(wt);
  return {
    path: wt.path,
    branch: wt.branch || null,
    dirExists: fs.existsSync(wt.path),
    branchExists: Boolean(repoRoot && wt.branch && (await branchExists(repoRoot, wt.branch))),
  };
}

// Remove a worktree directory. A clean `git worktree remove` refuses when the
// worktree has uncommitted/untracked changes — surfaced as { blocked, reason } so
// the caller can re-try with force on explicit confirmation. An already-removed
// dir is a no-op success. Hard failures throw WorktreeError.
export async function removeWorktree({ worktreePath, repoRoot = '', force = false }) {
  if (!worktreePath) throw new WorktreeError('No worktree path');
  if (!fs.existsSync(worktreePath)) return { ok: true, alreadyGone: true };
  const root = repoRoot || (await gitRepoRoot(worktreePath));
  if (!root) throw new WorktreeError('Could not resolve the repository for this worktree');
  const args = ['-C', root, 'worktree', 'remove', worktreePath];
  if (force) args.push('--force');
  try {
    await exec('git', args);
    return { ok: true };
  } catch (e) {
    const reason = (e.stderr || e.message || '').toString().trim();
    if (!force && /use --force|contains modified or untracked|is dirty|locked working tree|submodules cannot be/i.test(reason)) {
      return { ok: false, blocked: true, reason };
    }
    throw new WorktreeError(`git worktree remove failed: ${reason}`);
  }
}

// Delete a branch. A clean `git branch -d` refuses an unmerged branch — surfaced
// as { blocked, reason } so the caller can re-try with `-D` on confirmation. An
// already-deleted branch is a no-op success. Hard failures throw WorktreeError.
export async function deleteBranch({ repoRoot, branch, force = false }) {
  if (!repoRoot || !branch) throw new WorktreeError('Missing repository or branch');
  if (!(await branchExists(repoRoot, branch))) return { ok: true, alreadyGone: true };
  try {
    await exec('git', ['-C', repoRoot, 'branch', force ? '-D' : '-d', branch]);
    return { ok: true };
  } catch (e) {
    const reason = (e.stderr || e.message || '').toString().trim();
    if (!force && /not fully merged/i.test(reason)) {
      return { ok: false, blocked: true, reason };
    }
    throw new WorktreeError(`git branch delete failed: ${reason}`);
  }
}

// Rename the branch checked out in a worktree to a descriptive name. The
// dispatch-time slug is a placeholder (slugFromIntent can't know the work yet);
// once an autopilot run understands its issue it renames to something concise via
// name_branch → SessionManager → here. `desired` is sanitised to a ref-safe slug
// and auto-suffixed on collision. We do NOT move the directory — the live shell
// sits in it — so the dir keeps its `-worktree-<oldbranch>` name; that's inert
// because modern entries store `repoRoot` (cleanup never re-derives it from the
// dir). The board's branch badge reads HEAD live, so the rename shows at once;
// the caller syncs `entry.worktree.branch` for cleanup/status. Returns the final
// branch name; throws WorktreeError on a detached HEAD or git failure.
export async function renameBranch({ worktreePath, repoRoot = '', desired, currentBranch = '' }) {
  if (!worktreePath) throw new WorktreeError('No worktree path');
  const root = repoRoot || (await gitRepoRoot(worktreePath));
  if (!root) throw new WorktreeError('Could not resolve the repository for this worktree');
  const base = sanitizeBranch(desired);
  if (!base) throw new WorktreeError('A branch name must contain at least one letter or digit.');
  if (base === currentBranch) return { branch: currentBranch, repoRoot: root, unchanged: true };
  let name = base;
  for (let n = 2; name !== currentBranch && (await branchExists(root, name)); n += 1) {
    name = `${base}-${n}`;
  }
  try {
    // One-arg form renames whatever branch is currently checked out at the
    // worktree, robust to a drifted `currentBranch` record; HEAD follows the ref.
    await exec('git', ['-C', worktreePath, 'branch', '-m', name]);
  } catch (e) {
    throw new WorktreeError(`git branch -m failed: ${(e.stderr || e.message || '').toString().trim()}`);
  }
  return { branch: name, repoRoot: root };
}

// Guardrail for a session the wrangler launches inside a worktree it created:
// the agent is ALREADY isolated, so it must not spin up a *second* (nested)
// worktree (which would orphan this branch). Stated as fact, not a procedure, so
// no agent can botch it. Injected only on dispatch (the creation moment).
export function worktreeGuardrailPrompt({ path, branch } = {}) {
  return `You are already running inside a dedicated git worktree created for this task: ${path} (branch \`${branch}\`). Do all your work in this directory. Do not create another git worktree, and do not cd out of it — your workspace is already isolated.`;
}
