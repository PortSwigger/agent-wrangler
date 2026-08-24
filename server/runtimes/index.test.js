import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runtimeFor, DEFAULT_RUNTIME } from './index.js';

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

test('cloud: resolves, skips the host resume guard, and REPLACES the launch build', async () => {
  const c = runtimeFor('cloud');
  assert.equal(c.id, 'cloud');
  assert.equal(c.skipsHostResumeGuard, true);
  // buildLaunch is the new optional capability: cloud defines it because a cloud
  // launch is a different claude invocation, not a decoration of the local one.
  assert.equal(typeof c.buildLaunch, 'function');
  // …so wrapLaunch must stay the identity, or the command would be built twice.
  assert.equal(await c.wrapLaunch({ inner: 'claude --cloud x' }), 'claude --cloud x');
});

// The truthiness matters, not just the values: state-reader reads
// `(runtime.analyze ? await runtime.analyze(…) : null) || <host scan>`, so a falsey
// result silently re-enables the very host-transcript scan cloud must never do.
test('cloud: analyze returns a TRUTHY empty analysis (no host fall-through) and there is no readLive', async () => {
  const c = runtimeFor('cloud');
  const enr = await c.analyze({ entry: { cwd: '/x' }, liveSid: null });
  assert.ok(enr, 'must be truthy so the || in state-reader short-circuits');
  assert.deepEqual(enr, { usd: null, subAgentUsd: 0, advisorUsd: 0, tokens: null, subAgents: [] });
  assert.equal(c.readLive, undefined);
});

test('only cloud defines buildLaunch — a runtime that merely decorates stays on wrapLaunch', () => {
  assert.equal(runtimeFor('local').buildLaunch, undefined);
  assert.equal(runtimeFor('devcontainer').buildLaunch, undefined);
});
