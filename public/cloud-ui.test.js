import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  destinationFieldVisibility, cloudPreflightPills, cloudPreflightBlocks, cloudEnvLabel,
  cloudCardActions, cloudResumeBlocked, sanitizeCloudEnvironments,
  NO_LOCAL_CHECKOUT_REASON, ATTACH_UNSUPPORTED_REASON,
} from './cloud-ui.js';

// --- destinationFieldVisibility ---

test('destinationFieldVisibility: local launch shows the worktree box, no cloud fields', () => {
  const v = destinationFieldVisibility({ dest: 'local', agent: 'claude', mode: 'launch' });
  assert.equal(v.destRowVisible, true);
  assert.equal(v.effectiveDest, 'local');
  assert.equal(v.worktreeBox, true);
  assert.equal(v.cloudEnv, false);
  assert.equal(v.cloudRef, false);
  assert.equal(v.cloudMsg, false);
  assert.equal(v.workflowEnabled, true);
  assert.equal(v.workflowDisabledReason, null);
});

test('destinationFieldVisibility: cloud hides the worktree box and disables workflow', () => {
  const v = destinationFieldVisibility({ dest: 'cloud', agent: 'claude', mode: 'launch' });
  assert.equal(v.effectiveDest, 'cloud');
  assert.equal(v.worktreeBox, false); // a cloud session has no local checkout
  assert.equal(v.cloudEnv, true);
  assert.equal(v.cloudRef, true);
  assert.equal(v.cloudMsg, true);
  assert.equal(v.workflowEnabled, false);
  assert.match(v.workflowDisabledReason, /plugin dir/);
});

test('destinationFieldVisibility: devcontainer keeps the worktree box and workflow', () => {
  const v = destinationFieldVisibility({ dest: 'devcontainer', agent: 'claude', mode: 'launch' });
  assert.equal(v.effectiveDest, 'devcontainer');
  assert.equal(v.worktreeBox, true);
  assert.equal(v.cloudEnv, false);
  assert.equal(v.workflowEnabled, true);
});

test('destinationFieldVisibility: a non-Claude agent snaps a stale cloud selection to local', () => {
  const v = destinationFieldVisibility({ dest: 'cloud', agent: 'codex', mode: 'launch' });
  assert.equal(v.effectiveDest, 'local');
  assert.equal(v.cloudCardEnabled, false);
  assert.equal(v.devcontainerCardEnabled, false);
  assert.equal(v.destRowVisible, true); // the row is still there — the cards are dead
  // …and the fields that only exist for cloud go with it.
  assert.equal(v.cloudEnv, false);
  assert.equal(v.worktreeBox, true);
  assert.equal(v.workflowEnabled, true);
});

test('destinationFieldVisibility: a non-Claude agent also snaps devcontainer to local', () => {
  const v = destinationFieldVisibility({ dest: 'devcontainer', agent: 'codex', mode: 'launch' });
  assert.equal(v.effectiveDest, 'local');
});

test('destinationFieldVisibility: the destination row is hidden only for fork / sub-agent', () => {
  for (const mode of ['fork', 'subagent']) {
    assert.equal(destinationFieldVisibility({ mode }).destRowVisible, false, mode);
  }
  // …and stays visible for a scheduled dispatch, exactly as the old <select> did
  // (a scheduled devcontainer run is an existing feature).
  for (const mode of ['launch', 'schedule-create', 'schedule-edit']) {
    assert.equal(destinationFieldVisibility({ mode }).destRowVisible, true, mode);
  }
});

test('destinationFieldVisibility: a scheduled dispatch can still pick devcontainer', () => {
  const v = destinationFieldVisibility({ dest: 'devcontainer', agent: 'claude', mode: 'schedule-create' });
  assert.equal(v.effectiveDest, 'devcontainer');
  assert.equal(v.devcontainerCardEnabled, true);
});

test('destinationFieldVisibility: a schedule can NEVER pick cloud (out of scope for v1)', () => {
  for (const mode of ['schedule-create', 'schedule-edit']) {
    const v = destinationFieldVisibility({ dest: 'cloud', agent: 'claude', mode });
    assert.equal(v.cloudCardEnabled, false, mode);
    assert.equal(v.effectiveDest, 'local', mode); // a stale saved 'cloud' snaps back
    assert.equal(v.cloudEnv, false, mode);
    assert.equal(v.workflowEnabled, true, mode);
  }
});

