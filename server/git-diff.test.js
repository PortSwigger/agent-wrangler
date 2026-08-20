import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { workingTreeDiff, branchDiff, pullRequestDiff, parseDiff, EXEC_OPTS } from './git-diff.js';

// A temp git repo with one committed file. Returns the realpath'd repo dir plus a
// bound `git` runner (isolated identity, quiet). Mirrors worktree.test.js.
function tempRepo({ commit = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-diff-'));
  const repo = path.join(root, 'proj');
  fs.mkdirSync(repo, { recursive: true });
  const git = (...a) => execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  if (commit) {
    fs.writeFileSync(path.join(repo, 'tracked.txt'), 'one\ntwo\nthree\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'init');
  }
  return { repo: fs.realpathSync(repo), git };
}

// A repo with a bare "origin" remote, set up via init+remote-add+fetch — the
// wrangler worktree pattern, which deliberately does NOT create
// refs/remotes/origin/HEAD (that's only ever written by `git clone`). Pushes the
// initial commit as origin/main, then lets the caller add local-only commits/edits
// on top without pushing, mirroring an unpushed autopilot branch.
function tempRepoWithRemote() {
  const { repo, git } = tempRepo();
  const bareRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-diff-remote-'));
  const bare = path.join(bareRoot, 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare], { stdio: 'pipe' });
  git('remote', 'add', 'origin', bare);
  git('push', '-q', 'origin', 'main');
  return { repo, git, bare };
}

test('workingTreeDiff: not-a-repo for a plain temp dir', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-norepo-'));
  assert.deepEqual(await workingTreeDiff(dir), { state: 'not-a-repo' });
});

test('workingTreeDiff: empty when the tree is clean', async () => {
  const { repo } = tempRepo();
  assert.deepEqual(await workingTreeDiff(repo), { state: 'empty' });
});

test('workingTreeDiff: tracked modification produces hunks with correct line numbers', async () => {
  const { repo } = tempRepo();
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'one\nTWO\nthree\nfour\n');
  const res = await workingTreeDiff(repo);
  assert.equal(res.state, 'ok');
  const f = res.files.find((x) => x.path === 'tracked.txt');
  assert.ok(f, 'tracked.txt present');
  assert.equal(f.status, 'modified');
  assert.equal(f.binary, false);
  assert.ok(f.hunks.length >= 1);
  const lines = f.hunks.flatMap((h) => h.lines);
  const del = lines.find((l) => l.type === 'del' && l.text === 'two');
  assert.ok(del, 'the removed "two" line');
  assert.equal(del.oldLine, 2);
  assert.equal(del.newLine, null);
  const add = lines.find((l) => l.type === 'add' && l.text === 'TWO');
  assert.ok(add);
  assert.equal(add.newLine, 2);
  assert.equal(add.oldLine, null);
  const ctx = lines.find((l) => l.type === 'context' && l.text === 'one');
  assert.equal(ctx.oldLine, 1);
  assert.equal(ctx.newLine, 1);
});

test('workingTreeDiff: untracked file appears with status untracked', async () => {
  const { repo } = tempRepo();
  fs.writeFileSync(path.join(repo, 'new.txt'), 'alpha\nbeta\n');
  const res = await workingTreeDiff(repo);
  assert.equal(res.state, 'ok');
  const f = res.files.find((x) => x.path === 'new.txt');
  assert.ok(f, 'untracked file present');
  assert.equal(f.status, 'untracked');
  assert.equal(f.binary, false);
  const adds = f.hunks.flatMap((h) => h.lines).filter((l) => l.type === 'add').map((l) => l.text);
  assert.deepEqual(adds, ['alpha', 'beta']);
});

test('workingTreeDiff: untracked path with a literal backslash-t is not mis-decoded', async () => {
  // Regression for a double-unescape: git C-quotes this name to "a\\tb" in plain
  // porcelain; decoding `\\`→`\` then `\t`→TAB in two passes turned it into
  // "a<TAB>b". The `-z` porcelain we now parse is verbatim, so the path must be
  // the exact 4 chars a,\,t,b — never a real tab.
  const { repo } = tempRepo();
  const name = 'a\\tb'; // a, backslash, t, b
  fs.writeFileSync(path.join(repo, name), 'body\n');
  const res = await workingTreeDiff(repo);
  assert.equal(res.state, 'ok');
  const f = res.files.find((x) => x.status === 'untracked');
  assert.ok(f, 'untracked file present');
  assert.equal(f.path, name);
  assert.ok(!f.path.includes('\t'), 'no tab was synthesised');
});

