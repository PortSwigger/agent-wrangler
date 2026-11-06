import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CODEX_SANDBOXES, CODEX_APPROVALS, INCOMPATIBLE, normalizeCodexPolicy, codexPolicyArgs, cleanCodexPolicy, codexPolicyAllowsAddDirs } from './codex-policy.js';

function norm(raw) {
  const logs = [];
  const out = normalizeCodexPolicy(raw, { extId: 'x', onError: (m) => logs.push(m) });
  return { out, logs };
}

const NET = ['-c', 'sandbox_workspace_write.network_access=true'];

test('every enum value is accepted', () => {
  for (const sandbox of CODEX_SANDBOXES) assert.deepEqual(norm({ sandbox }).out, { sandbox });
  for (const approval of CODEX_APPROVALS) assert.deepEqual(norm({ approval }).out, { approval });
  assert.deepEqual(norm({ approveForMe: true }).out, { approveForMe: true });
  assert.deepEqual(norm({ bypass: true }).out, { bypass: true });
});

test('nothing answered means core defaults', () => {
  for (const raw of [undefined, null, {}, { approveForMe: false, bypass: false }]) {
    const { out, logs } = norm(raw);
    assert.equal(out, undefined);
    assert.deepEqual(logs, []);
  }
});

test('a non-object answer is logged and rejected', () => {
  for (const raw of ['read-only', 3, true, [], ['read-only'], Promise.resolve({ sandbox: 'read-only' })]) {
    const { out, logs } = norm(raw);
    assert.equal(out, undefined);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /^\[ext:x\] codexPolicy:/);
  }
});

test('a bad or unknown field is dropped with a log and the rest still applies', () => {
  const { out, logs } = norm({ sandbox: 'nope', approval: 'on-request', approveForMe: 'yes', colour: 'red' });
  assert.deepEqual(out, { approval: 'on-request' });
  assert.deepEqual(logs, [
    '[ext:x] codexPolicy: dropped sandbox="nope"',
    '[ext:x] codexPolicy: dropped approveForMe="yes"',
    '[ext:x] codexPolicy: dropped colour="red"',
  ]);
});

test('bypass wins outright and silently ignores the other fields', () => {
  const { out, logs } = norm({ bypass: true, sandbox: 'read-only', approval: 'on-request', approveForMe: true });
  assert.deepEqual(out, { bypass: true });
  assert.deepEqual(logs, []);
});

test('INCOMPATIBLE: approve-for-me against a sandbox other than workspace-write drops approve-for-me', () => {
  for (const sandbox of ['read-only', 'danger-full-access']) {
    const { out, logs } = norm({ sandbox, approveForMe: true });
    assert.deepEqual(out, { sandbox });
    assert.match(logs[0], /dropped approveForMe=true \(approve-for-me implies sandbox workspace-write\)/);
  }
});

test('INCOMPATIBLE: approve-for-me against approval never drops approve-for-me', () => {
  const { out, logs } = norm({ approval: 'never', approveForMe: true });
  assert.deepEqual(out, { approval: 'never' });
  assert.match(logs[0], /dropped approveForMe=true \(approve-for-me implies approval on-request\)/);
});

test('approve-for-me with the values it implies is compatible', () => {
  const { out, logs } = norm({ sandbox: 'workspace-write', approval: 'on-request', approveForMe: true });
  assert.deepEqual(out, { sandbox: 'workspace-write', approval: 'on-request', approveForMe: true });
  assert.deepEqual(logs, []);
  assert.equal(INCOMPATIBLE.length, 2);
});

test('codexPolicyArgs: undefined is byte-identical to the historical defaults', () => {
  assert.deepEqual(codexPolicyArgs(undefined), ['--sandbox', 'workspace-write', '--ask-for-approval', 'never', ...NET]);
  assert.deepEqual(codexPolicyArgs({}), codexPolicyArgs(undefined));
});

test('codexPolicyArgs: each sandbox, network grant only under workspace-write', () => {
  assert.deepEqual(codexPolicyArgs({ sandbox: 'read-only' }), ['--sandbox', 'read-only', '--ask-for-approval', 'never']);
  assert.deepEqual(codexPolicyArgs({ sandbox: 'workspace-write' }), ['--sandbox', 'workspace-write', '--ask-for-approval', 'never', ...NET]);
  assert.deepEqual(codexPolicyArgs({ sandbox: 'danger-full-access' }), ['--sandbox', 'danger-full-access', '--ask-for-approval', 'never']);
});

test('codexPolicyArgs: each approval', () => {
  assert.deepEqual(codexPolicyArgs({ approval: 'on-request' }), ['--sandbox', 'workspace-write', '--ask-for-approval', 'on-request', ...NET]);
  assert.deepEqual(codexPolicyArgs({ approval: 'never' }), codexPolicyArgs(undefined));
});

test('codexPolicyArgs: approve-for-me stands alone (codex rejects it beside -s/-a) and keeps the grant', () => {
  assert.deepEqual(codexPolicyArgs({ approveForMe: true }), ['--approve-for-me', ...NET]);
  assert.deepEqual(codexPolicyArgs({ sandbox: 'workspace-write', approval: 'on-request', approveForMe: true }), ['--approve-for-me', ...NET]);
});

test('codexPolicyArgs: bypass is the only flag', () => {
  assert.deepEqual(codexPolicyArgs({ bypass: true }), ['--dangerously-bypass-approvals-and-sandbox']);
});

test('cleanCodexPolicy: empty values and unticked boxes are unset, stray fields dropped quietly', () => {
  assert.equal(cleanCodexPolicy(undefined), undefined);
  assert.equal(cleanCodexPolicy([]), undefined);
  assert.equal(cleanCodexPolicy({ sandbox: '', approval: '', approveForMe: false, bypass: false }), undefined);
  assert.deepEqual(cleanCodexPolicy({ sandbox: 'read-only', approval: 'never', approveForMe: false, bypass: false, colour: 'red' }), { sandbox: 'read-only', approval: 'never' });
  assert.deepEqual(cleanCodexPolicy({ sandbox: 'nope', approval: 'on-request' }), { approval: 'on-request' });
});

test('cleanCodexPolicy: approve-for-me replaces sandbox and approval; bypass replaces everything', () => {
  assert.deepEqual(cleanCodexPolicy({ sandbox: 'read-only', approval: 'never', approveForMe: true }), { approveForMe: true });
  assert.deepEqual(cleanCodexPolicy({ sandbox: 'read-only', approveForMe: true, bypass: true }), { bypass: true });
});

test('cleanCodexPolicy of the shipped Settings defaults launches byte-identical to no policy', () => {
  const p = cleanCodexPolicy({ sandbox: 'workspace-write', approval: 'never', approveForMe: false, bypass: false });
  assert.deepEqual(codexPolicyArgs(p), codexPolicyArgs(undefined));
});

test('codexPolicyAllowsAddDirs: only a read-only sandbox refuses them', () => {
  assert.equal(codexPolicyAllowsAddDirs(undefined), true);
  assert.equal(codexPolicyAllowsAddDirs({ sandbox: 'workspace-write' }), true);
  assert.equal(codexPolicyAllowsAddDirs({ sandbox: 'danger-full-access' }), true);
  assert.equal(codexPolicyAllowsAddDirs({ sandbox: 'read-only', approval: 'never' }), false);
  assert.equal(codexPolicyAllowsAddDirs({ approveForMe: true }), true);
  assert.equal(codexPolicyAllowsAddDirs({ bypass: true }), true);
});
