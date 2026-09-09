import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateAmendment, classifyOp, classifyAmendment, authorityPermits, describeAmendment, amendmentTargets } from './job-amendments.js';
import { amendmentSchema, amendmentOpSchema, reportSchema } from './jobs-schema.js';

const sub = (id, extra = {}) => ({ id, title: `Deliver ${id}`, kind: 'pr', repo: '/repo', storyId: 'story', jiraKey: 'AUTH-1', dependsOn: [], instructions: `Implement ${id}`,
  deployment: { verify: 'Check it' }, stage: 'implementation', state: 'queued', local: null, ...extra });
const session = (id, extra = {}) => ({ id, title: `Run ${id}`, kind: 'session', storyId: 'story', jiraKey: 'AUTH-1', dependsOn: [], instructions: `Do ${id}`, stage: 'session', ...extra });
const job = (subJobs, extra = {}) => ({ stage: 'active', plan: { stories: [{ id: 'story', key: 'AUTH-1', title: 't', value: 'v' }, { id: 'newstory', title: 'n', value: 'v' }], subJobs: subJobs.map(({ stage, state, local, ...s }) => s) }, subJobs, runs: [], ...extra });
const spec = (id, dependsOn = []) => ({ id, title: `Deliver ${id}`, kind: 'pr', repo: '/repo', storyId: 'story', dependsOn, instructions: 'x' });

test('the op vocabulary is closed: nothing can touch repo, kind, story, branch or the ledger', () => {
  for (const op of [{ op: 'set-repo', subJobId: 'a', repo: '/x' }, { op: 'set-kind', subJobId: 'a', kind: 'session' }, { op: 'set-story', subJobId: 'a', storyId: 's' }, { op: 'set-branch', subJobId: 'a', branch: 'b' }, { op: 'set-deployed', subJobId: 'a', deployed: {} }, { op: 'clear-receipt', subJobId: 'a' }]) {
    assert.equal(amendmentOpSchema.safeParse(op).success, false, op.op);
  }
  assert.equal(amendmentSchema.safeParse({ reason: 'why', ops: [] }).success, false, 'an amendment needs at least one op');
  assert.equal(amendmentSchema.safeParse({ reason: 'two\nlines', ops: [{ op: 'add-dependency', subJobId: 'a', dependsOn: 'b' }] }).success, false, 'the reason is one line');
  const parsed = amendmentOpSchema.parse({ op: 'add-sub-job', spec: { ...spec('n'), branch: 'feat/x', stage: 'done', deployed: { at: 1 } } });
  assert.equal('branch' in parsed.spec, false); assert.equal('stage' in parsed.spec, false); assert.equal('deployed' in parsed.spec, false, 'a spec carries plan fields only');
  assert.equal(reportSchema.parse({ kind: 'blocked', summary: 's', amendment: { reason: 'r', ops: [{ op: 'set-deployment', subJobId: 'a', deployment: null }] } }).amendment.ops[0].deployment, null);
  assert.equal(reportSchema.safeParse({ kind: 'local', commitMessage: 'A-1: x', checks: ['ok'], amendment: { reason: 'r', ops: [{ op: 'nope' }] } }).success, false, 'a bad amendment fails the receipt');
});

test('ops apply to a projection of the live plan and the approved plan rules judge the result', () => {
  const j = job([sub('a'), sub('b'), sub('c', { dependsOn: ['b'] })]);
  assert.match(validateAmendment(j, [{ op: 'add-dependency', subJobId: 'b', dependsOn: 'c' }]).error, /cycles/);
  assert.match(validateAmendment(j, [{ op: 'add-dependency', subJobId: 'a', dependsOn: 'zz' }]).error, /Unknown dependency: zz/);
  assert.match(validateAmendment(j, [{ op: 'add-dependency', subJobId: 'a', dependsOn: 'a' }]).error, /Change 1 \(add-dependency on Deliver a\): a sub-job cannot depend on itself/);
  assert.match(validateAmendment(j, [{ op: 'add-dependency', subJobId: 'c', dependsOn: 'b' }]).error, /already depends on b/);
  assert.match(validateAmendment(j, [{ op: 'remove-dependency', subJobId: 'a', dependsOn: 'b' }]).error, /does not depend on b/);
  assert.match(validateAmendment(j, [{ op: 'add-sub-job', spec: spec('a') }]).error, /already exists/);
  assert.match(validateAmendment(j, [{ op: 'add-sub-job', spec: { ...spec('d'), storyId: 'nope' } }]).error, /unknown story nope/);
  assert.match(validateAmendment(j, [{ op: 'add-sub-job', spec: { ...spec('d'), storyId: 'newstory' } }]).error, /no Jira key yet/);
  assert.equal(validateAmendment(j, [{ op: 'add-sub-job', spec: { ...spec('d'), storyId: 'newstory', jiraKey: 'AUTH-9' } }]).ok, true, 'a key carried directly is enough');
  assert.match(validateAmendment(j, [{ op: 'add-sub-job', spec: { ...spec('d'), kind: 'session', repo: '/repo' } }]).error, /session sub-job has no repo/);
  // Later ops see earlier ones: a dependency on a sub-job added in the same amendment resolves.
  const chained = validateAmendment(j, [{ op: 'add-sub-job', spec: spec('d') }, { op: 'add-dependency', subJobId: 'a', dependsOn: 'd' }]);
  assert.equal(chained.ok, true); assert.deepEqual(chained.plan.subJobs.find((s) => s.id === 'a').dependsOn, ['d']);
  assert.deepEqual(chained.targets, ['a']);
  assert.match(validateAmendment(j, [{ op: 'set-deployment', subJobId: 'nope', deployment: null }]).error, /no such sub-job/);
  assert.match(validateAmendment({ ...j, stage: 'planning' }, [{ op: 'set-deployment', subJobId: 'a', deployment: null }]).error, /only be amended while the job is active/);
});