test('destinationFieldVisibility: workflow and review mode still hide the worktree box', () => {
  assert.equal(destinationFieldVisibility({ dispatchMode: 'workflow' }).worktreeBox, false);
  assert.equal(destinationFieldVisibility({ reviewMode: true }).worktreeBox, false);
});

// --- cloudPreflightPills ---

test('cloudPreflightPills: refusals render red and block, warnings amber and do not', () => {
  const pills = cloudPreflightPills({
    refusals: [{ code: 'no-origin', message: 'No GitHub origin remote' }],
    warnings: [{ code: 'dirty', message: 'Working tree is dirty' }],
  });
  assert.deepEqual(pills, [
    { cls: 'error', text: 'No GitHub origin remote', blocks: true },
    { cls: 'warn', text: 'Working tree is dirty', blocks: false },
  ]);
});

test('cloudPreflightPills: refusals come first regardless of input order', () => {
  const pills = cloudPreflightPills({
    warnings: [{ message: 'unpushed commits' }],
    refusals: [{ message: 'codex is not supported in the cloud' }],
  });
  assert.equal(pills[0].cls, 'error');
  assert.equal(pills[1].cls, 'warn');
});

test('cloudPreflightPills: tolerates bare strings, empties and missing fields', () => {
  assert.deepEqual(cloudPreflightPills(), []);
  assert.deepEqual(cloudPreflightPills({}), []);
  assert.deepEqual(cloudPreflightPills({ refusals: ['boom'] }), [{ cls: 'error', text: 'boom', blocks: true }]);
  // A message-less entry renders nothing rather than an empty red pill.
  assert.deepEqual(cloudPreflightPills({ refusals: [{ code: 'x' }], warnings: [null] }), []);
});

test('cloudPreflightBlocks: only a standing refusal disables Launch', () => {
  assert.equal(cloudPreflightBlocks({ refusals: [{ message: 'nope' }] }), true);
  assert.equal(cloudPreflightBlocks({ warnings: [{ message: 'dirty' }] }), false);
  assert.equal(cloudPreflightBlocks({ refusals: [], warnings: [] }), false);
  assert.equal(cloudPreflightBlocks(undefined), false);
});

// --- cloudEnvLabel ---

test('cloudEnvLabel: null/empty is the account default', () => {
  assert.equal(cloudEnvLabel(null, []), 'Account default');
  assert.equal(cloudEnvLabel('', [{ label: 'Prod', id: 'env_1' }]), 'Account default');
  assert.equal(cloudEnvLabel(undefined), 'Account default');
});

test('cloudEnvLabel: a registered id resolves to its label, an unknown one to the raw id', () => {
  const envs = [{ label: 'Anthropic prod', id: 'env_abc' }, { label: 'Runner pool', id: 'ccpool_x' }];
  assert.equal(cloudEnvLabel('env_abc', envs), 'Anthropic prod');
  assert.equal(cloudEnvLabel('ccpool_x', envs), 'Runner pool');
  assert.equal(cloudEnvLabel('env_gone', envs), 'env_gone');
  assert.equal(cloudEnvLabel('env_gone'), 'env_gone');
});

// --- cloudCardActions ---

test('cloudCardActions: send/teleport/archive live, diff+terminal disabled with reasons', () => {
  const items = cloudCardActions({ s: { runtime: 'cloud', cloud: {} }, attachSupported: false });
  const byId = new Map(items.map((i) => [i.id, i]));
  assert.deepEqual([...byId.keys()], ['send-message', 'teleport', 'view-diff', 'open-terminal', 'archive']);
  assert.equal(byId.get('send-message').disabled, false);
  assert.equal(byId.get('teleport').disabled, false);
  assert.equal(byId.get('archive').disabled, false);
  assert.equal(byId.get('view-diff').disabled, true);
  assert.equal(byId.get('view-diff').title, NO_LOCAL_CHECKOUT_REASON);
  assert.equal(byId.get('open-terminal').disabled, true);
  assert.equal(byId.get('open-terminal').title, ATTACH_UNSUPPORTED_REASON);
});

