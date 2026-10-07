import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readInstallEnv, stripInstallEnv, INSTALL_SCOPED_ENV } from './install-env.js';

test('signals parse strictly: only exactly 1 turns a flag on', () => {
  assert.deepEqual(readInstallEnv({}), { supervised: false, installManager: null, gitUpdates: false, installRoot: null });
  assert.deepEqual(
    readInstallEnv({ AW_SUPERVISED: '1', AW_GIT_UPDATES: '1', AW_INSTALL_MANAGER: ' homebrew ', AW_INSTALL_ROOT: '/opt/homebrew/opt/agent-wrangler/libexec' }),
    { supervised: true, installManager: 'homebrew', gitUpdates: true, installRoot: '/opt/homebrew/opt/agent-wrangler/libexec' },
  );
  for (const v of ['0', 'true', 'yes', '']) {
    const got = readInstallEnv({ AW_SUPERVISED: v, AW_GIT_UPDATES: v, AW_INSTALL_MANAGER: v === '' ? '  ' : undefined });
    assert.equal(got.supervised, false, `AW_SUPERVISED=${v}`);
    assert.equal(got.gitUpdates, false, `AW_GIT_UPDATES=${v}`);
    assert.equal(got.installManager, null);
  }
});

test('every install-scoped signal is removed, and nothing else', () => {
  const env = Object.fromEntries(INSTALL_SCOPED_ENV.map((n) => [n, 'x']));
  Object.assign(env, { AW_DEV: '1', AW_DATA_DIR: '/d', AW_LOG_DIR: '/l', PATH: '/bin' });
  stripInstallEnv(env);
  assert.deepEqual(env, { AW_DEV: '1', AW_DATA_DIR: '/d', AW_LOG_DIR: '/l', PATH: '/bin' });
});

// The covered set is the documented contract (docs/install-signals.md); task 06
// and the Homebrew formula rely on AW_INSTALL_ROOT and AW_NODE being in it.
test('the covered signals are the documented ones', () => {
  assert.deepEqual([...INSTALL_SCOPED_ENV].sort(), ['AW_GIT_UPDATES', 'AW_INSTALL_MANAGER', 'AW_INSTALL_ROOT', 'AW_LOGS_TRIMMED', 'AW_NODE', 'AW_SUPERVISED']);
});

test('importing the module strips the real process env', async () => {
  const { execFileSync } = await import('node:child_process');
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', `
    const { INSTALL_ENV } = await import(${JSON.stringify(new URL('./install-env.js', import.meta.url).href)});
    console.log(JSON.stringify({ INSTALL_ENV, left: Object.keys(process.env).filter((k) => ${JSON.stringify(INSTALL_SCOPED_ENV)}.includes(k)) }));
  `], { encoding: 'utf8', env: { PATH: process.env.PATH, AW_SUPERVISED: '1', AW_INSTALL_MANAGER: 'homebrew', AW_NODE: '/n', AW_LOGS_TRIMMED: '1' } });
  const { INSTALL_ENV, left } = JSON.parse(out);
  assert.equal(INSTALL_ENV.supervised, true);
  assert.equal(INSTALL_ENV.installManager, 'homebrew');
  assert.deepEqual(left, []);
});
