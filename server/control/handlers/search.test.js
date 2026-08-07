import test from 'node:test';
import assert from 'node:assert/strict';
import { answerSearch } from './search.js';

// The doc table and the scan are injected (adopt.js's DI seam) so no on-disk
// index — a developer's real transcripts — can decide a test's outcome.
const DOCS = [
  { id: 'conv-a', agent: 'claude', cwd: '/repos/site', title: 'Fix login', branch: 'main', lastTs: 1000 },
  { id: 'conv-b', agent: 'codex', cwd: '/repos/api', title: 'API tweak', branch: '', lastTs: 2000 },
];

function harness({ docs = DOCS, entries = new Map(), sessions = [], scanResult = null } = {}) {
  const scans = [];
  const ctx = {
    sessionManager: { map: entries },
    graph: () => ({ sessions }),
  };
  const deps = {
    docs: () => docs,
    stats: () => ({ records: 42 }),
    scan: async (opts) => {
      scans.push(opts);
      return scanResult || {
        query: opts.query, matches: 0, shownHits: 0, groups: [], truncated: false,
        ms: 1, scannedBytes: 0, mode: 'resident', workers: 0, index: { records: 42 },
      };
    },
  };
  return { ctx, deps, scans };
}

const boardEntries = () => new Map([
  ['card-a', {
    liveSessionId: 'conv-a', agent: 'claude', cwd: '/repos/site', intent: 'fix it',
    lastLabel: 'Login fixer', model: 'opus', createdAt: 500_000, task: { id: 't1', name: 'Auth work' },
  }],
  // Archived, transcript gone — the tail History carried that browse must keep.
  ['card-old', { liveSessionId: 'conv-gone', agent: 'claude', cwd: '/repos/old', lastLabel: 'Ancient migration', createdAt: 1_000_000, archivedAt: 3_000_000 }],
]);

// ── browse mode ─────────────────────────────────────────────────────────────

test('browse: an empty query lists docs + mappings-union rows, recency-sorted, without scanning', async () => {
  const h = harness({ entries: boardEntries() });
  const res = await answerSearch({ query: '' }, h.ctx, h.deps);
  assert.equal(h.scans.length, 0); // no corpus scan in browse mode
  assert.equal(res.browse, true);
  assert.equal(res.type, 'search-results');
  assert.deepEqual(res.groups.map((g) => g.sessionId), ['conv-gone', 'conv-b', 'conv-a']); // 3M > 2M > 1M
  assert.equal(res.total, 3);
  assert.equal(res.truncated, false);
  assert.equal(res.matches, 0);
  assert.equal(res.shownHits, 0);
  assert.deepEqual(res.index, { records: 42 });
  for (const g of res.groups) {
    assert.deepEqual(g.hits, []);
    assert.equal(g.matches, 0);
  }
});

test('browse: a joined row appears once; noTranscript marks only the mappings-only row', async () => {
  const h = harness({ entries: boardEntries() });
  const res = await answerSearch({ query: '  ' }, h.ctx, h.deps);
  assert.equal(res.groups.filter((g) => g.sessionId === 'conv-a').length, 1);
  assert.deepEqual(res.groups.filter((g) => g.noTranscript).map((g) => g.sessionId), ['conv-gone']);
  const a = res.groups.find((g) => g.sessionId === 'conv-a');
  assert.equal(a.cardId, 'card-a');
  assert.equal(a.boardLabel, 'Login fixer');
});

test('browse: a 1-char query filters by metadata (History filter semantics)', async () => {
  const h = harness({ entries: boardEntries() });
  const res = await answerSearch({ query: 'x' }, h.ctx, h.deps); // only "Login fiXer" / "fiX it" carry an x
  assert.equal(res.browse, true);
  assert.deepEqual(res.groups.map((g) => g.sessionId), ['conv-a']);
  assert.equal(res.total, 1);
});

test('browse: status facet — archived / board / offboard', async () => {
  const h = harness({ entries: boardEntries() });
  const archived = await answerSearch({ query: '', status: 'archived' }, h.ctx, h.deps);
  assert.deepEqual(archived.groups.map((g) => g.sessionId), ['conv-gone']);
  const board = await answerSearch({ query: '', status: 'board' }, h.ctx, h.deps);
  assert.deepEqual(board.groups.map((g) => g.sessionId), ['conv-a']);
  const off = await answerSearch({ query: '', status: 'offboard' }, h.ctx, h.deps);
  assert.deepEqual(off.groups.map((g) => g.sessionId), ['conv-b']);
  const junk = await answerSearch({ query: '', status: 'bogus' }, h.ctx, h.deps); // unknown → all
  assert.equal(junk.total, 3);
});

test('browse: agents and since filter, and limit sets truncated + pre-limit total', async () => {
  const h = harness({ entries: boardEntries() });
  const claude = await answerSearch({ query: '', agents: ['claude'] }, h.ctx, h.deps);
  assert.deepEqual(claude.groups.map((g) => g.sessionId), ['conv-gone', 'conv-a']);
  const recent = await answerSearch({ query: '', since: 2_500_000 }, h.ctx, h.deps);
  assert.deepEqual(recent.groups.map((g) => g.sessionId), ['conv-gone']);
  const limited = await answerSearch({ query: '', limit: 2 }, h.ctx, h.deps);
  assert.equal(limited.groups.length, 2);
  assert.equal(limited.total, 3);
  assert.equal(limited.truncated, true);
});

// ── search mode ─────────────────────────────────────────────────────────────

