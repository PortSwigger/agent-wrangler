import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  collectLaunchContext, lastLaunchContext, launchEnvPrefix, launchAddDirArgs, launchCodexConfigArgs, launchEnvOf, launchAddDirsOf, launchEnvGuard,
  LAUNCH_REASONS, EMPTY_LAUNCH_CONTEXT, _resetLaunchContextForTests,
} from './launch-context.js';
import { BUILTIN, loadExtensions } from './extensions/index.js';
import { MemoryStore, MEMORY_DIR } from './extensions/builtin/task-memory/memory-store.js';
import { claude, shellQuote } from './agents/claude.js';
import { codex } from './agents/codex.js';
import { devcontainer } from './runtimes/devcontainer.js';

// A registry double: the loader's `hooks` table, one row per fake extension.
const registry = (...rows) => ({ hooks: { 'session.launchContext': rows.map(([extId, fn]) => ({ extId, fn })) } });
const quiet = () => {
  const errors = [];
  return { errors, onError: (...a) => errors.push(a.map(String).join(' ')) };
};

test('LAUNCH_REASONS is the documented closed set', () => {
  assert.deepEqual(LAUNCH_REASONS, ['dispatch', 'resume', 'fork', 'message', 'snooze-wake', 'spawn', 'assign', 'adopt', 'headless']);
});

test('no hooks: an empty context', async () => {
  assert.deepEqual(await collectLaunchContext({ sid: 's' }, { ext: registry(), onError: () => {} }), { env: {}, addDirs: [] });
  assert.deepEqual(await collectLaunchContext({ sid: 's' }, { ext: {}, onError: () => {} }), { env: {}, addDirs: [] });
});

test('merges env across extensions; on a collision the later extension wins and the collision is logged', async () => {
  const { errors, onError } = quiet();
  const ext = registry(
    ['a', () => ({ env: { AW_ONE: '1', AW_SHARED: 'from-a' } })],
    ['b', () => ({ env: { AW_TWO: '2', AW_SHARED: 'from-b' } })],
  );
  const out = await collectLaunchContext({ sid: 's' }, { ext, onError });
  assert.deepEqual(out.env, { AW_ONE: '1', AW_SHARED: 'from-b', AW_TWO: '2' });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /env AW_SHARED set by a and b; b wins/);
});

test('merges addDirs in order and dedupes', async () => {
  const ext = registry(
    ['a', () => ({ addDirs: ['/one', '/two'] })],
    ['b', () => ({ addDirs: ['/two', '/three'] })],
  );
  assert.deepEqual((await collectLaunchContext({ sid: 's' }, { ext, onError: () => {} })).addDirs, ['/one', '/two', '/three']);
});

test('a throwing hook is logged and skipped; the others still contribute', async () => {
  const { errors, onError } = quiet();
  const ext = registry(
    ['bad', () => { throw new Error('boom'); }],
    ['bad-async', async () => { throw new Error('async boom'); }],
    ['good', () => ({ env: { AW_OK: 'yes' }, addDirs: ['/ok'] })],
  );
  const out = await collectLaunchContext({ sid: 's' }, { ext, onError });
  assert.deepEqual(out, { env: { AW_OK: 'yes' }, addDirs: ['/ok'] });
  assert.equal(errors.length, 2);
  assert.match(errors[0], /\[ext:bad\] session\.launchContext failed/);
  assert.match(errors[1], /\[ext:bad-async\]/);
});

test('unusable answers are dropped piecemeal: bad env names/values, relative or non-string dirs, a non-object', async () => {
  const { errors, onError } = quiet();
  const ext = registry(
    ['a', () => ({ env: { lower: 'x', 'BAD-NAME': 'x', 'A B': 'x', AW_NUM: 5, AW_GOOD: 'ok' }, addDirs: ['relative/path', 42, '/abs'] })],
    ['b', () => 'a string'],
    ['c', () => [1, 2]],
    ['d', () => null],
    ['e', () => undefined],
  );
  const out = await collectLaunchContext({ sid: 's' }, { ext, onError });
  assert.deepEqual(out, { env: { AW_GOOD: 'ok' }, addDirs: ['/abs'] });
  assert.equal(errors.length, 4 + 2 + 2, 'four env drops, two dir drops, two non-object answers');
});

