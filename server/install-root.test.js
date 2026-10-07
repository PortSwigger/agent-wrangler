import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SOURCE_ROOT, resolveInstallRoot, installPath } from './install-root.js';

test('AW_INSTALL_ROOT wins when set, except in a dev instance', () => {
  const sourceRoot = '/src/agent-wrangler';
  assert.equal(resolveInstallRoot({ installRoot: null, dev: false, sourceRoot }), sourceRoot);
  assert.equal(resolveInstallRoot({ installRoot: '/stable/aw/', dev: false, sourceRoot }), '/stable/aw');
  assert.equal(resolveInstallRoot({ installRoot: '/stable/aw', dev: true, sourceRoot }), sourceRoot);
});

test('installPath re-roots only paths inside the source root', () => {
  const opts = { root: '/stable/aw', sourceRoot: '/versions/1.0/aw' };
  assert.equal(installPath('/versions/1.0/aw/server/extensions/builtin/todos/skills', opts), '/stable/aw/server/extensions/builtin/todos/skills');
  assert.equal(installPath('/versions/1.0/aw', opts), '/stable/aw');
  // An installed extension lives under the data dir, and a sibling that merely
  // shares the root's name as a prefix is not inside it.
  assert.equal(installPath('/home/u/.agent-wrangler/extensions/jobs/skills', opts), '/home/u/.agent-wrangler/extensions/jobs/skills');
  assert.equal(installPath('/versions/1.0/aw-other/skills', opts), '/versions/1.0/aw-other/skills');
  assert.equal(installPath('/versions/1.0/aw/x', { root: opts.sourceRoot, sourceRoot: opts.sourceRoot }), '/versions/1.0/aw/x');
});

// The whole contract, end to end, in a fresh process (INSTALL_ROOT is fixed at
// import): every path a Claude or Codex launch hands a session.
function sessionPaths(env) {
  const href = (rel) => JSON.stringify(new URL(rel, import.meta.url).href);
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', `
    const { claude } = await import(${href('./agents/claude.js')});
    const { codex } = await import(${href('./agents/codex.js')});
    console.log(JSON.stringify({
      claude: claude.buildLaunch({ sessionId: 'SID', workflow: true }),
      codex: codex.buildLaunch({ sessionId: 'SID' }),
      leaked: process.env.AW_INSTALL_ROOT ?? null,
    }));
  `], { encoding: 'utf8', env });
  return JSON.parse(out);
}

const baseEnv = () => {
  const env = { ...process.env };
  delete env.AW_INSTALL_ROOT;
  delete env.AW_DEV;
  return env;
};

const SESSION_FILES = [
  'scripts/pr-attach-hook.mjs',
  'agent-skills',
  'skills/issue-to-pr',
  'server/extensions/builtin/task-memory/skills/task-memory',
  'server/extensions/builtin/checklist/skills/checklist',
];

test('with AW_INSTALL_ROOT set, every session-facing path goes through it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-install-root-'));
  const stable = path.join(dir, 'opt');
  fs.symlinkSync(SOURCE_ROOT, stable);
  try {
    const got = sessionPaths({ ...baseEnv(), AW_INSTALL_ROOT: stable });
    for (const rel of SESSION_FILES) assert.ok(got.claude.includes(`${stable}/${rel}`), `claude: ${rel}`);
    assert.ok(got.codex.includes(`${stable}/agent-skills/skills/`), 'codex catalog');
    assert.ok(got.codex.includes(`${stable}/server/extensions/builtin/task-memory/skills/task-memory/SKILL.md`), 'codex extension skill');
    for (const cmd of [got.claude, got.codex]) assert.ok(!cmd.includes(`${SOURCE_ROOT}/`), 'no path through the versioned root');
    assert.equal(got.leaked, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('unset, the paths are the source root ones; a dev instance ignores the variable', () => {
  const unset = sessionPaths(baseEnv());
  for (const rel of SESSION_FILES) assert.ok(unset.claude.includes(`${SOURCE_ROOT}/${rel}`), rel);
  assert.ok(unset.codex.includes(`${SOURCE_ROOT}/agent-skills/skills/`));
  // A dev checkout started from a pane that still carries a packaged board's
  // AW_INSTALL_ROOT must launch sessions on its own hook and skills.
  const dev = sessionPaths({ ...baseEnv(), AW_DEV: '1', AW_INSTALL_ROOT: '/stable/agent-wrangler' });
  assert.equal(dev.claude, unset.claude);
  assert.equal(dev.codex, unset.codex);
});