test('stage gates: a finished or cancelled target, and each op only where its field still matters', () => {
  const j = job([sub('impl'), sub('impl-local', { local: { pendingChecks: ['CI green'] } }), sub('pr', { stage: 'pr' }), sub('watch', { stage: 'deployment', pr: { mergeCommit: 'm' } }),
    sub('live', { stage: 'deployment', deployed: { at: 1 } }), sub('done', { stage: 'done' }), sub('gone', { stage: 'cleanup', cancelledAt: 1 }), session('spike'), session('reviewed', { stage: 'review' })]);
  const v = (ops) => validateAmendment(j, ops);
  assert.match(v([{ op: 'set-deployment', subJobId: 'done', deployment: null }]).error, /is finished/);
  assert.match(v([{ op: 'set-deployment', subJobId: 'gone', deployment: null }]).error, /was cancelled/);
  assert.equal(v([{ op: 'set-pending-checks', subJobId: 'impl-local', pendingChecks: [] }]).ok, true);
  assert.match(v([{ op: 'set-pending-checks', subJobId: 'impl', pendingChecks: ['x'] }]).error, /no local receipt yet/);
  assert.match(v([{ op: 'set-pending-checks', subJobId: 'pr', pendingChecks: [] }]).error, /only change during implementation/);
  assert.match(v([{ op: 'set-pending-checks', subJobId: 'impl-local', pendingChecks: ['CI green'] }]).error, /no change/);
  for (const id of ['impl', 'pr', 'watch']) assert.equal(v([{ op: 'set-deployment', subJobId: id, deployment: null }]).ok, true, `${id}: the deployment can change until it has deployed`);
  assert.match(v([{ op: 'set-deployment', subJobId: 'live', deployment: null }]).error, /already deployed/);
  assert.match(v([{ op: 'set-deployment', subJobId: 'spike', deployment: null }]).error, /session sub-job has no deployment/);
  assert.match(v([{ op: 'set-deployment', subJobId: 'impl', deployment: { verify: 'Check it' } }]).error, /no change/);
  for (const id of ['impl', 'pr', 'spike']) assert.equal(v([{ op: 'add-dependency', subJobId: id, dependsOn: 'done' }]).ok, true, `${id}: dependencies move until merge`);
  assert.match(v([{ op: 'add-dependency', subJobId: 'watch', dependsOn: 'impl' }]).error, /before the sub-job merges/);
  assert.match(v([{ op: 'add-dependency', subJobId: 'reviewed', dependsOn: 'impl' }]).error, /before the sub-job merges/);
  assert.equal(v([{ op: 'set-instructions', subJobId: 'impl', instructions: 'New' }]).ok, true);
  assert.equal(v([{ op: 'set-instructions', subJobId: 'spike', instructions: 'New' }]).ok, true);
  assert.match(v([{ op: 'set-instructions', subJobId: 'pr', instructions: 'New' }]).error, /only change during implementation/);
  assert.match(v([{ op: 'set-instructions', subJobId: 'impl', instructions: 'Implement impl' }]).error, /no change/);
  assert.equal(v([{ op: 'set-recovered-by', subJobId: 'watch', fixSubJobId: 'impl' }]).ok, true);
  assert.match(v([{ op: 'set-recovered-by', subJobId: 'pr', fixSubJobId: 'impl' }]).error, /merged sub-job whose deployment failed/);
  assert.match(v([{ op: 'set-recovered-by', subJobId: 'watch', fixSubJobId: 'watch' }]).error, /cannot recover itself/);
  assert.match(v([{ op: 'set-recovered-by', subJobId: 'watch', fixSubJobId: 'done' }]).error, /fix sub-job is finished/);
  assert.match(v([{ op: 'set-recovered-by', subJobId: 'watch', fixSubJobId: 'nope' }]).error, /no such sub-job nope/);
  assert.match(validateAmendment(job([sub('r', { stage: 'deployment', recoveryJobId: 'job_x' }), sub('f')]), [{ op: 'set-recovered-by', subJobId: 'r', fixSubJobId: 'f' }]).error, /recovery job already exists/);
});