test('the hook gets the full context and ITS OWN host; an async hook is awaited before the result is returned', async () => {
  const seen = [];
  const ext = registry(['a', async (ctx) => { await new Promise((r) => setTimeout(r, 15)); seen.push(ctx); return { env: { AW_LATE: 'x' } }; }]);
  const hosts = { a: { id: 'host-a' } };
  const out = await collectLaunchContext(
    { sid: 'S1', task: { id: 'T1', name: 'n' }, agent: 'codex', runtime: 'devcontainer', reason: 'resume' },
    { ext, hostApiFor: (id) => hosts[id], onError: () => {} },
  );
  assert.deepEqual(out.env, { AW_LATE: 'x' });
  assert.deepEqual(seen, [{ sid: 'S1', task: { id: 'T1', name: 'n' }, agent: 'codex', grantPaths: 'realpath', runtime: 'devcontainer', reason: 'resume', ext: null, host: { id: 'host-a' } }]);
});

test('defaults: claude, local, dispatch, no task', async () => {
  let got;
  await collectLaunchContext({ sid: 's' }, { ext: registry(['a', (c) => { got = c; }]), onError: () => {} });
  assert.deepEqual({ ...got, host: undefined }, { sid: 's', task: null, agent: 'claude', grantPaths: 'symlink', runtime: 'local', reason: 'dispatch', ext: null, host: undefined });
});

test('the last answer is remembered per session (what paste-store reads), and an unknown session reads as empty', async () => {
  _resetLaunchContextForTests();
  assert.equal(lastLaunchContext('nope'), EMPTY_LAUNCH_CONTEXT);
  await collectLaunchContext({ sid: 'remembered' }, { ext: registry(['a', () => ({ addDirs: ['/granted'] })]), onError: () => {} });
  assert.deepEqual(lastLaunchContext('remembered').addDirs, ['/granted']);
});

test('headless collection preserves the interactive directory grants and never caches a headless-only card', async () => {
  const sid = 'headless-cache';
  const interactive = await collectLaunchContext({ sid }, {
    ext: registry(['a', () => ({ addDirs: ['/interactive'] })]),
  });
  for (const card of [sid, 'headless-only']) {
    const headless = await collectLaunchContext({ sid: card, reason: 'headless' }, {
      ext: registry(['a', () => ({ env: { AW_CONTEXT: 'headless' }, addDirs: ['/headless'] })]),
    });
    assert.deepEqual(headless, { env: { AW_CONTEXT: 'headless' }, addDirs: ['/headless'] });
  }
  assert.equal(lastLaunchContext(sid), interactive);
  assert.equal(lastLaunchContext('headless-only'), EMPTY_LAUNCH_CONTEXT);
});

test('helpers tolerate a launch that carries no context at all', () => {
  assert.deepEqual(launchEnvOf(undefined), {});
  assert.deepEqual(launchAddDirsOf(null), []);
  assert.equal(launchEnvPrefix(undefined, shellQuote), '');
  assert.deepEqual(launchAddDirArgs({}), []);
  assert.equal(launchEnvPrefix({ env: { AW_A: "it's", AW_B: 'b' } }, shellQuote), `AW_A='it'\\''s' AW_B='b' `);
  assert.deepEqual(launchAddDirArgs({ addDirs: ['/a', '/b'] }), ['--add-dir', '/a', '--add-dir', '/b']);
});

// ── a disabled extension contributes nothing ─────────────────────────────────

test('the real loader: a DISABLED extension has no launchContext hook registered, so it contributes nothing', async () => {
  const on = loadExtensions({ cfg: {}, builtin: BUILTIN });
  const off = loadExtensions({ cfg: { extensions: { 'task-memory': false } }, builtin: BUILTIN });
  assert.equal(on.hooks['session.launchContext'].length, 1);
  assert.equal(off.hooks['session.launchContext'].length, 0);
  assert.deepEqual(await collectLaunchContext({ sid: 'tm-off' }, { ext: off, hostApiFor: () => ({}), onError: () => {} }), { env: {}, addDirs: [] });
});

