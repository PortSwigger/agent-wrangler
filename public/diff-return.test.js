import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffReturnTarget } from './diff-return.js';

const jobs = [{ id: 'job1', subJobs: [{ id: 'api' }, { id: 'web' }] }];
const base = { armed: { sid: 's1', jobId: 'job1', subId: 'api' }, closedSid: 's1', jobs };

test('returns to the detail the review was started from', () => {
  assert.deepEqual(diffReturnTarget(base), { jobId: 'job1', subId: 'api' });
});

test('does nothing when no trip is armed', () => {
  assert.equal(diffReturnTarget({ ...base, armed: null }), null);
  assert.equal(diffReturnTarget({ ...base, armed: { jobId: 'job1', subId: 'api' } }), null);
});

// Another session's diff is another review — the reader never left Jobs for it.
test('does not fire for a diff other than the one under review', () => {
  assert.equal(diffReturnTarget({ ...base, closedSid: 's2' }), null);
});

// A cancelled or purged job outlives the arm; Jobs is still where they came from.
test('goes back to the board without a dialog once the job or sub-job is gone', () => {
  assert.deepEqual(diffReturnTarget({ ...base, jobs: [] }), { jobId: null, subId: null });
  assert.deepEqual(diffReturnTarget({ ...base, jobs: [{ id: 'job1', subJobs: [{ id: 'web' }] }] }), { jobId: null, subId: null });
  assert.deepEqual(diffReturnTarget({ ...base, jobs: undefined }), { jobId: null, subId: null });
});

test('a job-level trip needs only its job to still exist', () => {
  const armed = { sid: 's1', jobId: 'job1', subId: '' };
  assert.deepEqual(diffReturnTarget({ ...base, armed }), { jobId: 'job1', subId: '' });
  assert.deepEqual(diffReturnTarget({ ...base, armed, jobs: [] }), { jobId: null, subId: null });
});