test('classification: tightening only ever adds a constraint, weakening removes one, everything else is neutral', () => {
  const j = job([sub('a'), sub('b', { local: { pendingChecks: ['one', 'two'] } }), sub('none', { deployment: undefined })]);
  assert.equal(classifyOp(j, { op: 'add-dependency', subJobId: 'a', dependsOn: 'b' }), 'tightening');
  assert.equal(classifyOp(j, { op: 'remove-dependency', subJobId: 'a', dependsOn: 'b' }), 'weakening');
  assert.equal(classifyOp(j, { op: 'set-deployment', subJobId: 'a', deployment: null }), 'weakening');
  assert.equal(classifyOp(j, { op: 'set-deployment', subJobId: 'a', deployment: { verify: 'different' } }), 'neutral', 'verify text alone');
  assert.equal(classifyOp(j, { op: 'set-deployment', subJobId: 'none', deployment: { verify: 'v' } }), 'tightening', 'making a merge-is-delivery PR wait for a deployment');
  assert.equal(classifyOp(j, { op: 'set-pending-checks', subJobId: 'b', pendingChecks: ['one', 'two', 'three'] }), 'tightening');
  assert.equal(classifyOp(j, { op: 'set-pending-checks', subJobId: 'b', pendingChecks: ['one'] }), 'weakening');
  assert.equal(classifyOp(j, { op: 'set-pending-checks', subJobId: 'b', pendingChecks: [] }), 'weakening');
  assert.equal(classifyOp(j, { op: 'set-instructions', subJobId: 'a', instructions: 'x' }), 'neutral');
  assert.equal(classifyOp(j, { op: 'add-sub-job', spec: spec('n') }), 'neutral');
  assert.equal(classifyOp(j, { op: 'set-recovered-by', subJobId: 'a', fixSubJobId: 'n' }), 'neutral');
  assert.equal(classifyAmendment(j, [{ op: 'add-dependency', subJobId: 'a', dependsOn: 'b' }, { op: 'add-dependency', subJobId: 'b', dependsOn: 'none' }]), 'tightening');
  assert.equal(classifyAmendment(j, [{ op: 'add-dependency', subJobId: 'a', dependsOn: 'b' }, { op: 'set-instructions', subJobId: 'a', instructions: 'x' }]), 'neutral');
  assert.equal(classifyAmendment(j, [{ op: 'add-dependency', subJobId: 'a', dependsOn: 'b' }, { op: 'set-deployment', subJobId: 'a', deployment: null }]), 'weakening', 'one weakening op weakens the whole');
  assert.deepEqual([['review', 'tightening'], ['review', 'neutral'], ['auto-tighten', 'tightening'], ['auto-tighten', 'neutral'], ['auto-tighten', 'weakening'], ['auto', 'weakening']].map(([a, c]) => authorityPermits(a, c)), [false, false, true, false, false, true]);
});

test('diff lines name the sub-job and what it was, so the history still reads once the plan has moved', () => {
  const j = job([sub('a'), sub('b', { local: { pendingChecks: ['CI green', 'Plan clean'] }, deployment: undefined }), session('spike')]);
  const lines = describeAmendment(j, [
    { op: 'set-deployment', subJobId: 'a', deployment: null },
    { op: 'set-deployment', subJobId: 'b', deployment: { verify: 'v' } },
    { op: 'set-deployment', subJobId: 'a', deployment: { verify: 'other' } },
    { op: 'set-pending-checks', subJobId: 'b', pendingChecks: ['CI green', 'Lint'] },
    { op: 'add-sub-job', spec: spec('fix', ['a']) },
    { op: 'add-dependency', subJobId: 'spike', dependsOn: 'a' }, { op: 'add-dependency', subJobId: 'b', dependsOn: 'fix' },
    { op: 'remove-dependency', subJobId: 'b', dependsOn: 'a' },
    { op: 'set-instructions', subJobId: 'a', instructions: 'x' }, { op: 'set-recovered-by', subJobId: 'a', fixSubJobId: 'fix' },
  ]);
  assert.deepEqual(lines, [
    'Drop deployment for Deliver a: merging completes it',
    'Wait for a deployment of Deliver b, then verify: v',
    'New verification for Deliver a: other',
    'Remove 1 pending check from Deliver b: Plan clean. Add 1 pending check to Deliver b: Lint',
    'Add PR sub-job “Deliver fix” in /repo, after Deliver a',
    'Run spike now starts after Deliver a', 'Deliver b now deploys after Deliver fix',
    'Deliver b no longer waits for Deliver a',
    'Rewrite the instructions for Deliver a; its implementation starts again',
    'Deliver a counts as deployed once Deliver fix deploys',
  ]);
  assert.deepEqual(amendmentTargets({ subJobId: 'spike', ops: [{ op: 'add-sub-job', spec: spec('n') }, { op: 'add-dependency', subJobId: 'a', dependsOn: 'n' }, { op: 'set-deployment', subJobId: 'a', deployment: null }] }), ['a', 'spike']);
});
