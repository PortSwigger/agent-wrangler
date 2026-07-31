import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { slugFromIntent, sanitizeBranch, gitRepoRoot, worktreeDirName, branchExists, createWorktree, renameBranch, WorktreeError, worktreeGuardrailPrompt, isLinkedWorktree, removeWorktree, deleteBranch, repoRootForWorktree, worktreeStatus, classifyWorktreeTarget } from './worktree.js';

test('slugFromIntent: drops stopwords, keeps content words for a descriptive slug', () => {
  assert.equal(slugFromIntent('Please fix the broken auth flow on the login page'), 'fix-broken-auth-flow-login-page');
});

test('slugFromIntent: slugifies punctuation and case to [a-z0-9-]', () => {
  assert.equal(slugFromIntent('Refactor the Payment_Gateway (v2)!'), 'refactor-payment-gateway-v2');
});

test('slugFromIntent: strips contraction tails so fragments never leak in', () => {
  // The real bug: "I've noticed the workflow…" used to slug to "ve-noticed-workflow"
  // ("ve" from "I've", grabbing the complaint preamble). No "ve"/"re" fragment now.
  const s = slugFromIntent("I've noticed the workflow session create branches");
  assert.ok(!/(^|-)ve(-|$)/.test(s), s);
  assert.ok(!s.startsWith('ve-'), s);
  assert.equal(s, 'workflow-session-create-branches');
  assert.equal(slugFromIntent("don't drop the cache"), 'drop-cache');
});

test('slugFromIntent: a GitHub issue reference becomes issue-<n>', () => {
  assert.equal(slugFromIntent('https://github.com/owner/repo/issues/42'), 'issue-42');
  assert.equal(slugFromIntent('Fix the thing described in #1234'), 'issue-1234');
});

test('slugFromIntent: a Jira key slugs cleanly', () => {
  assert.equal(slugFromIntent('ENT-1234'), 'ent-1234');
});

test('slugFromIntent: drops single-character tokens', () => {
  assert.equal(slugFromIntent('a b configure the c server'), 'configure-server');
});

test('slugFromIntent: falls back to session-<short> when empty or all stopwords', () => {
  assert.equal(slugFromIntent('the a an to of', { short: 'ab12cd34' }), 'session-ab12cd34');
  assert.equal(slugFromIntent('', { short: 'ab12cd34' }), 'session-ab12cd34');
});

test('slugFromIntent: truncates on a word boundary (never mid-word) within 40 chars', () => {
  const s = slugFromIntent('implement comprehensive authentication subsystem overhaul');
  assert.ok(s.length <= 40, s);
  assert.ok(!s.endsWith('-'), s);
  // every kept token is whole — no "…authenticatio" mid-word cut
  for (const w of s.split('-')) assert.ok('implement comprehensive authentication subsystem overhaul'.includes(w), w);
  assert.equal(s, 'implement-comprehensive-authentication');
});

test('sanitizeBranch: ref-safe, lowercased, word-boundary clamped', () => {
  assert.equal(sanitizeBranch('Improve Branch Names!'), 'improve-branch-names');
  assert.equal(sanitizeBranch('fix/login_redirect'), 'fix-login-redirect');
  assert.equal(sanitizeBranch('   '), '');
});

test('worktreeGuardrailPrompt names the worktree + branch and forbids nesting', () => {
  const p = worktreeGuardrailPrompt({ path: '/vcs/myproj-worktree-fix', branch: 'fix' });
  assert.match(p, /\/vcs\/myproj-worktree-fix/);
  assert.match(p, /fix/);
  assert.match(p, /do not create another/i);
});

function tempRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-wt-'));
  const repo = path.join(root, 'myproj');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'README.md'), '# myproj\n');
  const git = (...a) => execFileSync('git', ['-C', repo, ...a], { stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init');
  return { root, repo: fs.realpathSync(repo) };
}

test('gitRepoRoot: returns the main repo root for a path inside it', async () => {
  const { repo } = tempRepo();
  assert.equal(await gitRepoRoot(path.join(repo, 'src')), repo);
});

test('gitRepoRoot: returns null for a non-git directory', async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aw-nogit-')));
  assert.equal(await gitRepoRoot(dir), null);
});

