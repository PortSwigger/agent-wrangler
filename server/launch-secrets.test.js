import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { writeSecretEnvFile, sourceSecretEnv } from './launch-secrets.js';
import {
  collectLaunchContext, lastLaunchContext, launchProcessEnv, launchSecretEnvOf, withoutSecretEnv, _resetLaunchContextForTests,
} from './launch-context.js';
import { claude, shellQuote } from './agents/claude.js';
import { codex } from './agents/codex.js';
import { local } from './runtimes/local.js';
import { devcontainer, secretEnvDest } from './runtimes/devcontainer.js';

// A dummy value with every character a shell might act on: quotes, a command
// substitution, a variable, a glob and a newline. None of it may be expanded.
const SECRET = `fixture-secret-'q'-"dq"-$(touch PWNED)-$HOME-*-\nline2`;
const registry = (...rows) => ({ hooks: { 'session.launchContext': rows.map(([extId, fn]) => ({ extId, fn })) } });
const quiet = () => {
  const errors = [];
  return { errors, onError: (...a) => errors.push(a.map(String).join(' ')) };
};
const tmp = (prefix) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
const modeOf = (p) => fs.statSync(p).mode & 0o777;

test('collect: secretEnv merges like env, never echoes a value, and is absent when empty', async () => {
  const { errors, onError } = quiet();
  const ext = registry(
    ['a', () => ({ secretEnv: { ACME_TOKEN: 'fixture-a', 'bad name': 'fixture-bad', NUM: 7, NUL_VALUE: 'fixture\0x' } })],
    ['b', () => ({ secretEnv: { ACME_TOKEN: 'fixture-b', OTHER_TOKEN: 'fixture-c' } })],
  );
  const out = await collectLaunchContext({ sid: 's1' }, { ext, onError });
  assert.deepEqual(out.secretEnv, { ACME_TOKEN: 'fixture-b', OTHER_TOKEN: 'fixture-c' });
  assert.equal(errors.length, 4);
  assert.ok(errors.includes('[launch-context] secretEnv ACME_TOKEN set by a and b; b wins'));
  assert.ok(errors.every((e) => !/fixture/.test(e)), 'no value reaches the log');
  const plain = await collectLaunchContext({ sid: 's2' }, { ext: registry(['a', () => ({ secretEnv: {} })]), onError });
  assert.deepEqual(plain, { env: {}, addDirs: [] });
  for (const secretEnv of ['K=v', ['K=v'], 7]) {
    assert.deepEqual(await collectLaunchContext({ sid: 's3' }, { ext: registry(['a', () => ({ secretEnv })]), onError }), { env: {}, addDirs: [] });
  }
});

test('collect: a name set as env and as secretEnv is delivered as a secret only, and the log names no value', async () => {
  const { errors, onError } = quiet();
  const out = await collectLaunchContext({ sid: 's' }, {
    ext: registry(['plain', () => ({ env: { ACME_TOKEN: 'fixture-plain', AW_OK: '1' } })], ['vault', () => ({ secretEnv: { ACME_TOKEN: 'fixture-secret' } })]),
    onError,
  });
  assert.deepEqual(out.env, { AW_OK: '1' });
  assert.deepEqual(out.secretEnv, { ACME_TOKEN: 'fixture-secret' });
  assert.deepEqual(errors, ['[launch-context] env ACME_TOKEN set by plain is also a secretEnv of vault; delivered as a secret']);
});

test('collect: the per-session cache never holds a secret; the launch result does', async () => {
  _resetLaunchContextForTests();
  const out = await collectLaunchContext({ sid: 'cached' }, { ext: registry(['a', () => ({ secretEnv: { ACME_TOKEN: 'fixture' }, addDirs: ['/granted'] })]), onError: () => {} });
  assert.equal(out.secretEnv.ACME_TOKEN, 'fixture');
  assert.deepEqual(lastLaunchContext('cached'), { env: {}, addDirs: ['/granted'] });
  assert.ok(!JSON.stringify(lastLaunchContext('cached')).includes('fixture'));
});

