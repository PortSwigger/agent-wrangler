import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runArchiveReview, buildExcerpt, ARCHIVE_REVIEW_COMPLETED } from './archive-review-runner.js';
import { createEventBus } from './events.js';

const ENTRY = { agent: 'claude', liveSessionId: 'L1', createdAt: 0 };
const TASK = { id: 'T1', name: 'Task one' };

function subprocessDep() {
  const calls = [];
  return {
    calls,
    review: async (excerpt) => {
      calls.push(excerpt);
      return { text: '- a durable fact', liveSessionId: 'REVIEW1', error: null };
    },
  };
}

function deps(overrides = {}) {
  const appended = [];
  const stamps = [];
  // A stand-in for the task-memory extension: the runner only publishes
  // `archive-review:completed`, and whoever subscribes decides where it goes.
  const events = createEventBus();
  events.on(ARCHIVE_REVIEW_COMPLETED, ({ taskId, markdown }) => appended.push({ taskId, md: markdown }), 'task-memory');
  return {
    events,
    appended,
    stamps,
    onStamp: (s) => stamps.push(s),
    findTranscriptFn: async () => '/tmp/fake-transcript.jsonl',
    readLinesFn: async () => [
      { type: 'user', message: { role: 'user', content: 'please do X' } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'ok, did X' }] } },
    ],
    isEnabled: () => true,
    ...overrides,
  };
}

test('skips when the feature flag is off', async () => {
  const d = deps({ isEnabled: () => false, ...subprocessDep() });
  const mode = await runArchiveReview('c1', ENTRY, TASK, d);
  assert.equal(mode, 'skipped');
  assert.equal(d.appended.length, 0);
});

test('skips a Codex session — v1 is Claude-only', async () => {
  const d = deps(subprocessDep());
  const mode = await runArchiveReview('c1', { ...ENTRY, agent: 'codex' }, TASK, d);
  assert.equal(mode, 'skipped');
  assert.equal(d.appended.length, 0);
});

test('skips when there is no task (nothing to write to)', async () => {
  const d = deps(subprocessDep());
  const mode = await runArchiveReview('c1', ENTRY, null, d);
  assert.equal(mode, 'skipped');
});

test('skips when no transcript is found', async () => {
  const d = deps({ findTranscriptFn: async () => null, ...subprocessDep() });
  const mode = await runArchiveReview('c1', ENTRY, TASK, d);
  assert.equal(mode, 'skipped');
});

test('skips when the bounded excerpt has nothing in it (empty transcript)', async () => {
  const d = deps({ readLinesFn: async () => [], ...subprocessDep() });
  const mode = await runArchiveReview('c1', ENTRY, TASK, d);
  assert.equal(mode, 'skipped');
});

test('none of the skip paths ever spawn the subprocess', async () => {
  const sp = subprocessDep();
  await runArchiveReview('c1', ENTRY, TASK, deps({ isEnabled: () => false, ...sp }));
  await runArchiveReview('c1', { ...ENTRY, agent: 'codex' }, TASK, deps(sp));
  await runArchiveReview('c1', ENTRY, null, deps(sp));
  await runArchiveReview('c1', ENTRY, TASK, deps({ findTranscriptFn: async () => null, ...sp }));
  await runArchiveReview('c1', ENTRY, TASK, deps({ readLinesFn: async () => [], ...sp }));
  assert.equal(sp.calls.length, 0);
});

test('a NONE result from the reviewer writes nothing', async () => {
  const d = deps({ review: async () => ({ text: 'NONE', liveSessionId: 'R1', error: null }) });
  const mode = await runArchiveReview('c1', ENTRY, TASK, d);
  assert.equal(mode, 'none');
  assert.equal(d.appended.length, 0);
});

// Verified empirically against a real Haiku call: a thin excerpt sometimes
// makes the model respond with confused prose ("I don't see a transcript in
// your message...") instead of the instructed NONE. That must never land in
// memory.md — only a response that actually leads with a bullet is written.
test('confused free-text prose (not NONE, not bullets) is treated as none — never appended', async () => {
  const d = deps({
    review: async () => ({
      text: "I don't see a transcript excerpt in your message. Please paste the transcript.",
      liveSessionId: 'R1',
      error: null,
    }),
  });
  const mode = await runArchiveReview('c1', ENTRY, TASK, d);
  assert.equal(mode, 'none');
  assert.equal(d.appended.length, 0);
});

test('a real multi-bullet answer (leading directly with a bullet, as instructed) is written', async () => {
  const d = deps({
    review: async () => ({ text: '- a real durable fact\n- another one', liveSessionId: 'R1', error: null }),
  });
  const mode = await runArchiveReview('c1', ENTRY, TASK, d);
  assert.equal(mode, 'written');
});