// ── the matrix: every reason × every launch builder ──────────────────────────
// AW_TASK_MEMORY (as an ENV ASSIGNMENT — the skill prose names it bare) and
// --add-dir are present iff the extension is enabled; Codex gets the resolved
// real path and Claude (and the devcontainer, which is Claude) the stable
// symlink. A launch site that bypassed the shared helper would silently drop
// memory, which is what this pins.

const store = new MemoryStore(MEMORY_DIR);
const hostApiFor = () => ({ stores: { taskMemory: store } });
const enabledExt = loadExtensions({ cfg: {}, builtin: BUILTIN });
const disabledExt = loadExtensions({ cfg: { extensions: { 'task-memory': false } }, builtin: BUILTIN });

const BUILDERS = {
  'claude buildLaunch': (lc) => claude.buildLaunch({ sessionId: 'MX', launchContext: lc }),
  'claude buildResume': (lc) => claude.buildResume({ sessionId: 'MX', resumeId: 'R', launchContext: lc }),
  'claude buildFork': (lc) => claude.buildFork({ sessionId: 'MX', sourceId: 'S', launchContext: lc }),
  'codex buildLaunch': (lc) => codex.buildLaunch({ sessionId: 'MX', launchContext: lc }),
  'codex buildResume': (lc) => codex.buildResume({ sessionId: 'MX', resumeId: 'R', launchContext: lc }),
  'codex buildFork': (lc) => codex.buildFork({ sessionId: 'MX', sourceId: 'S', launchContext: lc }),
  'devcontainer wrapLaunch': (lc) => devcontainer.wrapLaunch({
    inner: claude.buildLaunch({ sessionId: 'MX', launchContext: lc }), cwd: '/repo', sessionId: 'MX', launchContext: lc,
  }),
};

for (const reason of LAUNCH_REASONS.filter((r) => r !== 'headless')) {
  for (const [name, build] of Object.entries(BUILDERS)) {
    const isCodex = name.startsWith('codex');
    const agent = isCodex ? 'codex' : 'claude';

    test(`matrix [${reason}] ${name}: AW_TASK_MEMORY and --add-dir present when task-memory is enabled`, async () => {
      const lc = await collectLaunchContext({ sid: 'MX', task: { id: 'TM' }, agent, reason }, { ext: enabledExt, hostApiFor, onError: () => {} });
      const cmd = await build(lc);
      const real = fs.realpathSync(store.taskDir('TM'));
      if (isCodex) {
        assert.ok(cmd.includes(`AW_TASK_MEMORY='${real}/memory.md'`), 'codex gets the resolved real path');
        assert.ok(cmd.includes(`'--add-dir' '${real}'`));
        assert.ok(!cmd.includes('by-session'), 'never the symlink');
      } else if (name.startsWith('devcontainer')) {
        // Substituted to its container destination, and copied in. The inner command
        // is re-quoted inside `sh -lc '…'`, so only the pieces are asserted.
        const [copies, inner] = [cmd.slice(0, cmd.indexOf('sh -lc')), cmd.slice(cmd.indexOf('sh -lc'))];
        assert.ok(/docker cp -L '[^']*by-session\/MX' "\$CID":'\/tmp\/aw-MX\/launch-dirs\/0'/.test(copies), 'the granted dir is copied in');
        assert.ok(inner.includes('AW_TASK_MEMORY=') && inner.includes('/tmp/aw-MX/launch-dirs/0/memory.md'));
        assert.ok(inner.includes('--add-dir') && inner.includes('/tmp/aw-MX/launch-dirs/0'));
        assert.ok(!inner.includes('by-session'), 'no host path left in the command that runs in the container');
      } else {
        assert.ok(cmd.includes(`AW_TASK_MEMORY='${MEMORY_DIR}/by-session/MX/memory.md'`), 'claude gets the stable symlink');
        assert.ok(cmd.includes(`'--add-dir' '${MEMORY_DIR}/by-session/MX'`));
      }
    });

    test(`matrix [${reason}] ${name}: neither is present when task-memory is disabled`, async () => {
      const lc = await collectLaunchContext({ sid: 'MX', task: { id: 'TM' }, agent, reason }, { ext: disabledExt, hostApiFor, onError: () => {} });
      const cmd = await build(lc);
      assert.doesNotMatch(cmd, /AW_TASK_MEMORY=/);
      assert.doesNotMatch(cmd, /--add-dir/);
      assert.doesNotMatch(cmd, /by-session|launch-dirs/);
    });
  }
}