test('workingTreeDiff: untracked path with a space and unicode round-trips verbatim', async () => {
  const { repo } = tempRepo();
  const name = 'my “weird” file.txt'; // spaces + non-ASCII quotes (git quotes these in plain porcelain)
  fs.writeFileSync(path.join(repo, name), 'alpha\nbeta\n');
  const res = await workingTreeDiff(repo);
  assert.equal(res.state, 'ok');
  const f = res.files.find((x) => x.path === name);
  assert.ok(f, 'untracked file with special name present with its exact path');
  assert.equal(f.status, 'untracked');
  const adds = f.hunks.flatMap((h) => h.lines).filter((l) => l.type === 'add').map((l) => l.text);
  assert.deepEqual(adds, ['alpha', 'beta']);
});

test('workingTreeDiff: an untracked binary is flagged binary with no lines', async () => {
  const { repo } = tempRepo();
  fs.writeFileSync(path.join(repo, 'blob.bin'), Buffer.from([0, 1, 2, 0, 255, 254, 0, 10]));
  const res = await workingTreeDiff(repo);
  assert.equal(res.state, 'ok');
  const f = res.files.find((x) => x.path === 'blob.bin');
  assert.ok(f, 'binary file present');
  assert.equal(f.status, 'untracked');
  assert.equal(f.binary, true);
  assert.equal(f.hunks.length, 0);
});

test('workingTreeDiff: empty repo (no HEAD) shows staged content as additions', async () => {
  const { repo, git } = tempRepo({ commit: false });
  fs.writeFileSync(path.join(repo, 'first.txt'), 'hello\nworld\n');
  git('add', '-A'); // staged, but there is no commit → no HEAD
  const res = await workingTreeDiff(repo);
  assert.equal(res.state, 'ok');
  const f = res.files.find((x) => x.path === 'first.txt');
  assert.ok(f, 'staged file present against the empty tree');
  assert.equal(f.status, 'added');
  const adds = f.hunks.flatMap((h) => h.lines).filter((l) => l.type === 'add').map((l) => l.text);
  assert.deepEqual(adds, ['hello', 'world']);
});

test('workingTreeDiff: soft line cap drops overflow and reports the count', async () => {
  const { repo } = tempRepo();
  fs.writeFileSync(path.join(repo, 'big.txt'), Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n') + '\n');
  const res = await workingTreeDiff(repo, { lineCap: 5 });
  assert.equal(res.state, 'ok');
  const total = res.files.flatMap((f) => f.hunks).flatMap((h) => h.lines).length;
  assert.equal(total, 5);
  assert.ok(res.truncated.droppedLines > 0);
});

test('workingTreeDiff: no truncation reports droppedLines 0', async () => {
  const { repo } = tempRepo();
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'one\ntwo\nthree\nfour\n');
  const res = await workingTreeDiff(repo);
  assert.equal(res.truncated.droppedLines, 0);
});

test('workingTreeDiff: untracked fan-out is capped by the line budget — most files are skipped, not processed', async () => {
  const { repo } = tempRepo();
  // Seed many untracked single-line files. With a tiny cap the walk must stop after
  // the budget is spent, leaving the vast majority unprocessed (so we never spawn a
  // `git diff --no-index` for them) and reported as droppedFiles.
  const N = 40;
  for (let i = 0; i < N; i += 1) fs.writeFileSync(path.join(repo, `u${String(i).padStart(3, '0')}.txt`), `body ${i}\n`);
  const res = await workingTreeDiff(repo, { lineCap: 3 });
  assert.equal(res.state, 'ok');
  // The budget stops output growth: never more than `cap` content lines are shown.
  const total = res.files.flatMap((f) => f.hunks).flatMap((h) => h.lines).length;
  assert.ok(total <= 3, `content lines (${total}) stay within the cap`);
  // The key assertion: not all untracked files were processed — far fewer files
  // appear than were created, and the skipped count makes up the difference.
  assert.ok(res.files.length < N, `only ${res.files.length}/${N} files processed`);
  assert.ok(res.truncated.droppedFiles > 0, 'skipped files are surfaced');
  assert.equal(res.files.length + res.truncated.droppedFiles, N, 'processed + skipped accounts for every untracked file');
});

test('workingTreeDiff: droppedFiles is 0 when the whole tree fits the budget', async () => {
  const { repo } = tempRepo();
  fs.writeFileSync(path.join(repo, 'a.txt'), 'x\n');
  fs.writeFileSync(path.join(repo, 'b.txt'), 'y\n');
  const res = await workingTreeDiff(repo);
  assert.equal(res.state, 'ok');
  assert.equal(res.truncated.droppedFiles, 0);
});

