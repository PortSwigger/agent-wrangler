import { test } from 'node:test';
import assert from 'node:assert/strict';
import { usdByCard, withJobSpend } from './job-spend.js';

// The scan row shape scanAllDaily returns: one row per costed transcript, tagged
// with the card it was resolved from. estimatedUsd is a dollar slice (Codex), not a flag.
const row = (cardId, days) => ({ file: `/t/${cardId}.jsonl`, cardId, owner: true, task: { key: 'adhoc' }, days });
const day = (usd, estimatedUsd = 0) => ({ usd, estimatedUsd });

test('usdByCard sums every row a card owns and flags a Codex estimate', () => {
  const map = usdByCard({ sessions: [
    row('plan', { '2026-07-10': day(1.5), '2026-07-11': day(0.5) }),
    row('plan', { '2026-07-12': day(1) }), // a /clear leaves a second transcript on the same card
    row('cx', { '2026-07-10': day(2, 2) }),
    { file: null, days: { '2026-07-10': day(9) } }, // no cardId: nothing to attribute it to
  ] });
  assert.deepEqual(map.get('plan'), { usd: 3, estimated: false });
  assert.deepEqual(map.get('cx'), { usd: 2, estimated: true });
  assert.equal(map.size, 2);
});

test('a job total covers planning as well as every sub-job, each card counted once', () => {
  const byCard = usdByCard({ sessions: [
    row('planCard', { d: day(2) }),
    row('apiCard', { d: day(3) }),
    row('apiRepair', { d: day(0.25) }),
    row('webCard', { d: day(4) }),
  ] });
  const { jobs: [job] } = withJobSpend({ jobs: [{
    id: 'job1',
    // Planning/ticketing runs carry a null subJobId, so no sub-job holds their card.
    runs: [
      { subJobId: null, sessionId: 'planCard' },
      { subJobId: 'api', sessionId: 'apiCard' },
      { subJobId: 'api', sessionId: 'apiRepair' },
      { subJobId: 'web', sessionId: 'webCard' },
      { subJobId: 'web', sessionId: 'webCard' }, // a re-bound card must not be billed twice
    ],
    subJobs: [{ id: 'api', sessions: ['apiCard', 'apiRepair'] }, { id: 'web', sessions: ['webCard'] }],
  }] }, byCard);
  assert.equal(job.usd, 9.25);
  assert.equal(job.usdEstimated, false);
  assert.deepEqual(job.subJobs.map((s) => s.usd), [3.25, 4]);
  assert.equal(job.subJobs.reduce((n, s) => n + s.usd, 0) + 2, job.usd, 'planning is the difference between the sub-jobs and the total');
});

test('a Codex step marks its sub-job and the whole job as an estimate', () => {
  const byCard = usdByCard({ sessions: [row('a', { d: day(1) }), row('b', { d: day(2, 2) })] });
  const { jobs: [job] } = withJobSpend({ jobs: [{
    runs: [{ subJobId: 'x', sessionId: 'a' }, { subJobId: 'y', sessionId: 'b' }],
    subJobs: [{ id: 'x', sessions: ['a'] }, { id: 'y', sessions: ['b'] }],
  }] }, byCard);
  assert.equal(job.usdEstimated, true);
  assert.deepEqual(job.subJobs.map((s) => s.usdEstimated), [false, true]);
});

test('spend the scan cannot see is null, not 0 — a backlog job shows no price at all', () => {
  const { jobs, settings } = withJobSpend({ settings: { concurrency: 2 }, jobs: [
    { id: 'backlog', runs: [], subJobs: [] },
    { id: 'launched', runs: [{ subJobId: null, sessionId: 'unscanned' }], subJobs: [{ id: 's', sessions: ['unscanned'] }] },
  ] }, new Map());
  assert.deepEqual(jobs.map((j) => j.usd), [null, null]);
  assert.deepEqual(jobs[1].subJobs.map((s) => s.usd), [null]);
  assert.deepEqual(jobs.map((j) => j.usdEstimated), [false, false]);
  assert.deepEqual(settings, { concurrency: 2 }, 'the rest of the snapshot rides through untouched');
});

test('an empty map or a snapshot with no jobs is enriched without throwing', () => {
  assert.deepEqual(withJobSpend({ jobs: [] }).jobs, []);
  assert.deepEqual(withJobSpend({}).jobs, []);
  assert.equal(usdByCard(undefined).size, 0);
  // A card in the map that belongs to no job is simply never asked for.
  const { jobs: [job] } = withJobSpend({ jobs: [{ runs: [{ sessionId: 'mine' }], subJobs: [] }] },
    usdByCard({ sessions: [row('mine', { d: day(1) }), row('someone-else', { d: day(50) })] }));
  assert.equal(job.usd, 1);
});