test('cloudCardActions: fork / restart / peer review are never offered for cloud', () => {
  const labels = cloudCardActions({ s: { runtime: 'cloud' } }).map((i) => i.label.toLowerCase());
  for (const gone of ['fork', 'restart', 'peer review']) {
    assert.ok(!labels.some((l) => l.includes(gone)), `${gone} must be omitted`);
  }
});

test('cloudCardActions: the attach gate is the only thing that enables Open terminal', () => {
  const term = cloudCardActions({ s: { runtime: 'cloud' }, attachSupported: true })
    .find((i) => i.id === 'open-terminal');
  assert.equal(term.disabled, false);
  assert.equal(term.title, null);
  // View diff stays disabled — attach does not create a local checkout.
  const diff = cloudCardActions({ s: { runtime: 'cloud' }, attachSupported: true })
    .find((i) => i.id === 'view-diff');
  assert.equal(diff.disabled, true);
});

test('cloudCardActions: an archived cloud session can no longer be steered', () => {
  const msg = cloudCardActions({ s: { runtime: 'cloud', cloud: { archivedAt: 123 } } })
    .find((i) => i.id === 'send-message');
  assert.equal(msg.disabled, true);
  assert.match(msg.title, /archived/);
});

// --- cloudResumeBlocked ---

test('cloudResumeBlocked: true only for a cloud card with the gate off', () => {
  assert.equal(cloudResumeBlocked({ s: { runtime: 'cloud' }, attachSupported: false }), true);
  assert.equal(cloudResumeBlocked({ s: { runtime: 'cloud' }, attachSupported: true }), false);
  assert.equal(cloudResumeBlocked({ s: { runtime: 'devcontainer' }, attachSupported: false }), false);
  assert.equal(cloudResumeBlocked({ s: {}, attachSupported: false }), false);
  assert.equal(cloudResumeBlocked(), false);
});

// --- sanitizeCloudEnvironments ---

test('sanitizeCloudEnvironments: keeps well-formed env_/ccpool_ rows', () => {
  const { environments, dropped } = sanitizeCloudEnvironments([
    { label: 'Prod', id: 'env_abc' },
    { label: '  Runner  ', id: '  ccpool_xyz ' },
  ]);
  assert.deepEqual(environments, [{ label: 'Prod', id: 'env_abc' }, { label: 'Runner', id: 'ccpool_xyz' }]);
  assert.deepEqual(dropped, []);
});

test('sanitizeCloudEnvironments: a bad prefix or missing label is dropped WITH a reason', () => {
  const { environments, dropped } = sanitizeCloudEnvironments([
    { label: 'Typo', id: 'evn_abc' },
    { label: '', id: 'env_ok' },
    { label: 'Good', id: 'env_good' },
  ]);
  assert.deepEqual(environments, [{ label: 'Good', id: 'env_good' }]);
  assert.equal(dropped.length, 2);
  assert.match(dropped[0].reason, /env_ or ccpool_/);
  assert.match(dropped[1].reason, /label/);
});

test('sanitizeCloudEnvironments: a fully blank row is the empty add-form, not an error', () => {
  const { environments, dropped } = sanitizeCloudEnvironments([{ label: '', id: '' }, {}, null]);
  assert.deepEqual(environments, []);
  assert.deepEqual(dropped, []);
});

test('sanitizeCloudEnvironments: a duplicate id is dropped so the dropdown stays unambiguous', () => {
  const { environments, dropped } = sanitizeCloudEnvironments([
    { label: 'One', id: 'env_a' },
    { label: 'Two', id: 'env_a' },
  ]);
  assert.deepEqual(environments, [{ label: 'One', id: 'env_a' }]);
  assert.equal(dropped.length, 1);
  assert.match(dropped[0].reason, /duplicate/);
});

test('sanitizeCloudEnvironments: no rows at all', () => {
  assert.deepEqual(sanitizeCloudEnvironments(), { environments: [], dropped: [] });
  assert.deepEqual(sanitizeCloudEnvironments([]), { environments: [], dropped: [] });
});