test('git-diff EXEC_OPTS: a positive timeout guards every git call against a hang', () => {
  assert.equal(typeof EXEC_OPTS.timeout, 'number');
  assert.ok(EXEC_OPTS.timeout > 0, 'timeout is a positive millisecond ceiling');
});

test('git-diff EXEC_OPTS: GIT_OPTIONAL_LOCKS=0 makes every git call read-only (no index.lock)', () => {
  // A: all git invocations share EXEC_OPTS, so this one env flag disables the stat-
  // cache rewrite + index.lock across git status/diff/rev-parse/--no-index alike.
  assert.equal(EXEC_OPTS.env.GIT_OPTIONAL_LOCKS, '0');
  assert.equal(EXEC_OPTS.env.PATH, process.env.PATH, 'inherits the ambient env otherwise');
});

test('workingTreeDiff: a large tracked diff is bounded during parse with a correct droppedLines', async () => {
  // C: commit a 200-line file, then rewrite every line → the tracked diff has ~400
  // content lines (200 del + 200 add). With a tiny cap the output must be bounded and
  // droppedLines must account for the rest — the parser stops building objects early.
  const { repo, git } = tempRepo({ commit: false });
  fs.writeFileSync(path.join(repo, 'big.txt'), Array.from({ length: 200 }, (_, i) => `orig ${i}`).join('\n') + '\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'seed');
  fs.writeFileSync(path.join(repo, 'big.txt'), Array.from({ length: 200 }, (_, i) => `changed ${i}`).join('\n') + '\n');
  const res = await workingTreeDiff(repo, { lineCap: 10 });
  assert.equal(res.state, 'ok');
  const total = res.files.flatMap((f) => f.hunks).flatMap((h) => h.lines).length;
  assert.equal(total, 10, 'output bounded to the cap');
  assert.ok(res.truncated.droppedLines > 0, 'the discarded lines are counted');
  assert.equal(total + res.truncated.droppedLines, 400, 'kept + dropped accounts for the whole tracked diff');
});

test('workingTreeDiff: a pathological long line is truncated with a marker', async () => {
  // D: a single multi-KB changed line would otherwise ship whole into one DOM node.
  const { repo } = tempRepo();
  const long = 'x'.repeat(5000);
  fs.writeFileSync(path.join(repo, 'huge.txt'), long + '\n');
  const res = await workingTreeDiff(repo);
  assert.equal(res.state, 'ok');
  const f = res.files.find((x) => x.path === 'huge.txt');
  const add = f.hunks.flatMap((h) => h.lines).find((l) => l.type === 'add');
  assert.ok(add.text.length < long.length, 'the stored line is truncated');
  assert.match(add.text, /line truncated\)$/, 'and carries the truncation marker');
  assert.ok(add.text.startsWith('xxxx'), 'the kept prefix is the real content');
});

test('workingTreeDiff: AW_DIFF_LINE_CAP=0 is honored (no lines), a normal value still caps', async () => {
  // E: `Number(x) || DEFAULT` used to treat an explicit 0 as falsy → default.
  const { repo } = tempRepo();
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'one\nTWO\nthree\nfour\n');
  const prev = process.env.AW_DIFF_LINE_CAP;
  try {
    process.env.AW_DIFF_LINE_CAP = '0';
    const zero = await workingTreeDiff(repo);
    assert.equal(zero.state, 'ok');
    const zeroTotal = zero.files.flatMap((f) => f.hunks).flatMap((h) => h.lines).length;
    assert.equal(zeroTotal, 0, 'an explicit 0 yields no content lines');
    assert.ok(zero.truncated.droppedLines > 0, 'and the dropped lines are counted');

    process.env.AW_DIFF_LINE_CAP = '2';
    const two = await workingTreeDiff(repo);
    const twoTotal = two.files.flatMap((f) => f.hunks).flatMap((h) => h.lines).length;
    assert.equal(twoTotal, 2, 'a normal value caps as before');
  } finally {
    if (prev === undefined) delete process.env.AW_DIFF_LINE_CAP;
    else process.env.AW_DIFF_LINE_CAP = prev;
  }
});

test('branchDiff: not-a-repo for a plain temp dir', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-norepo-'));
  assert.deepEqual(await branchDiff(dir), { state: 'not-a-repo' });
});