test('worktreeDirName: <repo>-worktree-<branch>', () => {
  assert.equal(worktreeDirName('/a/b/myproj', 'fix-auth'), 'myproj-worktree-fix-auth');
});

test('gitRepoRoot: returns the MAIN repo root when cwd is a linked worktree', async () => {
  const { root, repo } = tempRepo();
  const wt = path.join(root, 'myproj-worktree-feature');
  execFileSync('git', ['-C', repo, 'worktree', 'add', '-q', wt, '-b', 'feature'], { stdio: 'pipe' });
  assert.equal(await gitRepoRoot(wt), repo);
});

test('isLinkedWorktree: true inside a linked worktree, false in the main checkout', async () => {
  const { root, repo } = tempRepo();
  const wt = path.join(root, 'myproj-worktree-feature2');
  execFileSync('git', ['-C', repo, 'worktree', 'add', '-q', wt, '-b', 'feature2'], { stdio: 'pipe' });
  assert.equal(await isLinkedWorktree(wt), true);
  assert.equal(await isLinkedWorktree(repo), false);
});

test('createWorktree: creates a sibling worktree on a new branch', async () => {
  const { repo } = tempRepo();
  const res = await createWorktree({ cwd: repo, branch: 'fix-auth', auto: false });
  assert.equal(res.branch, 'fix-auth');
  assert.equal(path.basename(res.path), 'myproj-worktree-fix-auth');
  assert.equal(path.dirname(res.path), path.dirname(repo)); // sibling of repo
  assert.ok(fs.existsSync(path.join(res.path, 'README.md')));
  assert.equal(await branchExists(repo, 'fix-auth'), true);
});

// A bare branch ref (no worktree) sitting in the repo, for the existing-branch path.
function makeBranch(repo, name) {
  execFileSync('git', ['-C', repo, 'branch', name], { stdio: 'pipe' });
}

test('renameBranch: renames the worktree branch in place and keeps the dir', async () => {
  const { repo } = tempRepo();
  const wt = await createWorktree({ cwd: repo, branch: 'placeholder-slug', auto: false });
  const res = await renameBranch({ worktreePath: wt.path, repoRoot: wt.repoRoot, desired: 'Improve Branch Names!', currentBranch: 'placeholder-slug' });
  assert.equal(res.branch, 'improve-branch-names');
  assert.equal(await branchExists(repo, 'improve-branch-names'), true);
  assert.equal(await branchExists(repo, 'placeholder-slug'), false);
  // dir is NOT moved (the live shell sits in it) — its name still has the old branch
  assert.equal(path.basename(wt.path), 'myproj-worktree-placeholder-slug');
  assert.ok(fs.existsSync(wt.path));
  // HEAD now points at the renamed branch
  const head = execFileSync('git', ['-C', wt.path, 'rev-parse', '--abbrev-ref', 'HEAD'], { stdio: 'pipe' }).toString().trim();
  assert.equal(head, 'improve-branch-names');
});

test('renameBranch: auto-suffixes when the target name already exists', async () => {
  const { repo } = tempRepo();
  makeBranch(repo, 'taken');
  const wt = await createWorktree({ cwd: repo, branch: 'start-here', auto: false });
  const res = await renameBranch({ worktreePath: wt.path, repoRoot: wt.repoRoot, desired: 'taken', currentBranch: 'start-here' });
  assert.equal(res.branch, 'taken-2');
  assert.equal(await branchExists(repo, 'taken'), true);
  assert.equal(await branchExists(repo, 'taken-2'), true);
});

