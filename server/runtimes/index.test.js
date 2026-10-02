import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  runtimeFor, findRuntime, DEFAULT_RUNTIME, BUILTIN_RUNTIME_IDS,
  registerRuntime, unregisterRuntimesFor, knownRuntimes, relaunchRefusal,
} from './index.js';

test('runtimeFor: absent id resolves to local', () => {
  assert.equal(runtimeFor(undefined).id, 'local');
  assert.equal(runtimeFor('').id, 'local');
  assert.equal(DEFAULT_RUNTIME, 'local');
});

test('runtimeFor: local is a pass-through wrapLaunch', async () => {
  const cmd = await runtimeFor('local').wrapLaunch({ inner: 'claude --foo', cwd: '/x', sessionId: 's1' });
  assert.equal(cmd, 'claude --foo');
});

test('runtimeFor: unknown runtime id throws (fails closed)', () => {
  assert.throws(() => runtimeFor('bogus'), /unknown runtime/i);
});

test('local: no read hooks, does not skip the host resume guard', () => {
  const l = runtimeFor('local');
  assert.equal(l.readLive, undefined);
  assert.equal(l.analyze, undefined);
  assert.equal(l.skipsHostResumeGuard ?? false, false);
});

test('devcontainer: skips the host resume guard', () => {
  assert.equal(runtimeFor('devcontainer').skipsHostResumeGuard, true);
});

test('built-ins carry labels and are listed as BUILTIN_RUNTIME_IDS', () => {
  assert.deepEqual(BUILTIN_RUNTIME_IDS, ['local', 'devcontainer']);
  assert.equal(runtimeFor('local').label, 'Local (host)');
  assert.equal(runtimeFor('devcontainer').label, 'Devcontainer');
});

test('an extension runtime resolves after register and is gone after unregister', () => {
  const toy = { id: 'toyrt', label: 'Toy', wrapLaunch: async ({ inner }) => `echo hi && ${inner}` };
  registerRuntime(toy, 'toy-ext');
  try {
    assert.equal(runtimeFor('toyrt').label, 'Toy');
    assert.equal(findRuntime('toyrt').extId, 'toy-ext');
    assert.deepEqual(knownRuntimes().map((r) => r.id), ['local', 'devcontainer', 'toyrt']);
    assert.equal(knownRuntimes().find((r) => r.id === 'toyrt').extId, 'toy-ext');
    assert.throws(() => registerRuntime({ ...toy }, 'other'), /already registered/);
  } finally {
    unregisterRuntimesFor('toy-ext');
  }
  assert.equal(findRuntime('toyrt'), null);
  assert.throws(() => runtimeFor('toyrt'), /unknown runtime: toyrt/);
});

test('registerRuntime refuses a built-in id', () => {
  assert.throws(() => registerRuntime({ id: 'local', label: 'x', wrapLaunch: async () => '' }, 'e'), /already registered/);
  assert.equal(runtimeFor('local').extId, undefined);
});

test('findRuntime: null for unknown, local for absent', () => {
  assert.equal(findRuntime('bogus'), null);
  assert.equal(findRuntime(undefined).id, 'local');
});

test('relaunchRefusal: resumable, resumable:false, missing with and without runtimeExt', () => {
  assert.equal(relaunchRefusal({}), null);
  assert.equal(relaunchRefusal({ runtime: 'devcontainer' }), null);
  registerRuntime({ id: 'cloud', label: '☁ Cloud', resumable: false, buildLaunch: async () => '' }, 'cloud');
  try {
    assert.equal(relaunchRefusal({ runtime: 'cloud', runtimeExt: 'cloud' }), '"☁ Cloud" sessions can\'t be resumed or forked');
  } finally {
    unregisterRuntimesFor('cloud');
  }
  assert.equal(
    relaunchRefusal({ runtime: 'cloud', runtimeExt: 'cloud' }),
    'This session runs on runtime "cloud", which needs the "cloud" extension. Enable it in Settings → Extensions.',
  );
  assert.match(relaunchRefusal({ runtime: 'cloud' }), /runtime "cloud", which is not available/);
});
