import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { cloudPreflightHandler } from './cloud-preflight.js';

function ctx() {
  const sent = [];
  return { sent, reply: (o) => sent.push(o) };
}

// Records the bag the handler forwards, and replies with whatever this test wants.
function stub(result = { refusals: [], warnings: [] }) {
  const seen = [];
  return {
    seen,
    deps: { cloudPreflight: async (args) => { seen.push(args); return result; } },
  };
}

test('cloud-preflight: a clean preflight replies ok with empty lists', async () => {
  const c = ctx();
  const s = stub();
  await cloudPreflightHandler.handler({ type: 'cloud-preflight', cwd: '/repo' }, c, s.deps);
  assert.deepEqual(c.sent, [{
    type: 'cloud-preflight-result', ok: true, refusals: [], warnings: [],
    cwd: '/repo', environmentId: '', ref: '', agent: 'claude', workflow: false,
  }]);
});

// The dialog keys every reply on exactly what it sent, dropping any answer for a
// form it has since moved past — so the echo must be the RAW request, not the
// tilde-expanded cwd git actually saw. Echo the expanded one and the key never
// matches, silently discarding every reply.
test('cloud-preflight: echoes the request verbatim, un-expanded, so the dialog can key on it', async () => {
  const c = ctx();
  const s = stub();
  await cloudPreflightHandler.handler({
    type: 'cloud-preflight', cwd: '~/src/widgets', environmentId: 'env_9', ref: 'main', agent: 'claude', workflow: false,
  }, c, s.deps);
  assert.equal(c.sent[0].cwd, '~/src/widgets');
  assert.equal(c.sent[0].environmentId, 'env_9');
  assert.equal(c.sent[0].ref, 'main');
  assert.notEqual(s.seen[0].cwd, c.sent[0].cwd); // git saw the expanded path
});

test('cloud-preflight: any refusal flips ok to false and is passed through verbatim', async () => {
  const c = ctx();
  const refusals = [{ code: 'cloud-codex', message: 'Cloud sessions are Claude-only.' }];
  const s = stub({ refusals, warnings: [] });
  await cloudPreflightHandler.handler({ type: 'cloud-preflight', cwd: '/repo', agent: 'codex' }, c, s.deps);
  assert.equal(c.sent[0].ok, false);
  assert.deepEqual(c.sent[0].refusals, refusals);
});

test('cloud-preflight: warnings alone stay ok:true', async () => {
  const c = ctx();
  const warnings = [{ code: 'cloud-dirty', message: 'Uncommitted local changes.' }];
  const s = stub({ refusals: [], warnings });
  await cloudPreflightHandler.handler({ type: 'cloud-preflight', cwd: '/repo' }, c, s.deps);
  assert.equal(c.sent[0].ok, true);
  assert.deepEqual(c.sent[0].warnings, warnings);
});

test('cloud-preflight: forwards the whole dialog bag, defaulting agent to claude', async () => {
  const c = ctx();
  const s = stub();
  await cloudPreflightHandler.handler({
    type: 'cloud-preflight', cwd: '/repo', environmentId: ' ccpool_x ', ref: ' main ', workflow: 1,
  }, c, s.deps);
  assert.deepEqual(s.seen, [{
    cwd: '/repo', agent: 'claude', workflow: true, environmentId: 'ccpool_x', ref: 'main',
  }]);
});

test('cloud-preflight: a leading ~ in cwd is expanded before git ever sees it', async () => {
  const c = ctx();
  const s = stub();
  await cloudPreflightHandler.handler({ type: 'cloud-preflight', cwd: '~/src/widgets' }, c, s.deps);
  assert.equal(s.seen[0].cwd, path.join(os.homedir(), 'src/widgets'));
});

test('cloud-preflight: a missing cwd is forwarded as empty, not undefined', async () => {
  const c = ctx();
  const s = stub({ refusals: [{ code: 'cloud-not-git', message: 'No folder selected.' }], warnings: [] });
  await cloudPreflightHandler.handler({ type: 'cloud-preflight' }, c, s.deps);
  assert.equal(s.seen[0].cwd, '');
  assert.equal(c.sent[0].ok, false);
});

test('cloud-preflight: registered under the type the client sends', () => {
  assert.equal(cloudPreflightHandler.type, 'cloud-preflight');
});