test('renameBranch: same name is a no-op (no rename, marked unchanged)', async () => {
  const { repo } = tempRepo();
  const wt = await createWorktree({ cwd: repo, branch: 'keep-me', auto: false });
  const res = await renameBranch({ worktreePath: wt.path, repoRoot: wt.repoRoot, desired: 'keep-me', currentBranch: 'keep-me' });
  assert.equal(res.branch, 'keep-me');
  assert.equal(res.unchanged, true);
});

test('renameBranch: rejects a name with no alphanumerics', async () => {
  const { repo } = tempRepo();
  const wt = await createWorktree({ cwd: repo, branch: 'real-branch', auto: false });
  await assert.rejects(
    () => renameBranch({ worktreePath: wt.path, repoRoot: wt.repoRoot, desired: '///', currentBranch: 'real-branch' }),
    WorktreeError,
  );
});

// Repo that has a submodule committed on main. Uses -c protocol.file.allow=always
// on the command line (local repo config is silently ignored by git for protocol
// security settings).
function tempRepoWithSubmodule() {
  const { root, repo } = tempRepo();
  const { repo: subrepo } = tempRepo();
  const git = (...a) => execFileSync('git', ['-C', repo, ...a], { stdio: 'pipe' });
  git('-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'protocol.file.allow=always', 'submodule', 'add', subrepo, 'sub');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'add submodule');
  return { root, repo: fs.realpathSync(repo), subrepo };
}

// Wrap a callback with GIT_CONFIG_GLOBAL pointing to a temp file that allows the
// file:// protocol. Tests within a single file run serially (Node test runner
// guarantee), so process.env mutation here is safe from other tests in this file.
// Needed because createWorktree's internal git exec inherits process.env; local
// repo config is not honoured by git for protocol security settings.
async function withGitFileProtocol(fn) {
  const gcfg = path.join(os.tmpdir(), `aw-test-gitconfig-${process.pid}.cfg`);
  fs.writeFileSync(gcfg, '[protocol "file"]\n\tallow = always\n');
  const saved = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = gcfg;
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = saved;
    try { fs.unlinkSync(gcfg); } catch { /* best-effort */ }
  }
}

test('classifyWorktreeTarget: new — branch and folder both absent', async () => {
  const { repo } = tempRepo();
  const folder = path.join(path.dirname(repo), 'myproj-worktree-fresh');
  assert.deepEqual(await classifyWorktreeTarget({ repoRoot: repo, folder, branch: 'fresh' }), { status: 'new' });
});

test('classifyWorktreeTarget: existing-branch — branch exists, folder absent, not checked out', async () => {
  const { repo } = tempRepo();
  makeBranch(repo, 'standalone');
  const folder = path.join(path.dirname(repo), 'myproj-worktree-standalone');
  assert.deepEqual(await classifyWorktreeTarget({ repoRoot: repo, folder, branch: 'standalone' }), { status: 'existing-branch' });
});

test('classifyWorktreeTarget: existing-branch — an empty folder counts as absent', async () => {
  const { repo } = tempRepo();
  makeBranch(repo, 'emptydir');
  const folder = path.join(path.dirname(repo), 'myproj-worktree-emptydir');
  fs.mkdirSync(folder);
  assert.deepEqual(await classifyWorktreeTarget({ repoRoot: repo, folder, branch: 'emptydir' }), { status: 'existing-branch' });
});

test('classifyWorktreeTarget: new — an empty folder with no branch is still new', async () => {
  const { repo } = tempRepo();
  const folder = path.join(path.dirname(repo), 'myproj-worktree-emptyfresh');
  fs.mkdirSync(folder);
  assert.deepEqual(await classifyWorktreeTarget({ repoRoot: repo, folder, branch: 'emptyfresh' }), { status: 'new' });
});

test('classifyWorktreeTarget: adopt — folder is a registered worktree on the target branch', async () => {
  const { repo } = tempRepo();
  const wt = await createWorktree({ cwd: repo, branch: 'adoptme', auto: false });
  const res = await classifyWorktreeTarget({ repoRoot: repo, folder: wt.path, branch: 'adoptme' });
  assert.equal(res.status, 'adopt');
  assert.equal(fs.realpathSync(res.conflictPath), fs.realpathSync(wt.path));
});