test('a hook may deliberately refuse a launch without asking later hooks or caching partial context', async () => {
  const calls = [];
  const ext = registry(
    ['first', () => ({ env: { AW_PARTIAL: 'no' } })],
    ['refusal', () => ({ refuse: '  stored context is unavailable  ' })],
    ['later', () => { calls.push('later'); return {}; }],
  );
  const { errors, onError } = quiet();
  await assert.rejects(collectLaunchContext({ sid: 'refused' }, { ext, onError }), { message: 'stored context is unavailable' });
  assert.deepEqual(calls, []);
  assert.deepEqual(errors, []);
  assert.equal(lastLaunchContext('refused'), EMPTY_LAUNCH_CONTEXT);
});

test('a blank or non-string refusal is ignored', async () => {
  for (const refuse of ['', '   ', 7, null, false]) {
    assert.deepEqual(await collectLaunchContext({ sid: 'blank-refusal' }, {
      ext: registry(['a', () => ({ refuse })]), onError: () => {},
    }), { env: {}, addDirs: [] });
  }
});

test('a fork hook sees the parent card id', async () => {
  let seen;
  await collectLaunchContext({ sid: 'child', reason: 'fork', parentId: 'parent' }, {
    ext: registry(['a', (p) => { seen = p; return {}; }]), onError: () => {},
  });
  assert.equal(seen.parentId, 'parent');
});

test('headless launch hooks receive their own narrowed ext slice and the unchanged reason', async () => {
  const seen = {};
  const ext = registry(
    ['context', (p) => { seen.context = p; return { env: { AW_CONTEXT: 'secondary' } }; }],
    ['other', (p) => { seen.other = p; }],
  );
  const result = await collectLaunchContext({ sid: null, reason: 'headless', ext: { context: { selection: 'secondary' } } }, { ext });
  assert.deepEqual(result.env, { AW_CONTEXT: 'secondary' });
  assert.equal(seen.context.reason, 'headless');
  assert.deepEqual(seen.context.ext, { selection: 'secondary' });
  assert.equal(seen.other.ext, null);
  assert.ok(LAUNCH_REASONS.includes('headless'));
});

test('extension data is narrowed on interactive launch reasons too and absent data is null', async () => {
  for (const reason of ['dispatch', 'resume', 'fork']) {
    let seen;
    await collectLaunchContext({ sid: 'card', agent: 'codex', reason, ext: { context: { choice: 1 }, sibling: { hidden: true } } }, {
      ext: registry(['context', (p) => { seen = p; }]),
    });
    assert.deepEqual(seen.ext, { choice: 1 });
    await collectLaunchContext({ sid: 'card', reason }, { ext: registry(['context', (p) => { seen = p; }]) });
    assert.equal(seen.ext, null);
  }
});

// ── refuseIfSet: the pane-side auth-override check ───────────────────────────

test('refuseIfSet merges valid names across extensions, drops the rest, and is absent when empty', async () => {
  const { errors, onError } = quiet();
  const ext = registry(
    ['a', () => ({ refuseIfSet: ['ANTHROPIC_API_KEY', 'bad name', 7] })],
    ['b', () => ({ refuseIfSet: ['ANTHROPIC_API_KEY', 'CLAUDE_SECURESTORAGE_CONFIG_DIR'] })],
  );
  const out = await collectLaunchContext({ sid: 'guarded' }, { ext, onError });
  assert.deepEqual(out.refuseIfSet, ['ANTHROPIC_API_KEY', 'CLAUDE_SECURESTORAGE_CONFIG_DIR']);
  assert.equal(errors.length, 2);
  assert.deepEqual(await collectLaunchContext({ sid: 'plain' }, { ext: registry(['a', () => ({ refuseIfSet: [] })]), onError }), { env: {}, addDirs: [] });
  assert.equal(launchEnvGuard({ refuseIfSet: ['$(touch x)', 'a;b'] }, shellQuote), '', 'names are re-validated before they reach shell source');
});

