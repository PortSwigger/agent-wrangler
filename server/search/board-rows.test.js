import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCandidates, boardFields, tokenize, matchMeta, statusOf, passesFacets } from './board-rows.js';

const DOCS = [
  { id: 'conv-a', agent: 'claude', cwd: '/repos/site', title: 'Fix login', branch: 'main', lastTs: 1000 },
  { id: 'conv-b', agent: 'codex', cwd: '/repos/api', title: 'API tweak', branch: '', lastTs: 2000 },
  { id: 'conv-dead', agent: 'claude', cwd: '/repos/x', title: 'rewritten', dead: true, lastTs: 3000 },
];

function entries() {
  return new Map([
    ['card-a', {
      liveSessionId: 'conv-a', agent: 'claude', cwd: '/repos/site', intent: 'fix the login redirect',
      lastLabel: 'Login fixer', name: 'login', model: 'opus', createdAt: 500_000,
      task: { id: 't1', name: 'Auth work' },
      worktree: { branch: 'aw/login', path: '/wt/login', repoRoot: '/repos/site' },
      workflow: { issue: 'ENT-1', phase: { label: 'implementing', kind: 'active', at: 900_000 } },
    }],
    // Transcript aged out of the index (no doc) — the History tail browse must keep.
    ['card-old', { liveSessionId: 'conv-gone', agent: 'claude', cwd: '/repos/old', lastLabel: 'Ancient migration', createdAt: 1_000_000, archivedAt: 3_000_000 }],
    // Legacy pre-split entry: no liveSessionId, so its card id IS the conversation id.
    ['conv-legacy', { agent: 'claude', cwd: '/repos/legacy', intent: 'legacy intent\nsecond line', createdAt: 2_000_000, archivedAt: 2_500_000 }],
  ]);
}

test('buildCandidates: a doc with a board entry yields ONE joined row, never two', () => {
  const rows = buildCandidates({ docs: DOCS, entries: entries(), live: new Map() });
  const forA = rows.filter((r) => r.sessionId === 'conv-a');
  assert.equal(forA.length, 1);
  const r = forA[0];
  assert.equal(r.cardId, 'card-a');
  assert.equal(r.boardLabel, 'Login fixer');
  assert.equal(r.task, 'Auth work');
  assert.equal(r.model, 'opus');
  assert.equal(r.worktreeBranch, 'aw/login');
  assert.equal(r.worktreePath, '/wt/login');
  assert.equal(r.workflowIssue, 'ENT-1');
  assert.equal(r.title, 'Fix login'); // the doc's title wins on a joined row
  assert.equal(r.noTranscript, undefined); // only mappings-only rows carry it
});

test('buildCandidates: a mappings-only entry is synthesized with noTranscript and the label as title', () => {
  const rows = buildCandidates({ docs: DOCS, entries: entries(), live: new Map() });
  const gone = rows.find((r) => r.sessionId === 'conv-gone');
  assert.equal(gone.noTranscript, true);
  assert.equal(gone.title, 'Ancient migration');
  assert.equal(gone.docIdx, -1);
  assert.equal(gone.cardId, 'card-old');
  assert.equal(gone.archived, true);
});

test('buildCandidates: a legacy entry (card id == conversation id) unions under its card id, first intent line as title', () => {
  const rows = buildCandidates({ docs: DOCS, entries: entries(), live: new Map() });
  const legacy = rows.find((r) => r.sessionId === 'conv-legacy');
  assert.equal(legacy.cardId, 'conv-legacy');
  assert.equal(legacy.title, 'legacy intent');
  assert.equal(legacy.noTranscript, true);
});

test('buildCandidates: a dead doc is skipped, which routes its entry through the mappings union instead', () => {
  const rows = buildCandidates({
    docs: DOCS,
    entries: new Map([['card-d', { liveSessionId: 'conv-dead', agent: 'claude', cwd: '/repos/x', createdAt: 7 }]]),
    live: new Map(),
  });
  const dead = rows.filter((r) => r.sessionId === 'conv-dead');
  assert.equal(dead.length, 1);
  assert.equal(dead[0].noTranscript, true); // synthesized, not the tombstoned doc
});

test('buildCandidates: lastActivity is the max of doc tail, entry stamps, and live graph activity', () => {
  const live = new Map([['card-a', 9_000_000]]);
  const rows = buildCandidates({ docs: DOCS, entries: entries(), live });
  const a = rows.find((r) => r.sessionId === 'conv-a');
  assert.equal(a.lastActivity, 9_000_000); // live activity beats lastTs*1000 (1_000_000) and createdAt
  assert.equal(a.onBoard, true);
  const gone = rows.find((r) => r.sessionId === 'conv-gone');
  assert.equal(gone.lastActivity, 3_000_000); // archivedAt beats createdAt; no doc, no live entry
  assert.equal(gone.onBoard, false);
  const b = rows.find((r) => r.sessionId === 'conv-b');
  assert.equal(b.lastActivity, 2_000_000); // doc-only: the transcript tail
});

test('boardFields lifts only the join subset, and only what a row actually has', () => {
  const rows = buildCandidates({ docs: DOCS, entries: entries(), live: new Map() });
  const joined = boardFields(rows.find((r) => r.sessionId === 'conv-a'));
  assert.equal(joined.cardId, 'card-a');
  assert.equal(joined.title, undefined); // doc-shape fields stay the scan group's own
  assert.equal(joined.docIdx, undefined);
  const docOnly = boardFields(rows.find((r) => r.sessionId === 'conv-b'));
  assert.deepEqual(Object.keys(docOnly), ['lastActivity']);
});

test('matchMeta: multi-token AND, case-insensitive, with per-field attribution', () => {
  const rows = buildCandidates({ docs: DOCS, entries: entries(), live: new Map() });
  const a = rows.find((r) => r.sessionId === 'conv-a');
  const fields = matchMeta(a, tokenize('LOGIN fixer'));
  assert.ok(fields.includes('label')); // "fixer" only lives in the board label
  assert.ok(fields.includes('title')); // "login" also matched the doc title
  assert.ok(fields.includes('worktree')); // …and the aw/login branch
  assert.equal(matchMeta(a, tokenize('login zebra')), null); // AND: every token must match
  assert.deepEqual(matchMeta(a, tokenize('ENT-1')), ['issue']);
  assert.deepEqual(matchMeta(a, tokenize('conv-a')), ['id']);
  assert.equal(matchMeta(a, []), null); // no tokens is never a match (browse handles empty separately)
});

test('statusOf: archived beats board; a doc-only row is offboard', () => {
  assert.equal(statusOf({ cardId: 'c', archived: true }), 'archived');
  assert.equal(statusOf({ cardId: 'c' }), 'board');
  assert.equal(statusOf({}), 'offboard');
});

test('passesFacets: status, agents, and since/until against lastActivity', () => {
  const row = { agent: 'claude', cardId: 'c', lastActivity: 5_000 };
  assert.equal(passesFacets(row, { status: 'board' }), true);
  assert.equal(passesFacets(row, { status: 'archived' }), false);
  assert.equal(passesFacets(row, { agents: ['codex'] }), false);
  assert.equal(passesFacets(row, { agents: ['claude', 'codex'] }), true);
  assert.equal(passesFacets(row, { since: 6_000 }), false);
  assert.equal(passesFacets(row, { since: 4_000, until: 6_000 }), true);
  assert.equal(passesFacets(row, { until: 4_000 }), false);
  assert.equal(passesFacets(row, {}), true);
});
