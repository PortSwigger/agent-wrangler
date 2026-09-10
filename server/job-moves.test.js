import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyMove, moveSchemas, MOVE_ACTIONS } from './job-moves.js';
import { buildSubJob } from './job-store.js';

// The pure surface: job-store.js hands applyMove the draft it is about to
// persist, so everything here is a plain object with no disk behind it.
const planSub = (id, extra = {}) => ({ id, title: `Deliver ${id}`, kind: 'pr', repo: '/repo', storyId: 'story', after: [], brief: `Implement ${id}`, ...extra });
function job({ subs = [planSub('api')], stories = [{ id: 'story', key: 'AUTH-1', title: 'Sign-in' }], runs = [], live } = {}) {
  const plan = { context: 'Shared context', stories, subJobs: structuredClone(subs) };
  return { id: 'job_1', plan, runs, subJobs: live || plan.subJobs.map((s) => buildSubJob(plan, s)) };
}
const move = (j, subId, name, payload = {}) => applyMove(j, j.subJobs.find((s) => s.id === subId), name, payload, { now: 1000, buildSubJob });

test('the six moves are the whole vocabulary, each with its own payload', () => {
  assert.deepEqual([...MOVE_ACTIONS].sort(), ['drop', 'fix-here', 'mark', 'new-ticket', 'reorder', 'split-out']);
  assert.deepEqual(Object.keys(moveSchemas).sort(), [...MOVE_ACTIONS].sort());
  const j = job();
  assert.throws(() => move(j, 'api', 'rewrite-plan'), /Unknown job action/);
  assert.throws(() => applyMove(j, null, 'drop', {}, { buildSubJob }), /Choose a sub-job/);
  assert.throws(() => move(j, 'api', 'split-out', { title: 'x', brief: '' }));
  assert.throws(() => move(j, 'api', 'split-out', { title: 'x', brief: 'y'.repeat(501) }));
  assert.throws(() => move(j, 'api', 'fix-here', { note: 'n'.repeat(181) }));
  assert.throws(() => move(j, 'api', 'mark', { position: 'pr', url: 'https://example.com/pull/1' }));
  assert.throws(() => move(j, 'api', 'mark', { position: 'somewhere' }));
});

test('a split-out id is the first free suffix, and both the plan and the live list get it', () => {
  const j = job({ subs: [planSub('api'), planSub('api-2')] });
  const { detail } = move(j, 'api', 'split-out', { title: 'Sync the proto', brief: 'Regenerate it', position: 'after' });
  assert.deepEqual(j.plan.subJobs.map((s) => s.id), ['api', 'api-2', 'api-3']);
  assert.deepEqual(j.subJobs.map((s) => s.id), ['api', 'api-2', 'api-3']);
  const added = j.subJobs.at(-1);
  assert.equal(added.stage, 'implementation'); assert.equal(added.state, 'queued'); assert.equal(added.jiraKey, 'AUTH-1');
  assert.deepEqual([added.pr, added.deploys, added.note, added.fixRequested, added.blocked], [null, null, null, null, null]);
  assert.match(detail, /Split out “Sync the proto” to land after this/);
});

test('a session sub-job has no repository, so it cannot split out a PR', () => {
  const j = job({ subs: [{ id: 'spike', title: 'Spike', kind: 'session', storyId: 'story', after: [], brief: 'Investigate' }] });
  assert.throws(() => move(j, 'spike', 'split-out', { title: 'x', brief: 'y' }), /no repository/);
});

test('New ticket takes the first free story id and leaves the key for the Jira step', () => {
  const j = job({ stories: [{ id: 'story', key: 'AUTH-1', title: 'Sign-in' }, { id: 's-2', key: 'AUTH-2', title: 'Audit' }] });
  move(j, 'api', 'new-ticket', { storyTitle: 'Rate limiting', title: 'Add the limiter', brief: 'Limit by IP' });
  assert.deepEqual(j.plan.stories.map((s) => s.id), ['story', 's-2', 's-3']);
  const added = j.subJobs.at(-1);
  assert.equal(added.storyId, 's-3'); assert.equal(added.jiraKey, null);
  assert.deepEqual(added.after, [], 'no position means it stands on its own');
  move(j, 'api', 'new-ticket', { storyTitle: 'Already ticketed', key: 'SEC-9', title: 'Emit events', brief: 'One per sign-in', position: 'before' });
  assert.equal(j.subJobs.at(-1).jiraKey, 'SEC-9', 'an existing key needs no Jira step');
  assert.deepEqual(j.subJobs.find((s) => s.id === 'api').after, [j.subJobs.at(-1).id]);
});

