import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  collectLaunchContext, lastLaunchContext, launchEnvPrefix, launchAddDirArgs, launchEnvOf, launchAddDirsOf,
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
  assert.deepEqual(LAUNCH_REASONS, ['dispatch', 'resume', 'fork', 'message', 'snooze-wake', 'spawn', 'assign', 'adopt']);
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
  assert.deepEqual(seen, [{ sid: 'S1', task: { id: 'T1', name: 'n' }, agent: 'codex', runtime: 'devcontainer', reason: 'resume', host: { id: 'host-a' } }]);
});

test('defaults: claude, local, dispatch, no task', async () => {
  let got;
  await collectLaunchContext({ sid: 's' }, { ext: registry(['a', (c) => { got = c; }]), onError: () => {} });
  assert.deepEqual({ ...got, host: undefined }, { sid: 's', task: null, agent: 'claude', runtime: 'local', reason: 'dispatch', host: undefined });
});

test('the last answer is remembered per session (what paste-store reads), and an unknown session reads as empty', async () => {
  _resetLaunchContextForTests();
  assert.equal(lastLaunchContext('nope'), EMPTY_LAUNCH_CONTEXT);
  await collectLaunchContext({ sid: 'remembered' }, { ext: registry(['a', () => ({ addDirs: ['/granted'] })]), onError: () => {} });
  assert.deepEqual(lastLaunchContext('remembered').addDirs, ['/granted']);
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

for (const reason of LAUNCH_REASONS) {
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