for (const [name, build] of Object.entries(BUILDERS)) {
  test(`refuseIfSet: ${name} runs the guard before the agent, and a default launch has none`, async () => {
    const plain = await build({ env: {}, addDirs: [] });
    assert.doesNotMatch(plain, /\/bin\/sh -c/);
    const guarded = await build({ env: {}, addDirs: [], refuseIfSet: ['ANTHROPIC_API_KEY'] });
    const inner = name.startsWith('devcontainer') ? guarded.slice(guarded.indexOf('sh -lc')) : guarded;
    assert.ok(inner.includes('/bin/sh -c') && inner.includes('ANTHROPIC_API_KEY+x'), inner.slice(0, 200));
    if (!name.startsWith('devcontainer')) assert.ok(guarded.startsWith('/bin/sh -c '));
  });
}

// Runs a built Claude launch command the way tmux does (`<shell> -c 'cd … && <cmd>'`)
// with a fake `claude` on PATH that records the environment it got. The env is
// built from scratch (dummy values only), and zsh reads a fixture ZDOTDIR's
// .zshenv, standing in for a variable the user's shell startup adds.
function runPane(launchContext, { shell = '/bin/sh', env = {}, zshenv = '' } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aw-pane-env-')));
  try {
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\nenv > "$AW_FAKE_OUT"\n', { mode: 0o755 });
    fs.writeFileSync(path.join(dir, '.zshenv'), zshenv);
    const out = path.join(dir, 'claude.env');
    const cmd = claude.buildLaunch({ sessionId: 'MX', launchContext });
    const r = spawnSync(shell, ['-c', `cd ${shellQuote(dir)} && ${cmd}`], {
      env: { PATH: `${bin}:/usr/bin:/bin`, HOME: dir, ZDOTDIR: dir, AW_FAKE_OUT: out, ...env },
      encoding: 'utf8',
    });
    const seen = fs.existsSync(out) ? Object.fromEntries(fs.readFileSync(out, 'utf8').trim().split('\n').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)])) : null;
    return { status: r.status, stderr: r.stderr, seen };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const HAS_ZSH = fs.existsSync('/bin/zsh');

test('pane-shell finding: today\'s seams let a pane-shell auth override reach the agent', () => {
  // Server-side `refuse` never sees the pane, and `env -u` strips only names the
  // server had when it built the command: an override in the pane reaches claude.
  const viaEnv = runPane({ env: {}, addDirs: [] }, { env: { ANTHROPIC_API_KEY: 'dummy-not-a-secret' } });
  assert.equal(viaEnv.status, 0);
  assert.equal(viaEnv.seen.ANTHROPIC_API_KEY, 'dummy-not-a-secret');
  // An extension can only ASSIGN: '' is still set, and for this name empty selects the default Keychain entry.
  const assigned = runPane({ env: { CLAUDE_SECURESTORAGE_CONFIG_DIR: '' }, addDirs: [] }, { env: { CLAUDE_SECURESTORAGE_CONFIG_DIR: '/fixture/other' } });
  assert.equal(assigned.seen.CLAUDE_SECURESTORAGE_CONFIG_DIR, '');
  if (HAS_ZSH) {
    const viaRc = runPane({ env: {}, addDirs: [] }, { shell: '/bin/zsh', zshenv: 'export ANTHROPIC_AUTH_TOKEN=dummy-from-zshenv\n' });
    assert.equal(viaRc.seen.ANTHROPIC_AUTH_TOKEN, 'dummy-from-zshenv');
  }
});

