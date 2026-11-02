import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ensureClaudeTrust, mirrorWorktreeTrust, ensureLoginClaudeTrust } from './claude-trust.js';

function withTemp(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-trust-test-'));
  try {
    return fn(path.join(dir, '.claude.json'), dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const quiet = () => {};

test('ensureClaudeTrust: creates the file with a trusted entry when none exists', () => {
  withTemp((file) => {
    assert.equal(ensureClaudeTrust('/s', { file, log: quiet }), true);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { projects: { '/s': { hasTrustDialogAccepted: true } } });
  });
});

test('ensureClaudeTrust: keeps other keys, other projects, indent, trailing newline and mode', () => {
  withTemp((file) => {
    const orig = { numStartups: 3, projects: { '/a': { hasTrustDialogAccepted: false, allowedTools: ['x'] } }, theme: 'dark' };
    fs.writeFileSync(file, JSON.stringify(orig, null, 2) + '\n', { mode: 0o600 });
    fs.chmodSync(file, 0o600);
    ensureClaudeTrust('/s', { file, log: quiet });
    const text = fs.readFileSync(file, 'utf8');
    assert.deepEqual(JSON.parse(text), { ...orig, projects: { ...orig.projects, '/s': { hasTrustDialogAccepted: true } } });
    assert.ok(text.endsWith('}\n'));
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ['.claude.json'], 'no temp file left behind');
  });
});

test('ensureClaudeTrust: flips an existing false entry without dropping its other fields', () => {
  withTemp((file) => {
    fs.writeFileSync(file, JSON.stringify({ projects: { '/s': { hasTrustDialogAccepted: false, allowedTools: ['x'] } } }));
    ensureClaudeTrust('/s', { file, log: quiet });
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).projects['/s'], { hasTrustDialogAccepted: true, allowedTools: ['x'] });
  });
});

test('ensureClaudeTrust: an already-trusted file is left byte-identical (no write)', () => {
  withTemp((file) => {
    const text = '{"projects":{"/s":{"hasTrustDialogAccepted":true}},   "odd":   1}';
    fs.writeFileSync(file, text);
    const past = new Date(2020, 0, 1);
    fs.utimesSync(file, past, past);
    assert.equal(ensureClaudeTrust('/s', { file, log: quiet }), true);
    assert.equal(fs.readFileSync(file, 'utf8'), text);
    assert.equal(fs.statSync(file).mtimeMs, past.getTime());
  });
});

test('ensureClaudeTrust: malformed JSON is skipped with a log and the file is untouched', () => {
  withTemp((file) => {
    const text = '{"projects": {"/a": ';
    fs.writeFileSync(file, text);
    const logs = [];
    assert.equal(ensureClaudeTrust('/s', { file, log: (m) => logs.push(m) }), false);
    assert.equal(fs.readFileSync(file, 'utf8'), text);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /\[claude-trust\] skipped trusting \/s/);
  });
});

test('ensureClaudeTrust: a non-object root or projects is skipped, not clobbered', () => {
  withTemp((file) => {
    for (const text of ['[]', 'null', '{"projects":[]}', '{"projects":"x"}']) {
      fs.writeFileSync(file, text);
      assert.equal(ensureClaudeTrust('/s', { file, log: quiet }), false);
      assert.equal(fs.readFileSync(file, 'utf8'), text);
    }
  });
});

test('ensureClaudeTrust: no-ops on a missing dirPath', () => {
  withTemp((file) => {
    assert.equal(ensureClaudeTrust('', { file, log: quiet }), false);
    assert.equal(fs.existsSync(file), false);
  });
});

