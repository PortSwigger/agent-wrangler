import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getSessionActivityTool } from './get-session-activity.js';

const DAY = 86_400_000;

function makeProjects() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aw-activity-'));
}

// One line per message timestamp, in a bucket dir keyed by cwd (the exact
// encoding doesn't matter here — activityInRange finds by session id, not path).
function writeTranscript(projectsDir, sessionId, cwd, timestamps) {
  const bucket = path.join(projectsDir, cwd.replace(/[/.]/g, '-'));
  fs.mkdirSync(bucket, { recursive: true });
  const lines = timestamps.map((iso) => JSON.stringify({
    type: 'user', cwd, message: { role: 'user', content: 'hi' }, timestamp: iso,
  }));
  fs.writeFileSync(path.join(bucket, `${sessionId}.jsonl`), lines.join('\n') + '\n');
}

// A Codex rollout: every line has a top-level timestamp; only event_msg
// user_message/agent_message payloads count as real turns (mirrors production).
// `extraLines` lets a test inject noise (e.g. a response_item/user block) to
// prove it's ignored.
function writeRollout(sessionsDir, sessionId, lines) {
  const bucket = fs.mkdtempSync(path.join(sessionsDir, 'rollout-'));
  const file = path.join(bucket, `rollout-2026-07-01T00-00-00-${sessionId}.jsonl`);
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

function turn(kind, iso) {
  return { timestamp: iso, type: 'event_msg', payload: { type: kind, message: 'hi' } };
}

function deps(projectsDir, { entries = [], tasks = {}, codexSessionsDir } = {}) {
  const active = entries.filter((e) => !e.archivedAt);
  const archived = entries.filter((e) => e.archivedAt);
  return {
    projectsDir,
    codexSessionsDir,
    sessionManager: {
      activeEntries: () => active,
      archivedEntries: () => archived,
    },
    taskStore: { taskFor: (sid) => tasks[sid] ?? null },
  };
}

test('finds a session active on the requested day via its transcript', async () => {
  const dir = makeProjects();
  writeTranscript(dir, 'live1', '/work/a', [
    '2026-07-01T09:00:00.000Z',
    '2026-07-01T09:05:00.000Z',
    '2026-07-02T08:00:00.000Z', // outside the requested day
  ]);
  const entries = [{ sessionId: 'CARD1', liveSessionId: 'live1', name: 'Redaction pipeline', cwd: '/work/a', createdAt: Date.parse('2026-07-01T00:00:00.000Z') }];

  const out = await getSessionActivityTool.handler({ deps: deps(dir, { entries, tasks: { CARD1: { id: 'T1', name: 'Pipeline' } } }) }, { date: '2026-07-01' });

  assert.equal(out.structuredContent.sessions.length, 1);
  const s = out.structuredContent.sessions[0];
  assert.equal(s.sessionId, 'CARD1');
  assert.equal(s.label, 'Redaction pipeline');
  assert.equal(s.messageCount, 2);
  assert.equal(s.firstActivity, '2026-07-01T09:00:00.000Z');
  assert.equal(s.lastActivity, '2026-07-01T09:05:00.000Z');
  assert.deepEqual(s.task, { id: 'T1', name: 'Pipeline' });
  assert.equal(s.archived, false);
});

test('includes archived sessions that list_sessions would drop', async () => {
  const dir = makeProjects();
  writeTranscript(dir, 'live2', '/work/b', ['2026-07-01T12:00:00.000Z']);
  const entries = [{ sessionId: 'CARD2', liveSessionId: 'live2', cwd: '/work/b', archivedAt: Date.parse('2026-07-03T00:00:00.000Z') }];

  const out = await getSessionActivityTool.handler({ deps: deps(dir, { entries }) }, { date: '2026-07-01' });

  assert.equal(out.structuredContent.sessions.length, 1);
  assert.equal(out.structuredContent.sessions[0].archived, true);
});

test('excludes a session with no activity that day even if its lifetime spans it', async () => {
  const dir = makeProjects();
  writeTranscript(dir, 'live3', '/work/c', ['2026-07-01T09:00:00.000Z', '2026-07-02T08:00:00.000Z']);
  // Lifetime runs 07-01 through 07-05, so the requested day (07-03) passes the
  // window prefilter — this exercises activityInRange returning zero messages,
  // not the prefilter short-circuit.
  const entries = [{ sessionId: 'CARD3', liveSessionId: 'live3', cwd: '/work/c', createdAt: Date.parse('2026-07-01T00:00:00.000Z'), suspendedAt: Date.parse('2026-07-05T09:00:00.000Z') }];

  const out = await getSessionActivityTool.handler({ deps: deps(dir, { entries }) }, { date: '2026-07-03' });

  assert.deepEqual(out.structuredContent.sessions, []);
});

test('finds a codex session active on the requested day via its rollout', async () => {
  const dir = makeProjects();
  const codexDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-activity-codex-'));
  const uuid = '11111111-1111-1111-1111-111111111111';
  writeRollout(codexDir, uuid, [
    turn('user_message', '2026-07-01T09:00:00.000Z'),
    turn('agent_message', '2026-07-01T09:00:05.000Z'),
    turn('user_message', '2026-07-02T08:00:00.000Z'), // outside the requested day
  ]);
  const entries = [{ sessionId: 'CARD4', liveSessionId: uuid, cwd: '/work/d', agent: 'codex' }];

  const out = await getSessionActivityTool.handler({ deps: deps(dir, { entries, codexSessionsDir: codexDir }) }, { date: '2026-07-01' });

  assert.equal(out.structuredContent.sessions.length, 1);
  const s = out.structuredContent.sessions[0];
  assert.equal(s.messageCount, 2);
  assert.equal(s.agent, 'codex');
  assert.equal(s.firstActivity, '2026-07-01T09:00:00.000Z');
  assert.equal(s.lastActivity, '2026-07-01T09:00:05.000Z');
});

test('ignores injected environment_context noise in a codex rollout, not just event_msg turns', async () => {
  const dir = makeProjects();
  const codexDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-activity-codex-'));
  const uuid = '22222222-2222-2222-2222-222222222222';
  writeRollout(codexDir, uuid, [
    // Codex injects this shape for context, not something the user typed —
    // must not be mistaken for a real turn.
    { timestamp: '2026-07-01T09:00:00.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>...' }] } },
  ]);
  const entries = [{ sessionId: 'CARD9', liveSessionId: uuid, cwd: '/work/i', agent: 'codex' }];

  const out = await getSessionActivityTool.handler({ deps: deps(dir, { entries, codexSessionsDir: codexDir }) }, { date: '2026-07-01' });

  assert.deepEqual(out.structuredContent.sessions, []);
});