test('branchDiff: no-remote (reason: no-head) when there is no commit yet, even with a remote configured', async () => {
  const { repo } = tempRepo({ commit: false });
  const bareRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-diff-remote-'));
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', path.join(bareRoot, 'origin.git')], { stdio: 'pipe' });
  execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', path.join(bareRoot, 'origin.git')], { stdio: 'pipe' });
  assert.deepEqual(await branchDiff(repo), { state: 'no-remote', reason: 'no-head' });
});

test('branchDiff: no-remote (reason: no-ref) when the repo has no remote configured', async () => {
  const { repo } = tempRepo();
  assert.deepEqual(await branchDiff(repo), { state: 'no-remote', reason: 'no-ref' });
});

test('branchDiff: falls back to origin/main (no origin/HEAD, no upstream) and shows committed + uncommitted together', async () => {
  const { repo, git } = tempRepoWithRemote();
  // Committed on the branch, never pushed.
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'one\nTWO\nthree\n');
  git('commit', '-aq', '-m', 'change two');
  // Plus an uncommitted edit on top.
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'one\nTWO\nTHREE\n');
  const res = await branchDiff(repo);
  assert.equal(res.state, 'ok');
  assert.equal(res.baseRef, 'origin/main');
  const f = res.files.find((x) => x.path === 'tracked.txt');
  const adds = f.hunks.flatMap((h) => h.lines).filter((l) => l.type === 'add').map((l) => l.text);
  assert.deepEqual(adds, ['TWO', 'THREE'], 'both the committed and uncommitted line changes show up');
});

test('branchDiff: working-tree diff omits the committed change branchDiff includes', async () => {
  const { repo, git } = tempRepoWithRemote();
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'one\nTWO\nthree\n');
  git('commit', '-aq', '-m', 'change two');
  const wt = await workingTreeDiff(repo);
  assert.equal(wt.state, 'empty', 'nothing uncommitted, so the working-tree view is clean');
  const branch = await branchDiff(repo);
  assert.equal(branch.state, 'ok', 'the committed-but-unpushed change still shows vs origin');
});

test('branchDiff: resolves via origin/HEAD symbolic ref (the git-clone path, step 3 of resolveBranchBase)', async () => {
  // Unlike tempRepoWithRemote (init+remote-add+fetch), an actual `git clone` DOES
  // set refs/remotes/origin/HEAD — this is the one fallback step the other fixtures
  // never exercise. The default branch is named "trunk" (neither "main" nor
  // "master"), so the step-4 hardcoded probes can't produce the same answer by
  // coincidence — only resolving refs/remotes/origin/HEAD gets this right. A fresh
  // branch off the clone has no upstream and no matching origin/<name>, isolating
  // step 3 from steps 1/2 too.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-diff-trunk-'));
  const bare = path.join(root, 'origin.git');
  const seed = path.join(root, 'seed');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'trunk', bare], { stdio: 'pipe' });
  fs.mkdirSync(seed, { recursive: true });
  const gitSeed = (...a) => execFileSync('git', ['-C', seed, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { stdio: 'pipe' });
  gitSeed('init', '-q', '-b', 'trunk');
  fs.writeFileSync(path.join(seed, 'tracked.txt'), 'one\ntwo\nthree\n');
  gitSeed('add', '-A');
  gitSeed('commit', '-q', '-m', 'init');
  gitSeed('remote', 'add', 'origin', bare);
  gitSeed('push', '-q', 'origin', 'trunk');

  const clone = path.join(root, 'clone');
  execFileSync('git', ['clone', '-q', bare, clone], { stdio: 'pipe' });
  const gitClone = (...a) => execFileSync('git', ['-C', clone, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { stdio: 'pipe' });
  gitClone('checkout', '-qb', 'feature'); // no upstream, no origin/feature
  fs.writeFileSync(path.join(clone, 'tracked.txt'), 'one\nTWO\nthree\n');
  gitClone('commit', '-aq', '-m', 'change two');
  const res = await branchDiff(fs.realpathSync(clone));
  assert.equal(res.state, 'ok');
  assert.equal(res.baseRef, 'origin/trunk', 'resolved via origin/HEAD — the step-4 main/master probes could not have produced "trunk"');
});

test('branchDiff: prefers the configured upstream over origin/<branch-name>', async () => {
  const { repo, git } = tempRepoWithRemote();
  git('checkout', '-qb', 'feature');
  git('push', '-q', '-u', 'origin', 'feature');
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'one\nTWO\nthree\n');
  git('commit', '-aq', '-m', 'change two');
  const res = await branchDiff(repo);
  assert.equal(res.state, 'ok');
  assert.equal(res.baseRef, 'origin/feature');
});