test('classifyWorktreeTarget: branch-in-use — branch checked out in a different worktree', async () => {
  const { repo } = tempRepo();
  const wt = await createWorktree({ cwd: repo, branch: 'busy', auto: false });
  const folder = path.join(path.dirname(repo), 'myproj-worktree-busy-elsewhere');
  const res = await classifyWorktreeTarget({ repoRoot: repo, folder, branch: 'busy' });
  assert.equal(res.status, 'branch-in-use');
  assert.equal(fs.realpathSync(res.conflictPath), fs.realpathSync(wt.path));
});

test('classifyWorktreeTarget: folder-blocked — folder non-empty and not an adoptable worktree', async () => {
  const { repo } = tempRepo();
  const folder = path.join(path.dirname(repo), 'myproj-worktree-junk');
  fs.mkdirSync(folder);
  fs.writeFileSync(path.join(folder, 'stuff.txt'), 'not a worktree\n');
  assert.deepEqual(await classifyWorktreeTarget({ repoRoot: repo, folder, branch: 'junk' }), { status: 'folder-blocked' });
});

test('classifyWorktreeTarget: folder-blocked — folder is a worktree on a different branch', async () => {
  const { repo } = tempRepo();
  const wt = await createWorktree({ cwd: repo, branch: 'otherbranch', auto: false });
  // Same folder, but we ask about a different (non-existent) branch name.
  const res = await classifyWorktreeTarget({ repoRoot: repo, folder: wt.path, branch: 'wanted' });
  assert.equal(res.status, 'folder-blocked');
});

