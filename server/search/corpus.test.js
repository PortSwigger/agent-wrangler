import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { discoverSources, updateIndex, readMeta, statsOf, PATHS, _setIndexDir, _dropMetaCache, _resetPool } from './corpus.js';
import { search, _resetQueryPool, _dropResident } from './query.js';

// End-to-end over the real build → query path, on a throwaway transcript tree.

let root;
let claudeDir;
let codexDir;

function claudeLine(role, text, ts) {
  return JSON.stringify({
    type: role, message: { role, content: role === 'user' ? text : [{ type: 'text', text }] },
    timestamp: ts, sessionId: 'aaaaaaaa-1111-2222-3333-444444444444', cwd: '/repo/one',
  }) + '\n';
}
function codexLine(role, text, ts) {
  return JSON.stringify({
    timestamp: ts, type: 'response_item',
    payload: { type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] },
  }) + '\n';
}

async function reindex() {
  _dropMetaCache();
  _dropResident();
  const sources = await discoverSources({ claudeProjects: claudeDir, codexSessions: codexDir });
  return updateIndex({ sources });
}

test.before(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), 'aw-search-'));
  claudeDir = path.join(root, 'projects');
  codexDir = path.join(root, 'codex');
  await fsp.mkdir(path.join(claudeDir, '-repo-one'), { recursive: true });
  await fsp.mkdir(path.join(codexDir, '2026', '08'), { recursive: true });
  _setIndexDir(path.join(root, 'index'));

  await fsp.writeFile(
    path.join(claudeDir, '-repo-one', 'aaaaaaaa-1111-2222-3333-444444444444.jsonl'),
    JSON.stringify({ type: 'ai-title', aiTitle: 'Rebase help', sessionId: 'aaaaaaaa-1111-2222-3333-444444444444' }) + '\n'
      + claudeLine('user', 'How do I rebase onto MAIN?', '2026-08-01T10:00:00.000Z')
      + claudeLine('assistant', 'Use git rebase main. The Rebase is interactive.', '2026-08-01T10:00:05.000Z')
      + JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'rebase output nobody searches' }] } }) + '\n'
  );
  await fsp.writeFile(
    path.join(codexDir, '2026', '08', 'rollout-2026-08-02T09-00-00-bbbbbbbb-1111-2222-3333-444444444444.jsonl'),
    JSON.stringify({ type: 'session_meta', payload: { id: 'bbbbbbbb-1111-2222-3333-444444444444', cwd: '/repo/two', git: { branch: 'feature' } } }) + '\n'
      + codexLine('user', 'rebase this branch please', '2026-08-02T09:00:00.000Z')
      + codexLine('assistant', 'Done — rebased cleanly.', '2026-08-02T09:00:10.000Z')
  );
  await reindex();
});

test.after(async () => {
  await _resetQueryPool();
  await _resetPool();
  await fsp.rm(root, { recursive: true, force: true });
});

test('indexes conversation from both agents and skips tool output', async () => {
  const stats = statsOf(readMeta());
  assert.equal(stats.docs, 2);
  assert.equal(stats.records, 4); // 2 messages per conversation; the tool_result is not one
  const res = await search({ query: 'nobody searches' });
  assert.equal(res.matches, 0);
});

// Occurrences of "rebase" in the fixture: claude user ×1, claude assistant ×2
// ("rebase" + "Rebase"), codex user ×1, codex assistant ×1 ("rebased") = 5.
test('case-insensitive by default, exact when asked', async () => {
  const loose = await search({ query: 'rebase' });
  assert.equal(loose.matches, 5);
  const strict = await search({ query: 'Rebase', caseSensitive: true });
  assert.equal(strict.matches, 1);
});

test('whole word excludes matches inside longer words', async () => {
  assert.equal((await search({ query: 'rebase' })).matches, 5);
  assert.equal((await search({ query: 'rebase', wholeWord: true })).matches, 4); // not "rebased"
});

test('speaker and agent filters change the counts', async () => {
  assert.equal((await search({ query: 'rebase', roles: ['user'] })).matches, 2);
  assert.equal((await search({ query: 'rebase', roles: ['assistant'] })).matches, 3);
  assert.equal((await search({ query: 'rebase', agents: ['codex'] })).matches, 2);
  const claudeOnly = await search({ query: 'rebase', agents: ['claude'] });
  assert.equal(claudeOnly.groups.length, 1);
  assert.equal(claudeOnly.groups[0].title, 'Rebase help');
});