test('a move is judged by the plan schema it was approved under, without punishing a migrated brief', () => {
  const j = job({ subs: [planSub('api'), planSub('web', { brief: 'x'.repeat(900) })] });
  assert.throws(() => move(j, 'web', 'reorder', { after: ['ghost'] }), /Unknown dependency/);
  assert.deepEqual(j.subJobs[1].after, [], 'a refused reorder leaves the sub-job alone');
  move(j, 'web', 'reorder', { after: ['api'] });
  assert.deepEqual(j.plan.subJobs[1].after, ['api']);
  assert.throws(() => move(j, 'api', 'reorder', { after: ['web'] }), /cycles/);
  assert.throws(() => move(j, 'api', 'reorder', { after: ['api'] }), /cannot depend on itself/);
});

test('stage decides which moves still make sense', () => {
  const at = (stage, extra = {}) => { const j = job(); Object.assign(j.subJobs[0], { stage, ...extra }); return j; };
  assert.throws(() => move(at('deployment'), 'api', 'fix-here'), /Split out/);
  assert.throws(() => move(at('cleanup'), 'api', 'fix-here'), /Nothing to fix|Split out/);
  assert.throws(() => move(at('deployment'), 'api', 'reorder', { after: [] }), /has merged/);
  assert.throws(() => move(at('cleanup'), 'api', 'drop'), /already finished/);
  assert.throws(() => move(at('cleanup'), 'api', 'mark', { position: 'done' }), /already finished/);
  assert.throws(() => move(at('done'), 'api', 'mark', { position: 'done' }), /already finished/);
  assert.throws(() => move(at('pr', { cancelledAt: 5 }), 'api', 'fix-here'), /already finished/);
  assert.throws(() => move(at('pr'), 'api', 'mark', { position: 'pr', url: 'https://github.com/org/repo/pull/1' }), /already has a PR/);
  assert.throws(() => move(at('implementation'), 'api', 'mark', { position: 'merged' }), /Only an open PR/);
});

test('a live run refuses the moves that rewrite the plan, and never Drop', () => {
  const live = [{ id: 'run_1', subJobId: 'api', stopped: false }];
  for (const [name, payload] of [['split-out', { title: 'x', brief: 'y' }], ['new-ticket', { storyTitle: 's', title: 'x', brief: 'y' }],
    ['reorder', { after: [] }], ['mark', { position: 'done' }]]) {
    assert.throws(() => move(job({ runs: live }), 'api', name, payload), /Wait for the session to stop/, name);
  }
  const j = job({ runs: live });
  Object.assign(j.subJobs[0], { stage: 'pr', pr: { url: 'https://github.com/org/repo/pull/1' } });
  assert.throws(() => move(j, 'api', 'fix-here', {}), /Wait for the session to stop/, 'a repair is already running');
  const dropped = job({ runs: live });
  move(dropped, 'api', 'drop');
  assert.equal(dropped.subJobs[0].state, 'cancelled');
  // A steer for a queued sub-job is not a plan change; the run settles anyway.
  const steered = job({ runs: live });
  move(steered, 'api', 'fix-here', { note: 'Call it sign_in_v2' });
  assert.equal(steered.subJobs[0].note, 'Call it sign_in_v2');
});

test('a move clears the event it answers', () => {
  for (const [name, payload] of [['fix-here', {}], ['split-out', { title: 'x', brief: 'y' }],
    ['new-ticket', { storyTitle: 's', title: 'x', brief: 'y' }], ['drop', {}], ['mark', { position: 'done' }]]) {
    const j = job();
    Object.assign(j.subJobs[0], { error: 'Worker blocked', blocked: { summary: 'Worker blocked', move: name } });
    move(j, 'api', name, payload);
    assert.equal(j.subJobs[0].error, null, name);
    assert.equal(j.subJobs[0].blocked, null, name);
  }
  // Reorder answers nothing: it is a plan decision, not a response to an event.
  const j = job();
  Object.assign(j.subJobs[0], { error: 'Worker blocked' });
  move(j, 'api', 'reorder', { after: [] });
  assert.equal(j.subJobs[0].error, 'Worker blocked');
});