test('createWorktree: checks out an existing branch into a new folder (no -b)', async () => {
  const { repo } = tempRepo();
  makeBranch(repo, 'existing');
  const res = await createWorktree({ cwd: repo, branch: 'existing', auto: false });
  assert.equal(res.branch, 'existing');
  assert.equal(path.basename(res.path), 'myproj-worktree-existing');
  assert.ok(fs.existsSync(path.join(res.path, 'README.md')));
  // HEAD of the worktree is on the existing branch.
  const head = execFileSync('git', ['-C', res.path, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim();
  assert.equal(head, 'existing');
});

test('createWorktree: adopts an existing worktree on the branch without running git', async () => {
  const { repo } = tempRepo();
  const wt = await createWorktree({ cwd: repo, branch: 'adopted', auto: false });
  // A dirty working tree must not block adoption.
  fs.writeFileSync(path.join(wt.path, 'README.md'), '# locally edited\n');
  const res = await createWorktree({ cwd: repo, branch: 'adopted', auto: false });
  assert.deepEqual(res, { path: wt.path, branch: 'adopted', repoRoot: repo });
  assert.equal(fs.readFileSync(path.join(wt.path, 'README.md'), 'utf8'), '# locally edited\n');
});

test('createWorktree: refuses a branch already checked out elsewhere', async () => {
  const { repo } = tempRepo();
  await createWorktree({ cwd: repo, branch: 'taken', auto: false });
  await assert.rejects(
    () => createWorktree({ cwd: repo, branch: 'taken', folderName: 'myproj-worktree-taken-2', auto: false }),
    (e) => e instanceof WorktreeError && /already checked out/i.test(e.message),
  );
});

test('createWorktree: refuses a non-empty, non-worktree folder', async () => {
  const { repo } = tempRepo();
  const folder = path.join(path.dirname(repo), 'myproj-worktree-occupied');
  fs.mkdirSync(folder);
  fs.writeFileSync(path.join(folder, 'stuff.txt'), 'occupied\n');
  await assert.rejects(
    () => createWorktree({ cwd: repo, branch: 'occupied', folderName: folder, auto: false }),
    WorktreeError,
  );
});

test('createWorktree: auto-suffixes the default on collision', async () => {
  const { repo } = tempRepo();
  await createWorktree({ cwd: repo, branch: 'dup', auto: false });
  const res = await createWorktree({ cwd: repo, branch: 'dup', auto: true });
  assert.equal(res.branch, 'dup-2');
  assert.equal(path.basename(res.path), 'myproj-worktree-dup-2');
});

test('createWorktree: honors an absolute folderName (place the worktree anywhere)', async () => {
  const { repo } = tempRepo();
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aw-dest-')));
  const dest = path.join(outside, 'my-custom-wt');
  const res = await createWorktree({ cwd: repo, branch: 'feat', folderName: dest, auto: false });
  assert.equal(res.path, dest);
  assert.ok(fs.existsSync(path.join(dest, 'README.md')));
});

test('createWorktree: refuses on a non-git cwd', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-nogit-'));
  await assert.rejects(() => createWorktree({ cwd: dir, branch: 'x', auto: false }), WorktreeError);
});

test('createWorktree: auto-suffixes even when a default folderName is supplied (no hang)', async () => {
  const { repo } = tempRepo();
  // First creation occupies the default branch+folder.
  await createWorktree({ cwd: repo, branch: 'dup', folderName: 'myproj-worktree-dup', auto: false });
  // Auto retry with the same default folderName must bump, not hang.
  const res = await createWorktree({ cwd: repo, branch: 'dup', folderName: 'myproj-worktree-dup', auto: true });
  assert.equal(res.branch, 'dup-2');
  assert.equal(path.basename(res.path), 'myproj-worktree-dup-2');
});

test('createWorktree: returns the main repo root for later cleanup', async () => {
  const { repo } = tempRepo();
  const res = await createWorktree({ cwd: repo, branch: 'with-root', auto: false });
  assert.equal(res.repoRoot, repo);
});

test('createWorktree: initializes submodules in the new worktree (new branch)', async () => {
  const { repo } = tempRepoWithSubmodule();
  await withGitFileProtocol(async () => {
    const res = await createWorktree({ cwd: repo, branch: 'with-subs', auto: false });
    assert.ok(fs.existsSync(path.join(res.path, 'sub', 'README.md')));
  });
});

test('createWorktree: initializes submodules when checking out an existing branch', async () => {
  const { repo } = tempRepoWithSubmodule();
  makeBranch(repo, 'existing-with-subs');
  await withGitFileProtocol(async () => {
    const res = await createWorktree({ cwd: repo, branch: 'existing-with-subs', auto: false });
    assert.ok(fs.existsSync(path.join(res.path, 'sub', 'README.md')));
  });
});

test('removeWorktree: removes a clean worktree directory', async () => {
  const { repo } = tempRepo();
  const wt = await createWorktree({ cwd: repo, branch: 'rm-clean', auto: false });
  const res = await removeWorktree({ worktreePath: wt.path, repoRoot: repo });
  assert.deepEqual(res, { ok: true });
  assert.equal(fs.existsSync(wt.path), false);
});

test('removeWorktree: blocks a dirty worktree without force, succeeds with force', async () => {
  const { repo } = tempRepo();
  const wt = await createWorktree({ cwd: repo, branch: 'rm-dirty', auto: false });
  fs.writeFileSync(path.join(wt.path, 'README.md'), '# dirty\n'); // modify a tracked file
  const blocked = await removeWorktree({ worktreePath: wt.path, repoRoot: repo });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.blocked, true);
  assert.ok(blocked.reason);
  assert.equal(fs.existsSync(wt.path), true); // not removed
  const forced = await removeWorktree({ worktreePath: wt.path, repoRoot: repo, force: true });
  assert.deepEqual(forced, { ok: true });
  assert.equal(fs.existsSync(wt.path), false);
});

test('removeWorktree: an already-removed dir is a no-op success', async () => {
  const { repo } = tempRepo();
  const gone = path.join(path.dirname(repo), 'myproj-worktree-never');
  assert.deepEqual(await removeWorktree({ worktreePath: gone, repoRoot: repo }), { ok: true, alreadyGone: true });
});