test('helpers: launchProcessEnv merges secrets in-process, withoutSecretEnv strips them, both tolerate no context', () => {
  const lc = { env: { AW_X: '1' }, addDirs: [], secretEnv: { ACME_TOKEN: 'v' } };
  assert.deepEqual(launchProcessEnv(lc), { AW_X: '1', ACME_TOKEN: 'v' });
  assert.deepEqual(withoutSecretEnv(lc), { env: { AW_X: '1' }, addDirs: [] });
  assert.equal(withoutSecretEnv(undefined), undefined);
  assert.deepEqual(launchProcessEnv(undefined), {});
  assert.deepEqual(launchSecretEnvOf({ secretEnv: ['x'] }), {});
});

test('writeSecretEnvFile: 0600 in a 0700 dir, valid names only, replaced on relaunch, null when nothing to write', () => {
  const dir = path.join(tmp('aw-secrets-'), 'launch-secrets');
  try {
    assert.equal(writeSecretEnvFile('cc_x', {}, { dir }), null);
    assert.equal(writeSecretEnvFile('cc_x', { 'bad name': 'v', $X: 'v' }, { dir }), null);
    const file = writeSecretEnvFile('cc_x', { ACME_TOKEN: 'first', 'a;b': 'v' }, { dir });
    assert.equal(file, path.join(dir, 'cc_x.env'));
    assert.equal(modeOf(dir), 0o700);
    assert.equal(modeOf(file), 0o600);
    assert.equal(fs.readFileSync(file, 'utf8'), "export ACME_TOKEN='first'\n");
    fs.chmodSync(file, 0o644);
    writeSecretEnvFile('cc_x', { ACME_TOKEN: 'second' }, { dir });
    assert.equal(modeOf(file), 0o600, 'a relaunch writes a fresh 0600 file');
    assert.equal(fs.readFileSync(file, 'utf8'), "export ACME_TOKEN='second'\n");
  } finally {
    fs.rmSync(path.dirname(dir), { recursive: true, force: true });
  }
});