test('results carry the conversation, snippet and highlight offsets', async () => {
  const res = await search({ query: 'rebase onto' });
  const g = res.groups[0];
  assert.equal(g.agent, 'claude');
  assert.equal(g.cwd, '/repo/one');
  const hit = g.hits[0];
  assert.equal(hit.role, 'user');
  assert.equal(hit.snippet.slice(hit.hitStart, hit.hitStart + hit.hitChars).toLowerCase(), 'rebase onto');
  assert.equal(hit.ts, Date.parse('2026-08-01T10:00:00.000Z'));
});

test('the resident and worker scan paths agree', async () => {
  const a = await search({ query: 'rebase' });
  const b = await search({ query: 'rebase', mode: 'workers' });
  assert.equal(a.mode, 'resident');
  assert.equal(b.mode, 'workers');
  assert.equal(a.matches, b.matches);
  assert.deepEqual(a.groups.map((g) => [g.sessionId, g.matches]), b.groups.map((g) => [g.sessionId, g.matches]));
  assert.deepEqual(a.groups[0].hits.map((h) => h.snippet), b.groups[0].hits.map((h) => h.snippet));
});

test('an appended message is picked up without re-reading the file', async () => {
  const file = path.join(claudeDir, '-repo-one', 'aaaaaaaa-1111-2222-3333-444444444444.jsonl');
  const before = readMeta().sources[file].consumed;
  await fsp.appendFile(file, claudeLine('user', 'now squash the pumpkin commits', '2026-08-01T11:00:00.000Z'));
  const res = await reindex();
  assert.equal(res.filesRead, 1);
  // Only the appended tail was read, not the whole file.
  assert.ok(res.bytesRead < fs.statSync(file).size - before + 200);
  assert.ok(res.bytesRead > 0);
  assert.equal((await search({ query: 'pumpkin' })).matches, 1);
});

test('a half-written trailing line is left for the next pass', async () => {
  // A live session is appended to while the indexer reads it, so the tail is
  // routinely an incomplete line. It must be skipped, then picked up whole once
  // the writer finishes it — not indexed twice, and not lost.
  const file = path.join(claudeDir, '-repo-one', 'aaaaaaaa-1111-2222-3333-444444444444.jsonl');
  const whole = claudeLine('user', 'zucchini in a half-written line', '2026-08-01T12:00:00.000Z');
  await fsp.appendFile(file, whole.slice(0, 30));
  await reindex();
  assert.equal((await search({ query: 'zucchini' })).matches, 0);
  await fsp.appendFile(file, whole.slice(30));
  await reindex();
  assert.equal((await search({ query: 'zucchini' })).matches, 1);
});

test('a rewritten transcript replaces its old content instead of doubling it', async () => {
  const file = path.join(codexDir, '2026', '08', 'rollout-2026-08-02T09-00-00-bbbbbbbb-1111-2222-3333-444444444444.jsonl');
  await fsp.writeFile(file, codexLine('user', 'rebase this branch please', '2026-08-02T09:00:00.000Z'));
  await reindex();
  // Whether this lands via a tombstone or (as here, on a corpus small enough that
  // one dead conversation crosses COMPACT_RATIO) via the rebuild it triggers, the
  // observable result must be the same.
  assert.equal((await search({ query: 'rebase this branch please' })).matches, 1, 'the old copy must not still match');
  assert.equal((await search({ query: 'rebased cleanly' })).matches, 0, 'the dropped message is gone');
});

test('a deleted transcript keeps its indexed conversation', async () => {
  // Claude Code deletes transcripts past cleanupPeriodDays; the corpus is the
  // long-term record, so its content stays searchable.
  const file = path.join(claudeDir, '-repo-one', 'aaaaaaaa-1111-2222-3333-444444444444.jsonl');
  await fsp.rm(file);
  await reindex();
  assert.equal((await search({ query: 'pumpkin' })).matches, 1);
});

test('an empty query returns nothing rather than everything', async () => {
  assert.equal((await search({ query: '' })).matches, 0);
  assert.equal((await search({ query: '\0' })).matches, 0);
});

test('the index files live where PATHS says', () => {
  assert.ok(fs.existsSync(PATHS.text));
  assert.ok(fs.existsSync(PATHS.lc));
  assert.equal(fs.statSync(PATHS.lc).size, fs.statSync(PATHS.text).size, 'folded copy must stay byte-parallel');
});