test('a normal result appends exactly one dated section and stamps liveSessionId', async () => {
  const d = deps(subprocessDep());
  const mode = await runArchiveReview('c1', { ...ENTRY, lastLabel: 'fix the thing' }, TASK, d);
  assert.equal(mode, 'written');
  assert.equal(d.appended.length, 1);
  assert.equal(d.appended[0].taskId, 'T1');
  assert.match(d.appended[0].md, /^\n## Session review — \d{4}-\d{2}-\d{2} \(fix the thing\)\n\n- a durable fact\n$/);
  assert.deepEqual(d.stamps, [{ reviewLiveSessionId: 'REVIEW1', advanceReviewedAt: true }]);
});

test('a reviewer error is reported and does NOT advance the reviewed-at stamp', async () => {
  const d = deps({ review: async () => ({ text: null, liveSessionId: 'R1', error: new Error('boom') }) });
  const mode = await runArchiveReview('c1', ENTRY, TASK, d);
  assert.equal(mode, 'error');
  assert.equal(d.appended.length, 0);
  assert.deepEqual(d.stamps, [{ reviewLiveSessionId: 'R1', advanceReviewedAt: false }]);
});

test('excerpt is bounded by max(usageSince(entry), entry.archiveReviewedAt) — a fork only reviews its own turns', async () => {
  const sp = subprocessDep();
  const forked = { ...ENTRY, forkedFrom: 'parentCard', createdAt: 1000 };
  const readLinesFn = async () => [
    { type: 'user', timestamp: new Date(500).toISOString(), message: { role: 'user', content: 'pre-fork turn' } },
    { type: 'user', timestamp: new Date(1500).toISOString(), message: { role: 'user', content: 'post-fork turn' } },
  ];
  await runArchiveReview('c1', forked, TASK, deps({ readLinesFn, ...sp }));
  assert.equal(sp.calls.length, 1);
  assert.ok(sp.calls[0].includes('post-fork turn'));
  assert.ok(!sp.calls[0].includes('pre-fork turn'));
});

test('a re-archive only reviews turns after the last review (archiveReviewedAt)', async () => {
  const sp = subprocessDep();
  const entry = { ...ENTRY, archiveReviewedAt: 1000 };
  const readLinesFn = async () => [
    { type: 'user', timestamp: new Date(500).toISOString(), message: { role: 'user', content: 'already reviewed' } },
    { type: 'user', timestamp: new Date(1500).toISOString(), message: { role: 'user', content: 'new since last review' } },
  ];
  await runArchiveReview('c1', entry, TASK, deps({ readLinesFn, ...sp }));
  assert.equal(sp.calls.length, 1);
  assert.ok(sp.calls[0].includes('new since last review'));
  assert.ok(!sp.calls[0].includes('already reviewed'));
});

test('buildExcerpt is human-turns-only — assistant text and tool calls never appear, even when legitimate', () => {
  const entries = [
    { isMeta: true, type: 'user', message: { role: 'user', content: 'meta noise' } },
    { type: 'user', message: { role: 'user', content: '<system-reminder>ignore me</system-reminder>' } },
    { type: 'user', message: { role: 'user', content: 'a real user turn' } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash' }] } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'a real assistant turn' }] } },
  ];
  const excerpt = buildExcerpt(entries);
  assert.ok(excerpt.includes('a real user turn'));
  assert.ok(!excerpt.includes('meta noise'));
  assert.ok(!excerpt.includes('ignore me'));
  // Not just noise-filtering — assistant content is excluded categorically,
  // even a clean text turn with nothing wrong with it.
  assert.ok(!excerpt.includes('a real assistant turn'));
});

test('an assistant-only transcript (no human turns at all) yields an empty excerpt', async () => {
  const entries = [
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'only assistant output here' }] } },
  ];
  assert.equal(buildExcerpt(entries), '');
  const sp = subprocessDep();
  const mode = await runArchiveReview('c1', ENTRY, TASK, deps({ readLinesFn: async () => entries, ...sp }));
  assert.equal(mode, 'skipped');
  assert.equal(sp.calls.length, 0);
});

test('buildExcerpt caps total size, keeping head and tail with an elision marker', () => {
  // Below the per-turn truncation cap on its own; only the SUM across many
  // turns exceeds the overall excerpt cap.
  const entries = [];
  entries.push({ type: 'user', message: { role: 'user', content: 'START marker turn' } });
  for (let i = 0; i < 30; i += 1) {
    entries.push({ type: 'user', message: { role: 'user', content: `filler turn ${i} `.repeat(150) } });
  }
  entries.push({ type: 'user', message: { role: 'user', content: 'END marker turn' } });
  const excerpt = buildExcerpt(entries);
  assert.ok(excerpt.length < 45000);
  assert.ok(excerpt.includes('…[MIDDLE OF SESSION ELIDED]…'));
  assert.ok(excerpt.includes('START marker turn'));
  assert.ok(excerpt.includes('END marker turn'));
});

test('a Claude-only guard is not tripped by a missing agent field (defaults to claude)', async () => {
  const d = deps(subprocessDep());
  const { agent: _omit, ...noAgent } = ENTRY;
  const mode = await runArchiveReview('c1', noAgent, TASK, d);
  assert.equal(mode, 'written');
});

test('the event carries the session id, the task id and the markdown', async () => {
  const d = deps(subprocessDep());
  const seen = [];
  d.events.on(ARCHIVE_REVIEW_COMPLETED, (p) => seen.push(p), 'other');
  await runArchiveReview('c9', ENTRY, TASK, d);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].sid, 'c9');
  assert.equal(seen[0].taskId, 'T1');
  assert.match(seen[0].markdown, /- a durable fact/);
});

test('with no subscriber (the memory extension is off) nothing is reviewed or written', async () => {
  const sp = subprocessDep();
  const d = deps(sp);
  d.events = createEventBus(); // nobody listening
  const mode = await runArchiveReview('c1', ENTRY, TASK, d);
  assert.equal(mode, 'skipped');
  assert.equal(sp.calls.length, 0, 'no model call is spent on a result with nowhere to go');
});

test('a subscriber owned by an inactive extension does not count as listening', async () => {
  const sp = subprocessDep();
  const d = deps(sp);
  d.events = createEventBus({ isActive: () => false });
  d.events.on(ARCHIVE_REVIEW_COMPLETED, () => {}, 'task-memory');
  assert.equal(await runArchiveReview('c1', ENTRY, TASK, d), 'skipped');
  assert.equal(sp.calls.length, 0);
});