test('writeSecretEnvFile prunes a file left by a pane that never started', () => {
  const dir = tmp('aw-secrets-prune-');
  try {
    const old = writeSecretEnvFile('cc_old', { A: '1' }, { dir });
    const past = new Date(Date.now() - 2 * 60 * 60 * 1000);
    fs.utimesSync(old, past, past);
    writeSecretEnvFile('cc_new', { A: '1' }, { dir });
    assert.equal(fs.existsSync(old), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('sourceSecretEnv quotes the path and is empty with no file', () => {
  assert.equal(sourceSecretEnv(null), '');
  assert.equal(sourceSecretEnv("/d/it's.env"), `. ${shellQuote("/d/it's.env")} && rm -f ${shellQuote("/d/it's.env")} && `);
});

// Runs a local pane command the way tmux does (`<shell> -c 'cd … && <cmd>'`) with a
// fake agent binary on PATH that records its environment.
async function runLocalPane(build, launchContext, { shell = '/bin/sh' } = {}) {
  const dir = tmp('aw-secret-pane-');
  try {
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    for (const name of ['claude', 'codex']) fs.writeFileSync(path.join(bin, name), '#!/bin/sh\nenv -0 > "$AW_FAKE_OUT"\n', { mode: 0o755 });
    const out = path.join(dir, 'agent.env');
    const secretEnvFile = writeSecretEnvFile('cc_pane', launchSecretEnvOf(launchContext), { dir: path.join(dir, 'secrets') });
    const cmd = await local.wrapLaunch({ inner: build(launchContext), secretEnvFile });
    const r = spawnSync(shell, ['-c', `cd ${shellQuote(dir)} && ${cmd}`], {
      env: { PATH: `${bin}:/usr/bin:/bin`, HOME: dir, ZDOTDIR: dir, AW_FAKE_OUT: out },
      encoding: 'utf8',
    });
    const seen = fs.existsSync(out)
      ? Object.fromEntries(fs.readFileSync(out, 'utf8').split('\0').filter(Boolean).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]))
      : null;
    return { status: r.status, stderr: r.stderr, seen, cmd, secretEnvFile, fileLeft: fs.existsSync(secretEnvFile), pwned: fs.existsSync(path.join(dir, 'PWNED')) };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const SHELLS = ['/bin/sh', ...(fs.existsSync('/bin/zsh') ? ['/bin/zsh'] : []), ...(fs.existsSync('/bin/bash') ? ['/bin/bash'] : [])];
const PANE_BUILDERS = {
  'claude buildLaunch': (lc) => claude.buildLaunch({ sessionId: 'MX', launchContext: lc }),
  'claude buildResume': (lc) => claude.buildResume({ sessionId: 'MX', resumeId: 'R', launchContext: lc }),
  'claude buildFork': (lc) => claude.buildFork({ sessionId: 'MX', sourceId: 'S', launchContext: lc }),
  'codex buildLaunch': (lc) => codex.buildLaunch({ sessionId: 'MX', launchContext: lc }),
  'codex buildResume': (lc) => codex.buildResume({ sessionId: 'MX', resumeId: 'R', launchContext: lc }),
  'codex buildFork': (lc) => codex.buildFork({ sessionId: 'MX', sourceId: 'S', launchContext: lc }),
};

for (const [name, build] of Object.entries(PANE_BUILDERS)) {
  test(`local pane, ${name}: the agent sees the secret, the command carries only the file path, and the file is gone`, async () => {
    const lc = await collectLaunchContext({ sid: 'MX', agent: name.split(' ')[0] }, {
      ext: registry(['vault', () => ({ secretEnv: { ACME_TOKEN: SECRET }, env: { ACME_MASKED_NAMES: 'ACME_TOKEN' } })]),
      onError: () => {},
    });
    for (const shell of SHELLS) {
      const r = await runLocalPane(build, lc, { shell });
      assert.equal(r.status, 0, `${shell}: ${r.stderr}`);
      assert.equal(r.seen.ACME_TOKEN, SECRET, `${shell} delivers the value byte for byte`);
      assert.equal(r.seen.ACME_MASKED_NAMES, 'ACME_TOKEN');
      assert.equal(r.seen.AW_SESSION_ID, 'MX', 'core variables still arrive');
      assert.equal(r.fileLeft, false, `${shell} deletes the file before the agent runs`);
      assert.equal(r.pwned, false, 'nothing in the value was executed');
      assert.ok(!r.cmd.includes('fixture-secret'), 'the value is not in the pane command');
      assert.ok(r.cmd.startsWith(`. ${shellQuote(r.secretEnvFile)} && rm -f `), r.cmd.slice(0, 120));
    }
  });
}

test('local pane: a launch without secretEnv is byte-identical to before', async () => {
  const inner = claude.buildLaunch({ sessionId: 'MX', launchContext: { env: {}, addDirs: [] } });
  assert.equal(await local.wrapLaunch({ inner }), inner);
  assert.equal(await local.wrapLaunch({ inner, secretEnvFile: null }), inner);
});

test('devcontainer pane: copies the file in, deletes the host copy, hands it to the container user and sources it inside', async () => {
  const lc = { env: {}, addDirs: [], secretEnv: { ACME_TOKEN: 'fixture-secret' } };
  const hostFile = '/data/launch-secrets/cc_MX.env';
  const script = await devcontainer.wrapLaunch({
    inner: claude.buildLaunch({ sessionId: 'MX', launchContext: lc }), cwd: '/repo', sessionId: 'MX', launchContext: lc, secretEnvFile: hostFile,
  });
  const dest = secretEnvDest('MX');
  assert.equal(dest, '/tmp/aw-secret-MX.env');
  assert.ok(!script.includes('fixture-secret'));
  const steps = script.split(' && ');
  const at = (prefix) => steps.findIndex((s) => s.startsWith(prefix));
  const cp = at(`docker cp '${hostFile}' "$CID":'${dest}'`);
  const rm = at(`rm -f '${hostFile}'`);
  const chown = at(`docker exec -u root "$CID" chown "$(devcontainer exec --workspace-folder '/repo' id -u)" '${dest}'`);
  const chmod = at(`docker exec -u root "$CID" chmod 600 '${dest}'`);
  const exec = at('devcontainer exec --workspace-folder \'/repo\' sh -lc ');
  assert.ok(at('devcontainer up') < cp && cp < rm && rm < chown && chown < chmod && chmod < exec, steps.join('\n'));
  const inside = script.slice(script.indexOf('sh -lc ') + 'sh -lc '.length);
  // shellQuote(prefix + rest) starts with shellQuote(prefix) minus its closing quote.
  assert.ok(inside.startsWith(shellQuote(sourceSecretEnv(dest)).slice(0, -1)), inside.slice(0, 120));
  const without = await devcontainer.wrapLaunch({ inner: 'claude', cwd: '/repo', sessionId: 'MX' });
  assert.ok(!without.includes('aw-secret'), 'no secret steps without a file');
});