test('branchDiff: a remote-only commit is NOT shown as reverted (merge-base, not the tip)', async () => {
  const { repo, git, bare } = tempRepoWithRemote();
  // Advance origin/main independently of this branch (simulates main moving on
  // while this branch works, without ever fetching/rebasing).
  const otherRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-diff-other-'));
  const other = path.join(otherRoot, 'other');
  execFileSync('git', ['clone', '-q', bare, other], { stdio: 'pipe' });
  const gitOther = (...a) => execFileSync('git', ['-C', other, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { stdio: 'pipe' });
  fs.writeFileSync(path.join(other, 'remote-only.txt'), 'from origin\n');
  gitOther('add', '-A');
  gitOther('commit', '-q', '-m', 'origin-only change');
  gitOther('push', '-q', 'origin', 'main');

  // Local branch makes its own unrelated change, still based on the old origin/main.
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'one\nTWO\nthree\n');
  git('commit', '-aq', '-m', 'local change');

  const res = await branchDiff(repo);
  assert.equal(res.state, 'ok');
  const paths = res.files.map((f) => f.path);
  assert.ok(!paths.includes('remote-only.txt'), "origin's own later commit doesn't appear as a local change");
  assert.ok(paths.includes('tracked.txt'), 'this branch\'s own change does appear');
});

test('pullRequestDiff: parses aggregate gh pr diff output', async () => {
  const calls = [];
  const raw = [
    'diff --git a/src/a.js b/src/a.js',
    'index 1111111..2222222 100644',
    '--- a/src/a.js',
    '+++ b/src/a.js',
    '@@ -1,2 +1,2 @@',
    ' one',
    '-two',
    '+TWO',
    '',
  ].join('\n');
  const run = async (url) => {
    calls.push(url);
    return { stdout: raw };
  };

  const res = await pullRequestDiff('https://github.com/acme/widgets/pull/42', { run });

  assert.deepEqual(calls, ['https://github.com/acme/widgets/pull/42']);
  assert.equal(res.state, 'ok');
  assert.equal(res.truncated.droppedLines, 0);
  const f = res.files[0];
  assert.equal(f.path, 'src/a.js');
  assert.equal(f.status, 'modified');
  assert.deepEqual(f.hunks[0].lines.map((l) => [l.type, l.text]), [['context', 'one'], ['del', 'two'], ['add', 'TWO']]);
});

test('pullRequestDiff: applies the shared line cap to PR diffs', async () => {
  const raw = [
    'diff --git a/big.txt b/big.txt',
    '--- a/big.txt',
    '+++ b/big.txt',
    '@@ -1,4 +1,4 @@',
    '-a',
    '-b',
    '+A',
    '+B',
    '',
  ].join('\n');
  const res = await pullRequestDiff('https://github.com/acme/widgets/pull/42', {
    lineCap: 2,
    run: async () => ({ stdout: raw }),
  });

  assert.equal(res.state, 'ok');
  assert.equal(res.files.flatMap((f) => f.hunks).flatMap((h) => h.lines).length, 2);
  assert.equal(res.truncated.droppedLines, 2);
});

test('pullRequestDiff: empty gh diff output returns empty', async () => {
  const res = await pullRequestDiff('https://github.com/acme/widgets/pull/42', {
    run: async () => ({ stdout: '' }),
  });

  assert.deepEqual(res, { state: 'empty' });
});

test('pullRequestDiff: gh failure returns an error state', async () => {
  const res = await pullRequestDiff('https://github.com/acme/widgets/pull/42', {
    run: async () => { throw new Error('not found'); },
  });

  assert.equal(res.state, 'error');
  assert.match(res.error, /not found/);
});

test('pullRequestDiff: gh failure prefers stderr when available', async () => {
  const err = new Error('Command failed');
  err.stderr = 'GraphQL: resource not found';
  const res = await pullRequestDiff('https://github.com/acme/widgets/pull/42', {
    run: async () => { throw err; },
  });

  assert.equal(res.state, 'error');
  assert.match(res.error, /GraphQL: resource not found/);
});

test('parseDiff: captures a rename oldPath', () => {
  const raw = [
    'diff --git a/old.js b/new.js',
    'similarity index 100%',
    'rename from old.js',
    'rename to new.js',
    '',
  ].join('\n');
  const [f] = parseDiff(raw);
  assert.equal(f.status, 'renamed');
  assert.equal(f.path, 'new.js');
  assert.equal(f.oldPath, 'old.js');
});