const SCAN_GROUP_A = {
  docIdx: 0, sessionId: 'conv-a', agent: 'claude', cwd: '/repos/site', title: 'Fix login',
  branch: 'main', lastTs: 1_000_000, matches: 2,
  hits: [{ ts: 1_000_000, role: 'user', snippet: 'x', hitStart: 0, hitChars: 1, headTrimmed: false, tailTrimmed: false }],
};
const scanRes = (groups) => ({
  query: 'q', matches: 2, shownHits: 1, groups, truncated: false,
  ms: 1, scannedBytes: 99, mode: 'resident', workers: 0, index: { records: 42 },
});

test('search: scan groups gain the board join, and a label-only match is APPENDED as a metaMatch group', async () => {
  const h = harness({ entries: boardEntries(), scanResult: scanRes([structuredClone(SCAN_GROUP_A)]) });
  // "migration" was never said in any conversation — it only exists in card-old's label.
  const res = await answerSearch({ query: 'migration' }, h.ctx, h.deps);
  assert.equal(res.browse, false);
  assert.equal(h.scans.length, 1);
  assert.deepEqual(res.groups.map((g) => g.sessionId), ['conv-a', 'conv-gone']); // scan first, meta appended
  const scan = res.groups[0];
  assert.equal(scan.cardId, 'card-a');
  assert.equal(scan.boardLabel, 'Login fixer');
  assert.equal(scan.metaMatch, undefined); // "migration" isn't in conv-a's metadata
  assert.equal(scan.matches, 2); // scan-portion semantics untouched
  const meta = res.groups[1];
  assert.equal(meta.metaMatch, true);
  assert.ok(meta.matchedFields.includes('label'));
  assert.deepEqual(meta.hits, []);
  assert.equal(meta.matches, 0);
  assert.equal(meta.noTranscript, true);
  assert.equal(res.matches, 2); // the scan's counts pass through
  assert.equal(res.scannedBytes, 99);
});

test('search: a scan group that ALSO metadata-matches is flagged in place, never duplicated', async () => {
  const h = harness({ entries: boardEntries(), scanResult: scanRes([structuredClone(SCAN_GROUP_A)]) });
  const res = await answerSearch({ query: 'login' }, h.ctx, h.deps); // matches conv-a's title AND label
  assert.equal(res.groups.filter((g) => g.sessionId === 'conv-a').length, 1);
  const g = res.groups.find((g) => g.sessionId === 'conv-a');
  assert.equal(g.metaMatch, true);
  assert.ok(g.matchedFields.includes('title'));
  assert.ok(g.matchedFields.includes('label'));
  assert.equal(g.hits.length, 1); // still the scan group, hits intact
});

test('search: multi-token AND over metadata', async () => {
  const h = harness({ entries: boardEntries() });
  const hit = await answerSearch({ query: 'ancient migration' }, h.ctx, h.deps);
  assert.deepEqual(hit.groups.map((g) => g.sessionId), ['conv-gone']);
  const miss = await answerSearch({ query: 'ancient zebra' }, h.ctx, h.deps);
  assert.deepEqual(miss.groups, []);
});

test('search: the status facet drops scan groups too, post-enrich', async () => {
  const h = harness({ entries: boardEntries(), scanResult: scanRes([structuredClone(SCAN_GROUP_A)]) });
  // conv-a is a live board card; asking for archived must drop the scan group
  // AND keep the archived metadata match.
  const res = await answerSearch({ query: 'migration', status: 'archived' }, h.ctx, h.deps);
  assert.deepEqual(res.groups.map((g) => g.sessionId), ['conv-gone']);
});

test('search: agents and since/until apply to meta-only rows via lastActivity', async () => {
  const h = harness({ entries: boardEntries() });
  const codexOnly = await answerSearch({ query: 'migration', agents: ['codex'] }, h.ctx, h.deps);
  assert.deepEqual(codexOnly.groups, []); // card-old is a claude session
  const tooOld = await answerSearch({ query: 'migration', since: 4_000_000 }, h.ctx, h.deps);
  assert.deepEqual(tooOld.groups, []); // lastActivity 3M < since
  const inRange = await answerSearch({ query: 'migration', since: 2_000_000, until: 4_000_000 }, h.ctx, h.deps);
  assert.deepEqual(inRange.groups.map((g) => g.sessionId), ['conv-gone']);
});

test('search: appended meta rows sort among themselves by lastActivity desc', async () => {
  const entries = new Map([
    ['c1', { liveSessionId: 'g1', agent: 'claude', lastLabel: 'shared-tag one', createdAt: 1_000, archivedAt: 5_000 }],
    ['c2', { liveSessionId: 'g2', agent: 'claude', lastLabel: 'shared-tag two', createdAt: 1_000, archivedAt: 9_000 }],
    ['c3', { liveSessionId: 'g3', agent: 'claude', lastLabel: 'shared-tag three', createdAt: 1_000, archivedAt: 7_000 }],
  ]);
  const h = harness({ docs: [], entries });
  const res = await answerSearch({ query: 'shared-tag' }, h.ctx, h.deps);
  assert.deepEqual(res.groups.map((g) => g.sessionId), ['g2', 'g3', 'g1']);
});

test('search: requestId rides the reply envelope in both modes', async () => {
  const h = harness({ entries: boardEntries() });
  assert.equal((await answerSearch({ query: '', requestId: 7 }, h.ctx, h.deps)).requestId, 7);
  assert.equal((await answerSearch({ query: 'login', requestId: 8 }, h.ctx, h.deps)).requestId, 8);
});
