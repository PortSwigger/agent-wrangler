import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normaliseComments, parseTriage, triageInput, summariseComments, commentsBlockMerge, MAX_COMMENTS, MAX_BODY } from './job-comments.js';

const user = (login) => ({ login, __typename: 'User' });
const c = (id, body, at, login = 'alice') => ({ id, author: user(login), body, createdAt: at, updatedAt: at, url: `https://github.com/o/r/pull/1#${id}` });
const base = { author: { login: 'agent' }, comments: { nodes: [] }, reviews: { nodes: [] }, reviewThreads: { nodes: [] } };

test('normaliseComments flattens comments, submitted reviews and threads in time order and skips containers', () => {
  const out = normaliseComments({ ...base,
    comments: { nodes: [c('c2', 'later', '2026-09-08T10:02:00Z')] },
    reviews: { nodes: [
      { id: 'r1', author: user('bob'), state: 'COMMENTED', body: '', submittedAt: '2026-09-08T10:00:00Z', updatedAt: '2026-09-08T10:00:00Z', url: 'u' },
      { id: 'r2', author: user('bob'), state: 'PENDING', body: 'draft', submittedAt: null, updatedAt: '2026-09-08T10:00:00Z', url: 'u' },
      { id: 'r3', author: user('bob'), state: 'CHANGES_REQUESTED', body: '', submittedAt: '2026-09-08T10:01:00Z', updatedAt: '2026-09-08T10:01:00Z', url: 'u' },
    ] },
    reviewThreads: { nodes: [{ id: 't1', isResolved: false, isOutdated: true, path: 'a.js', line: 3, comments: { nodes: [c('tc1', 'fix this', '2026-09-08T10:00:30Z', 'bob')] } }] },
  }, 5);
  assert.deepEqual(out.items.map((i) => i.id), ['tc1', 'r3', 'c2']);
  assert.equal(out.items[0].kind, 'thread'); assert.equal(out.items[0].resolved, false); assert.equal(out.items[0].outdated, true); assert.equal(out.items[0].path, 'a.js');
  assert.equal(out.items[1].state, 'CHANGES_REQUESTED'); assert.equal(out.unresolved, 1); assert.equal(out.prAuthor, 'agent'); assert.equal(out.fetchedAt, 5);
});

test('fingerprint moves on edits and thread resolution, bodies are clipped and the oldest overflow is dropped', () => {
  const thread = (resolved, updatedAt = '2026-09-08T10:00:00Z') => normaliseComments({ ...base, reviewThreads: { nodes: [{ id: 't1', isResolved: resolved, comments: { nodes: [{ ...c('tc1', 'x', '2026-09-08T10:00:00Z'), updatedAt }] } }] } });
  assert.equal(thread(false).fingerprint, thread(false).fingerprint);
  assert.notEqual(thread(false).fingerprint, thread(true).fingerprint);
  assert.notEqual(thread(false).fingerprint, thread(false, '2026-09-08T11:00:00Z').fingerprint);
  const many = normaliseComments({ ...base, comments: { nodes: Array.from({ length: MAX_COMMENTS + 3 }, (_, i) => c(`c${i}`, 'y'.repeat(MAX_BODY + 50), `2026-09-08T10:${String(i % 60).padStart(2, '0')}:${String(Math.floor(i / 60)).padStart(2, '0')}Z`)) } });
  assert.equal(many.items.length, MAX_COMMENTS); assert.equal(many.truncated, 3); assert.ok(many.items[0].body.length <= MAX_BODY + 2);
  assert.throws(() => normaliseComments(null), /not found/);
});

test('parseTriage accepts only a well-formed verdict and shortens the summary', () => {
  assert.deepEqual(parseTriage('Here you go: {"tone":"amber","summary":"Bob asked  about\\nthe retry loop."}'), { tone: 'amber', text: 'Bob asked about the retry loop.' });
  assert.equal(parseTriage('{"tone":"purple","summary":"x"}'), null);
  assert.equal(parseTriage('{"tone":"red"}'), null);
  assert.equal(parseTriage('I do not see any comments'), null);
  assert.ok(parseTriage(`{"tone":"green","summary":"${'a'.repeat(900)}"}`).text.length <= 402);
});

test('summariseComments turns a failed or confused run into an amber unavailable verdict', async () => {
  const comments = normaliseComments({ ...base, comments: { nodes: [c('c1', 'hi', '2026-09-08T10:00:00Z')] } });
  const ok = await summariseComments(comments, { url: 'u' }, { run: async (prompt, stdin) => { assert.match(prompt, /"red"/); assert.match(stdin, /"author":"alice"/); return { text: '{"tone":"green","summary":"All fine."}', liveSessionId: 'L1', error: null }; } });
  assert.deepEqual(ok, { tone: 'green', text: 'All fine.', liveSessionId: 'L1', error: false });
  const failed = await summariseComments(comments, {}, { run: async () => ({ text: null, liveSessionId: 'L2', error: new Error('spawn claude ENOENT\nmore') }) });
  assert.equal(failed.tone, 'amber'); assert.equal(failed.error, true); assert.match(failed.text, /ENOENT/); assert.equal(failed.liveSessionId, 'L2');
  const confused = await summariseComments(comments, {}, { run: async () => ({ text: 'No comments were provided.', liveSessionId: 'L3', error: null }) });
  assert.equal(confused.tone, 'amber'); assert.match(confused.text, /unrecognised/);
});

test('triageInput shrinks bodies rather than sending an oversized payload', () => {
  const comments = normaliseComments({ ...base, comments: { nodes: Array.from({ length: 80 }, (_, i) => c(`c${i}`, 'z'.repeat(MAX_BODY), '2026-09-08T10:00:00Z')) } });
  const text = triageInput(comments, { url: 'u', branch: 'b' });
  assert.ok(text.length <= 60000); assert.equal(JSON.parse(text).comments.length, 80);
});

test('commentsBlockMerge holds on a missing, stale or red verdict and only when comments exist', () => {
  const comments = { items: [{ id: 'c1' }], fingerprint: 'f1' };
  assert.equal(commentsBlockMerge({ prComments: null }), false);
  assert.equal(commentsBlockMerge({ prComments: { items: [], fingerprint: 'e' }, commentSummary: { tone: 'red', fingerprint: 'e' } }), false);
  assert.equal(commentsBlockMerge({ prComments: comments }), true);
  assert.equal(commentsBlockMerge({ prComments: comments, commentSummary: { tone: 'green', fingerprint: 'old' } }), true);
  assert.equal(commentsBlockMerge({ prComments: comments, commentSummary: { tone: 'red', fingerprint: 'f1' } }), true);
  for (const tone of ['green', 'amber']) assert.equal(commentsBlockMerge({ prComments: comments, commentSummary: { tone, fingerprint: 'f1' } }), false);
});