test('pane-shell finding: refuseIfSet refuses in the pane, names the variable, never prints its value', () => {
  const lc = { env: {}, addDirs: [], refuseIfSet: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_SECURESTORAGE_CONFIG_DIR'] };
  const cases = [
    ['/bin/sh', { env: { ANTHROPIC_API_KEY: 'dummy-not-a-secret' } }, 'ANTHROPIC_API_KEY'],
    ['/bin/sh', { env: { CLAUDE_SECURESTORAGE_CONFIG_DIR: '' } }, 'CLAUDE_SECURESTORAGE_CONFIG_DIR'],
  ];
  if (HAS_ZSH) cases.push(['/bin/zsh', { zshenv: 'export ANTHROPIC_AUTH_TOKEN=dummy-from-zshenv\n' }, 'ANTHROPIC_AUTH_TOKEN']);
  for (const [shell, opts, name] of cases) {
    const r = runPane(lc, { shell, ...opts });
    assert.equal(r.status, 1, `${shell} ${name}`);
    assert.equal(r.seen, null, 'claude never ran');
    assert.match(r.stderr, new RegExp(`refused this launch: ${name} is set`));
    assert.doesNotMatch(r.stderr, /dummy/);
  }
  const clean = runPane(lc, { shell: HAS_ZSH ? '/bin/zsh' : '/bin/sh' });
  assert.equal(clean.status, 0);
  assert.ok(clean.seen && !('ANTHROPIC_API_KEY' in clean.seen));
});

// ── codexConfig: nonsecret Codex `-c` overrides ──────────────────────────────

const KEYRING = { cli_auth_credentials_store: 'keyring', forced_login_method: 'chatgpt', 'tui.notifications': false, model_context_window: 200000 };

test('codexConfig merges across extensions; on a collision the later extension wins and the collision is logged', async () => {
  const { errors, onError } = quiet();
  const ext = registry(
    ['a', () => ({ codexConfig: { cli_auth_credentials_store: 'file', forced_login_method: 'chatgpt' } })],
    ['b', () => ({ codexConfig: { cli_auth_credentials_store: 'keyring', 'tui.notifications': false } })],
  );
  const out = await collectLaunchContext({ sid: 's', agent: 'codex' }, { ext, onError });
  assert.deepEqual(out.codexConfig, { cli_auth_credentials_store: 'keyring', forced_login_method: 'chatgpt', 'tui.notifications': false });
  assert.deepEqual(errors, ['[launch-context] codexConfig cli_auth_credentials_store set by a and b; b wins']);
});

for (const name of ['codex buildLaunch', 'codex buildResume', 'codex buildFork']) {
  test(`codexConfig: ${name} carries each override as -c key=value`, () => {
    const cmd = BUILDERS[name]({ env: {}, addDirs: [], codexConfig: KEYRING });
    for (const flag of ["'-c' 'cli_auth_credentials_store=\"keyring\"'", "'-c' 'forced_login_method=\"chatgpt\"'", "'-c' 'tui.notifications=false'", "'-c' 'model_context_window=200000'"]) {
      assert.ok(cmd.includes(flag), `${flag} in ${cmd.slice(0, 300)}`);
    }
  });
}

test('codexConfig: dispatch, resume and fork collect it and the Codex command carries it', async () => {
  const ext = registry(['logins', () => ({ codexConfig: { cli_auth_credentials_store: 'keyring' } })]);
  for (const [reason, build] of [['dispatch', BUILDERS['codex buildLaunch']], ['resume', BUILDERS['codex buildResume']], ['fork', BUILDERS['codex buildFork']]]) {
    const lc = await collectLaunchContext({ sid: 'cx', agent: 'codex', reason }, { ext, onError: () => {} });
    assert.ok(build(lc).includes("'-c' 'cli_auth_credentials_store=\"keyring\"'"), reason);
  }
});

test('codexConfig: invalid or secret-looking overrides are dropped with a named error that never echoes the value', async () => {
  const { errors, onError } = quiet();
  const dropped = {
    'bad key': 'x',
    'a=b': 'x',
    'projects."/repo".trust_level': 'trusted',
    'nested.': 'x',
    developer_instructions: 'x',
    notify: 'x',
    'mcp_servers.evil.command': '/bin/sh',
    model: 'gpt-x',
    model_reasoning_effort: 'high',
    sandbox_mode: 'danger-full-access',
    approval_policy: 'never',
    'sandbox_workspace_write.network_access': true,
    'projects.repo.trust_level': 'trusted',
    profile: 'other',
    'model_providers.acme.experimental_bearer_token': 'fixture-value-1',
    'model_providers.acme.api_key': 'fixture-value-2',
    'model_providers.acme.http_headers.X-Key': 'fixture-value-3',
    'model_providers.acme.env.FOO': 'fixture-value-4',
    'shell_environment_policy.set.password': 'fixture-value-5',
    'shell_environment_policy.set.FOO': 'fixture-value-12',
    client_secret: 'fixture-value-6',
    openai_api_key: 'fixture-value-7',
    some_setting: 'sk-fixture-value-8',
    other_setting: 'Bearer fixture-value-9',
    jwt_like: 'eyJfixture.value10',
    gh_like: 'ghp_fixturevalue11',
    multiline: 'one\ntwo',
    huge: 'x'.repeat(1025),
    nan: Number.NaN,
    inf: Infinity,
    arr: ['a'],
    obj: { a: 1 },
    nul: null,
  };
  const ext = registry(['x', () => ({ codexConfig: { ...dropped, cli_auth_credentials_store: 'keyring' } })]);
  const out = await collectLaunchContext({ sid: 's', agent: 'codex' }, { ext, onError });
  assert.deepEqual(out.codexConfig, { cli_auth_credentials_store: 'keyring' });
  assert.equal(errors.length, Object.keys(dropped).length);
  for (const key of Object.keys(dropped)) {
    assert.ok(errors.some((e) => e.startsWith(`[ext:x] session.launchContext codexConfig ${JSON.stringify(key)} dropped (`)), key);
  }
  assert.ok(errors.includes('[ext:x] session.launchContext codexConfig "client_secret" dropped (key looks like a credential)'));
  assert.ok(errors.includes('[ext:x] session.launchContext codexConfig "some_setting" dropped (value looks like a credential)'));
  assert.ok(errors.includes('[ext:x] session.launchContext codexConfig "sandbox_mode" dropped (key is reserved for Agent Wrangler)'));
  assert.ok(errors.every((e) => !/fixture|sk-|Bearer|ghp_|eyJ/.test(e)), 'no value reaches the log');

  const odd = quiet();
  for (const codexConfig of ['k=v', ['k=v'], 7]) {
    const r = await collectLaunchContext({ sid: 's' }, { ext: registry(['y', () => ({ codexConfig })]), onError: odd.onError });
    assert.deepEqual(r, { env: {}, addDirs: [] });
  }
  assert.deepEqual(launchCodexConfigArgs({ codexConfig: { sandbox_mode: 'danger-full-access', 'x y': 1, ok: 'a"b\\c' } }), ['-c', 'ok="a\\"b\\\\c"'], 'the builder re-validates and quotes');
});

test('codexConfig: Claude launches and launches without the field are unchanged', async () => {
  const without = { env: { AW_X: '1' }, addDirs: ['/d'] };
  const withIt = { ...without, codexConfig: KEYRING };
  for (const [name, build] of Object.entries(BUILDERS)) {
    if (name.startsWith('claude') || name.startsWith('devcontainer')) assert.equal(await build(withIt), await build(without), `${name} ignores codexConfig`);
    else assert.equal(await build({ ...without, codexConfig: {} }), await build(without), `${name} with an empty field`);
  }
  for (const name of ['codex buildLaunch', 'codex buildResume', 'codex buildFork']) {
    assert.doesNotMatch(BUILDERS[name](without), /cli_auth_credentials_store/);
  }
  const plain = await collectLaunchContext({ sid: 'p' }, { ext: registry(['a', () => ({ env: { AW_X: '1' } })], ['b', () => ({ codexConfig: {} })]), onError: () => {} });
  assert.deepEqual(plain, { env: { AW_X: '1' }, addDirs: [] }, 'no codexConfig key when nothing survives');
  assert.deepEqual(launchCodexConfigArgs(undefined), []);
  assert.deepEqual(launchCodexConfigArgs({ env: {}, addDirs: [] }), []);
});