// <root>/code/proj (a repo) with a worktree in each layout worktree.js makes:
// <root>/code/worktrees.noindex/proj-feat and the legacy <root>/code/proj-worktree-old.
// Realpathed, since git (and Claude) report /private/var, not /var, on macOS.
async function withRepo(fn) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'claude-trust-wt-')));
  const code = path.join(root, 'code');
  const repo = path.join(code, 'proj');
  fs.mkdirSync(repo, { recursive: true });
  const git = (...a) => execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'f.txt'), 'x');
  git('add', '-A');
  git('commit', '-q', '-m', 'i');
  const worktree = path.join(code, 'worktrees.noindex', 'proj-feat');
  const legacy = path.join(code, 'proj-worktree-old');
  git('worktree', 'add', '-q', '-b', 'feat', worktree);
  git('worktree', 'add', '-q', '-b', 'old', legacy);
  try {
    return await fn({ root, code, repo, worktree, legacy, file: path.join(root, '.claude.json') });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const trusting = (...dirs) => JSON.stringify({ projects: Object.fromEntries(dirs.map((d) => [d, { hasTrustDialogAccepted: true }])) }, null, 2) + '\n';
const trustedKeys = (file) => Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')).projects)
  .filter((k) => JSON.parse(fs.readFileSync(file, 'utf8')).projects[k].hasTrustDialogAccepted === true).sort();

test('mirrorWorktreeTrust: a worktree of a trusted repo is trusted, in both layouts, and nothing else is', async () => {
  await withRepo(async ({ repo, worktree, legacy, file }) => {
    fs.writeFileSync(file, trusting(repo));
    assert.equal(await mirrorWorktreeTrust(worktree, { file, log: quiet }), true);
    assert.equal(await mirrorWorktreeTrust(legacy, { file, log: quiet }), true);
    assert.deepEqual(trustedKeys(file), [legacy, repo, worktree].sort()); // no parent folder
  });
});

test('mirrorWorktreeTrust: a subdirectory cwd trusts the worktree root', async () => {
  await withRepo(async ({ repo, worktree, file }) => {
    fs.writeFileSync(file, trusting(repo));
    const sub = path.join(worktree, 'deep');
    fs.mkdirSync(sub);
    assert.equal(await mirrorWorktreeTrust(sub, { file, log: quiet }), true);
    assert.deepEqual(trustedKeys(file), [repo, worktree].sort());
  });
});

test('mirrorWorktreeTrust: trust on an ancestor of the repo covers its worktree', async () => {
  await withRepo(async ({ root, worktree, file }) => {
    fs.writeFileSync(file, trusting(path.dirname(root)));
    assert.equal(await mirrorWorktreeTrust(worktree, { file, log: quiet }), true);
  });
});

test('mirrorWorktreeTrust: an untrusted repo\'s worktree is left alone (file byte-identical)', async () => {
  await withRepo(async ({ worktree, legacy, file }) => {
    const before = trusting('/somewhere/else');
    fs.writeFileSync(file, before);
    assert.equal(await mirrorWorktreeTrust(worktree, { file, log: quiet }), false);
    assert.equal(await mirrorWorktreeTrust(legacy, { file, log: quiet }), false);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
  });
});

test('mirrorWorktreeTrust: with no config file, nothing is created', async () => {
  await withRepo(async ({ worktree, file }) => {
    assert.equal(await mirrorWorktreeTrust(worktree, { file, log: quiet }), false);
    assert.equal(fs.existsSync(file), false);
  });
});

test('mirrorWorktreeTrust: a plain checkout or a non-repo cwd is left alone', async () => {
  await withRepo(async ({ root, repo, file }) => {
    const before = trusting(path.join(root, 'other'));
    fs.writeFileSync(file, before);
    assert.equal(await mirrorWorktreeTrust(repo, { file, log: quiet }), false);
    const plain = path.join(root, 'plain');
    fs.mkdirSync(plain);
    assert.equal(await mirrorWorktreeTrust(plain, { file, log: quiet }), false);
    assert.equal(await mirrorWorktreeTrust(path.join(root, 'missing'), { file, log: quiet }), false);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
  });
});

test('mirrorWorktreeTrust: an already-covered worktree is not rewritten', async () => {
  await withRepo(async ({ code, worktree, file }) => {
    const before = trusting(code);
    fs.writeFileSync(file, before);
    assert.equal(await mirrorWorktreeTrust(worktree, { file, log: quiet }), true);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
  });
});

test('mirrorWorktreeTrust: malformed JSON is skipped with a log and never throws', async () => {
  await withRepo(async ({ worktree, file }) => {
    fs.writeFileSync(file, '{ nope');
    const logs = [];
    assert.equal(await mirrorWorktreeTrust(worktree, { file, log: (m) => logs.push(m) }), false);
    assert.equal(fs.readFileSync(file, 'utf8'), '{ nope');
    assert.equal(logs.length, 1);
  });
});

// ensureLoginClaudeTrust: <root>/.claude.json is the server config (the authority),
// <root>/login is the login's CLAUDE_CONFIG_DIR.
async function withLogin(fn) {
  await withRepo(async (ctx) => {
    const login = path.join(ctx.root, 'login');
    fs.mkdirSync(login);
    await fn({ ...ctx, login, loginFile: path.join(login, '.claude.json') });
  });
}

test('ensureLoginClaudeTrust: writes SESSIONS_DIR, a trusted repo\'s worktree and a trusted cwd, never the server config', async () => {
  await withLogin(async ({ root, repo, worktree, file, login, loginFile }) => {
    const server = trusting(repo);
    fs.writeFileSync(file, server);
    const sessionsDir = path.join(root, 'sessions');
    assert.equal(await ensureLoginClaudeTrust(login, { cwd: worktree, sessionsDir, serverFile: file, log: quiet }), true);
    assert.deepEqual(trustedKeys(loginFile), [sessionsDir, worktree].sort());
    assert.equal(await ensureLoginClaudeTrust(login, { cwd: path.join(repo), sessionsDir, serverFile: file, log: quiet }), true);
    assert.deepEqual(trustedKeys(loginFile), [sessionsDir, repo, worktree].sort());
    assert.equal(fs.readFileSync(file, 'utf8'), server);
    assert.equal(fs.statSync(loginFile).mode & 0o777, 0o600);
  });
});

test('ensureLoginClaudeTrust: only the server config authorises; the login\'s own entries and unreadable server config grant nothing', async () => {
  await withLogin(async ({ root, repo, worktree, file, login, loginFile }) => {
    const sessionsDir = path.join(root, 'sessions');
    fs.writeFileSync(loginFile, trusting(repo));
    fs.writeFileSync(file, trusting(path.join(root, 'other')));
    await ensureLoginClaudeTrust(login, { cwd: worktree, sessionsDir, serverFile: file, log: quiet });
    await ensureLoginClaudeTrust(login, { cwd: path.join(root, 'code'), sessionsDir, serverFile: file, log: quiet });
    assert.deepEqual(trustedKeys(loginFile), [sessionsDir, repo].sort());
    fs.writeFileSync(file, '{ nope');
    await ensureLoginClaudeTrust(login, { cwd: worktree, serverFile: file, log: quiet });
    assert.deepEqual(trustedKeys(loginFile), [sessionsDir, repo].sort());
  });
});

test('ensureLoginClaudeTrust: refuses a relative, missing, server, home or ~/.claude dir and a symlinked .claude.json', async () => {
  await withLogin(async ({ root, repo, file, login, loginFile }) => {
    fs.writeFileSync(file, trusting(repo));
    const server = fs.readFileSync(file, 'utf8');
    const logs = [];
    const log = (m) => logs.push(m);
    const opts = { cwd: repo, sessionsDir: path.join(root, 'sessions'), serverFile: file, log };
    const missing = path.join(root, 'missing');
    for (const dir of ['login', missing, root, os.homedir(), path.join(os.homedir(), '.claude'), undefined]) {
      assert.equal(await ensureLoginClaudeTrust(dir, opts), false, String(dir));
    }
    assert.equal(fs.existsSync(missing), false, 'a missing login dir is never created');
    assert.equal(fs.readFileSync(file, 'utf8'), server);
    const target = path.join(root, 'elsewhere.json');
    fs.writeFileSync(target, '{}\n');
    fs.symlinkSync(target, loginFile);
    assert.equal(await ensureLoginClaudeTrust(login, opts), false);
    assert.equal(fs.readFileSync(target, 'utf8'), '{}\n');
    assert.ok(fs.lstatSync(loginFile).isSymbolicLink());
    assert.equal(logs.length, 7);
  });
});