test('falls back to the card id when liveSessionId is absent (legacy entries)', async () => {
  const dir = makeProjects();
  writeTranscript(dir, 'CARD5', '/work/e', ['2026-07-01T09:00:00.000Z']);
  const entries = [{ sessionId: 'CARD5', cwd: '/work/e' }];

  const out = await getSessionActivityTool.handler({ deps: deps(dir, { entries }) }, { date: '2026-07-01' });

  assert.equal(out.structuredContent.sessions.length, 1);
  assert.equal(out.structuredContent.sessions[0].sessionId, 'CARD5');
});

test('supports a multi-day range and sorts newest activity first', async () => {
  const dir = makeProjects();
  writeTranscript(dir, 'live6', '/work/f', ['2026-07-01T09:00:00.000Z']);
  writeTranscript(dir, 'live7', '/work/g', ['2026-07-02T09:00:00.000Z']);
  const entries = [
    { sessionId: 'CARD6', liveSessionId: 'live6', cwd: '/work/f' },
    { sessionId: 'CARD7', liveSessionId: 'live7', cwd: '/work/g' },
  ];

  const out = await getSessionActivityTool.handler({ deps: deps(dir, { entries }) }, { date: '2026-07-01', endDate: '2026-07-02' });

  assert.deepEqual(out.structuredContent.sessions.map((s) => s.sessionId), ['CARD7', 'CARD6']);
  assert.deepEqual(out.structuredContent.range, { start: '2026-07-01', end: '2026-07-02' });
});

test('tolerates a session with no transcript on disk at all', async () => {
  const dir = makeProjects();
  const entries = [{ sessionId: 'CARD8', liveSessionId: 'ghost', cwd: '/work/h' }];

  const out = await getSessionActivityTool.handler({ deps: deps(dir, { entries }) }, { date: '2026-07-01' });

  assert.deepEqual(out.structuredContent.sessions, []);
});