test('removeWorktree: blocks a worktree containing a submodule, succeeds with force', async () => {
  const { root, repo } = tempRepo();
  const { repo: subrepo } = tempRepo();
  const wt = await createWorktree({ cwd: repo, branch: 'rm-submodule', auto: false });
  // Add the second repo as a submodule inside the worktree
  const git = (...a) => execFileSync('git', ['-C', wt.path, ...a], { stdio: 'pipe', env: { ...process.env, HOME: root } });
  git('-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'protocol.file.allow=always', 'submodule', 'add', subrepo, 'sub');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'add submodule');
  const blocked = await removeWorktree({ worktreePath: wt.path, repoRoot: repo });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.blocked, true);
  assert.ok(blocked.reason);
  assert.equal(fs.existsSync(wt.path), true);
  const forced = await removeWorktree({ worktreePath: wt.path, repoRoot: repo, force: true });
  assert.deepEqual(forced, { ok: true });
  assert.equal(fs.existsSync(wt.path), false);
});

test('deleteBranch: deletes a merged branch with -d', async () => {
  const { repo } = tempRepo();
  const wt = await createWorktree({ cwd: repo, branch: 'merged', auto: false });
  await removeWorktree({ worktreePath: wt.path, repoRoot: repo }); // free the branch (no commits → merged)
  assert.deepEqual(await deleteBranch({ repoRoot: repo, branch: 'merged' }), { ok: true });
  assert.equal(await branchExists(repo, 'merged'), false);
});

test('deleteBranch: blocks an unmerged branch without force, succeeds with force', async () => {
  const { repo } = tempRepo();
  const wt = await createWorktree({ cwd: repo, branch: 'unmerged', auto: false });
  const git = (...a) => execFileSync('git', ['-C', wt.path, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { stdio: 'pipe' });
  fs.writeFileSync(path.join(wt.path, 'new.txt'), 'work\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'unmerged work');
  await removeWorktree({ worktreePath: wt.path, repoRoot: repo });
  const blocked = await deleteBranch({ repoRoot: repo, branch: 'unmerged' });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.blocked, true);
  assert.ok(/not fully merged/i.test(blocked.reason));
  assert.equal(await branchExists(repo, 'unmerged'), true);
  assert.deepEqual(await deleteBranch({ repoRoot: repo, branch: 'unmerged', force: true }), { ok: true });
  assert.equal(await branchExists(repo, 'unmerged'), false);
});

test('deleteBranch: a non-existent branch is a no-op success', async () => {
  const { repo } = tempRepo();
  assert.deepEqual(await deleteBranch({ repoRoot: repo, branch: 'no-such' }), { ok: true, alreadyGone: true });
});

test('repoRootForWorktree: prefers the stored root, else derives from the dir name', async () => {
  const { repo } = tempRepo();
  assert.equal(await repoRootForWorktree({ path: '/x/myproj-worktree-feat', branch: 'feat', repoRoot: '/stored' }), '/stored');
  // No stored root, dir gone → strip the -worktree-<branch> suffix.
  assert.equal(await repoRootForWorktree({ path: '/x/myproj-worktree-feat', branch: 'feat' }), '/x/myproj');
});

test('worktreeStatus: reports dir + branch existence; null for non-worktree', async () => {
  const { repo } = tempRepo();
  const wt = await createWorktree({ cwd: repo, branch: 'status', auto: false });
  const live = await worktreeStatus({ path: wt.path, branch: 'status', repoRoot: repo });
  assert.deepEqual(live, { path: wt.path, branch: 'status', dirExists: true, branchExists: true });
  await removeWorktree({ worktreePath: wt.path, repoRoot: repo });
  const removed = await worktreeStatus({ path: wt.path, branch: 'status', repoRoot: repo });
  assert.deepEqual(removed, { path: wt.path, branch: 'status', dirExists: false, branchExists: true });
  assert.equal(await worktreeStatus(null), null);
});
