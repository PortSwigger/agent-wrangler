import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listResumable, resolveResumeDir, scanLine, findTranscript, launchCwd, recentCwds, subAgentsFrom, subagentDetail, analyze, analyzeLines, usageSince } from './transcript-reader.js';
import { costUsd } from './pricing.js';

const flat = (model, { input = 0, output = 0, cacheWrite5m = 0, cacheWrite1h = 0, cacheRead = 0 }) =>
  costUsd({ [model]: { input, output, cacheWrite5m, cacheWrite1h, cacheRead } });

const DAY = 86_400_000;
const NOW = 1_780_000_000_000; // fixed reference so window math is deterministic

// A projects/ tree like ~/.claude/projects: <encoded-cwd>/<sessionId>.jsonl.
function makeProjects() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aw-transcripts-'));
}

function writeTranscript(projectsDir, { sessionId, cwd = '/work/proj', summary = 'do the thing', ageDays = 0, pad = true }) {
  const bucket = path.join(projectsDir, cwd.replace(/[/.]/g, '-'));
  fs.mkdirSync(bucket, { recursive: true });
  const file = path.join(bucket, `${sessionId}.jsonl`);
  const lines = [
    JSON.stringify({ type: 'user', cwd, message: { role: 'user', content: summary }, timestamp: new Date(NOW - ageDays * DAY).toISOString() }),
  ];
  if (pad) lines.push(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'x'.repeat(300) } }));
  fs.writeFileSync(file, lines.join('\n') + '\n');
  const when = new Date(NOW - ageDays * DAY);
  fs.utimesSync(file, when, when);
  return file;
}

test('includes only sessions within the window, newest activity first', async () => {
  const dir = makeProjects();
  writeTranscript(dir, { sessionId: 'recent', ageDays: 1 });
  writeTranscript(dir, { sessionId: 'mid', ageDays: 3 });
  writeTranscript(dir, { sessionId: 'old', ageDays: 10 });

  const { candidates, total, windowDays } = await listResumable(new Set(), { windowDays: 7, now: NOW, projectsDir: dir });

  assert.equal(windowDays, 7);
  assert.deepEqual(candidates.map((c) => c.sessionId), ['recent', 'mid']);
  assert.equal(total, 2);
});

test('excludes sessions already represented on board or in history', async () => {
  const dir = makeProjects();
  writeTranscript(dir, { sessionId: 'keep', ageDays: 1 });
  writeTranscript(dir, { sessionId: 'drop', ageDays: 2 });

  const { candidates, total } = await listResumable(new Set(['drop']), { windowDays: 7, now: NOW, projectsDir: dir });

  assert.deepEqual(candidates.map((c) => c.sessionId), ['keep']);
  assert.equal(total, 1);
});

test('skips transcripts below the size floor', async () => {
  const dir = makeProjects();
  writeTranscript(dir, { sessionId: 'real', ageDays: 1 });
  writeTranscript(dir, { sessionId: 'tiny', ageDays: 1, summary: 'hi', pad: false });

  const { candidates } = await listResumable(new Set(), { windowDays: 7, now: NOW, projectsDir: dir });

  assert.deepEqual(candidates.map((c) => c.sessionId), ['real']);
});

test('widening the window pulls in older sessions', async () => {
  const dir = makeProjects();
  writeTranscript(dir, { sessionId: 'old', ageDays: 10 });

  const narrow = await listResumable(new Set(), { windowDays: 7, now: NOW, projectsDir: dir });
  assert.equal(narrow.total, 0);

  const wide = await listResumable(new Set(), { windowDays: 30, now: NOW, projectsDir: dir });
  assert.deepEqual(wide.candidates.map((c) => c.sessionId), ['old']);
  assert.equal(wide.total, 1);
});

test('resolveResumeDir prefers the recorded launch dir over caller-supplied cwds', async () => {
  const dir = makeProjects();
  writeTranscript(dir, { sessionId: 's1', cwd: '/Users/me/vcs/widget', ageDays: 1 });

  const resolved = await resolveResumeDir('s1', {
    graphCwd: '/some/worktree',
    entryCwd: '/another/dir',
    projectsDir: dir,
  });

  assert.equal(resolved, '/Users/me/vcs/widget');
});

test('resolveResumeDir falls back to the mapping cwd for an archived session whose transcript is gone', async () => {
  const dir = makeProjects(); // empty: archived session, no transcript on disk

  // graphCwd is null because archived sessions are off the board; the persisted
  // entry cwd is all we have. It must NOT resolve to null (→ home dir → broken resume).
  const resolved = await resolveResumeDir('vanished', {
    graphCwd: undefined,
    entryCwd: '/Users/me/vcs/project',
    projectsDir: dir,
  });

  assert.equal(resolved, '/Users/me/vcs/project');
});

function driveState() {
  return { totals: {}, subAgents: [], legacyAgents: new Map(), subFiles: new Map(), lastActivity: 0, summary: null, aiTitle: null, seenUsageIds: new Set() };
}

test('detects sub-agents from both Agent (current) and Task (legacy) tool calls', () => {
  const state = driveState();
  const dispatch = (name, input) =>
    JSON.stringify({ message: { content: [{ type: 'tool_use', name, input }] } });

  scanLine(dispatch('Agent', { subagent_type: 'code-reviewer', description: 'Review the diff' }), state);
  scanLine(dispatch('Task', { subagent_type: 'general-purpose', description: 'Legacy task' }), state);

  assert.deepEqual(
    [...state.legacyAgents.values()].map((a) => ({ agentType: a.agentType, label: a.label })),
    [
      { agentType: 'code-reviewer', label: 'Review the diff' },
      { agentType: 'general-purpose', label: 'Legacy task' },
    ],
  );
});

test('legacy: a matched Agent tool_use + tool_result pairs into one entry with timestamps', () => {
  const state = driveState();
  scanLine(JSON.stringify({ type: 'assistant', timestamp: '2026-07-09T10:00:00.000Z', message: { role: 'assistant', content: [
    { type: 'tool_use', id: 'toolu_1', name: 'Agent', input: { subagent_type: 'Explore', description: 'find X', prompt: 'go find X' } },
  ] } }), state);
  scanLine(JSON.stringify({ type: 'user', timestamp: '2026-07-09T10:01:30.000Z', message: { role: 'user', content: [
    { type: 'tool_result', tool_use_id: 'toolu_1', content: 'the answer' },
  ] } }), state);
  const a = [...state.legacyAgents.values()];
  assert.equal(a.length, 1);
  assert.equal(a[0].id, 'toolu_1');
  assert.equal(a[0].agentType, 'Explore');
  assert.equal(a[0].label, 'find X');
  assert.equal(a[0].startedAt, Date.parse('2026-07-09T10:00:00.000Z'));
  assert.equal(a[0].endedAt, Date.parse('2026-07-09T10:01:30.000Z'));
});

test('legacy: a dangling Agent tool_use (no tool_result yet) has endedAt null', () => {
  const state = driveState();
  scanLine(JSON.stringify({ type: 'assistant', timestamp: '2026-07-09T10:00:00.000Z', message: { role: 'assistant', content: [
    { type: 'tool_use', id: 'toolu_2', name: 'Task', input: { subagent_type: 'general-purpose', description: 'do Y' } },
  ] } }), state);
  const a = state.legacyAgents.get('toolu_2');
  assert.equal(a.endedAt, null);
  assert.equal(a.startedAt, Date.parse('2026-07-09T10:00:00.000Z'));
});

const jsonl = (...entries) => entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
function tmpSubagents(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-sub-'));
  const sd = path.join(dir, 'subagents');
  fs.mkdirSync(sd);
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(sd, name), content);
  return sd;
}

test('background: missing subagents dir yields empty array, no throw', async () => {
  const state = { subFiles: new Map() };
  const list = await subAgentsFrom(path.join(os.tmpdir(), 'does-not-exist-xyz-aw', 'subagents'), state);
  assert.deepEqual(list, []);
});

test('background: one file + meta.json yields one entry, usd summed with per-file dedup', async () => {
  const sd = tmpSubagents({
    'agent-aaa.meta.json': JSON.stringify({ agentType: 'general-purpose', description: 'diagram pipeline', toolUseId: 'toolu_x' }),
    'agent-aaa.jsonl': jsonl(
      { type: 'user', timestamp: '2026-07-09T09:00:00.000Z', message: { role: 'user', content: 'the prompt' } },
      { type: 'assistant', timestamp: '2026-07-09T09:00:05.000Z', message: { role: 'assistant', id: 'm1', model: 'claude-haiku-4-5-20251001', usage: { input_tokens: 100, output_tokens: 50 }, content: [{ type: 'text', text: 'hi' }] } },
      { type: 'assistant', timestamp: '2026-07-09T09:00:06.000Z', message: { role: 'assistant', id: 'm1', model: 'claude-haiku-4-5-20251001', usage: { input_tokens: 100, output_tokens: 50 }, content: [{ type: 'text', text: 'done' }] } },
    ),
  });
  const state = { subFiles: new Map() };
  const list = await subAgentsFrom(sd, state);
  assert.equal(list.length, 1);
  const e = list[0];
  assert.equal(e.id, 'aaa');
  assert.equal(e.kind, 'background');
  assert.equal(e.agentType, 'general-purpose');
  assert.equal(e.label, 'diagram pipeline');
  assert.equal(e.startedAt, Date.parse('2026-07-09T09:00:00.000Z'));
  assert.equal(e.endedAt, Date.parse('2026-07-09T09:00:06.000Z'));
  assert.ok(e.usd > 0);
  const state2 = { subFiles: new Map() };
  const single = await subAgentsFrom(tmpSubagents({
    'agent-bbb.meta.json': JSON.stringify({ agentType: 'x', description: 'y' }),
    'agent-bbb.jsonl': jsonl({ type: 'assistant', timestamp: '2026-07-09T09:00:05.000Z', message: { role: 'assistant', id: 'm1', model: 'claude-haiku-4-5-20251001', usage: { input_tokens: 100, output_tokens: 50 }, content: [{ type: 'text', text: 'hi' }] } }),
  }), state2);
  assert.ok(Math.abs(single[0].usd - e.usd) < 1e-9);
});

test('background: meta.json is read once and cached, not re-read every poll', async () => {
  const sd = tmpSubagents({
    'agent-fff.meta.json': JSON.stringify({ agentType: 'first', description: 'first label' }),
    'agent-fff.jsonl': jsonl({ type: 'user', timestamp: '2026-07-09T09:00:00.000Z', message: { role: 'user', content: 'go' } }),
  });
  const state = { subFiles: new Map() };
  const p1 = await subAgentsFrom(sd, state);
  assert.equal(p1[0].label, 'first label');
  // The sidecar changes on disk after the first poll — a real poll must NOT pick
  // this up, since it never legitimately changes after dispatch; observing the old
  // value proves the cache (not a fresh readFileSync) served this second poll.
  fs.writeFileSync(path.join(sd, 'agent-fff.meta.json'), JSON.stringify({ agentType: 'second', description: 'second label' }));
  const p2 = await subAgentsFrom(sd, state);
  assert.equal(p2[0].label, 'first label');
  assert.equal(p2[0].agentType, 'first');
});

test('background: missing meta.json falls back to a generic label, still discovered', async () => {
  const sd = tmpSubagents({
    'agent-nom.jsonl': jsonl({ type: 'user', timestamp: '2026-07-09T09:00:00.000Z', message: { role: 'user', content: 'go' } }),
  });
  const state = { subFiles: new Map() };
  const list = await subAgentsFrom(sd, state);
  assert.equal(list.length, 1);
  assert.equal(list[0].agentType, 'agent');
  assert.equal(list[0].label, 'sub-agent');
});

test('background: status running when file ends in a dangling tool_use, completed once settled past the quiet-poll grace period', async () => {
  const sd = tmpSubagents({
    'agent-ccc.meta.json': JSON.stringify({ agentType: 'x', description: 'y' }),
    'agent-ccc.jsonl': jsonl(
      { type: 'user', timestamp: '2026-07-09T09:00:00.000Z', message: { role: 'user', content: 'go' } },
      { type: 'assistant', timestamp: '2026-07-09T09:00:05.000Z', message: { role: 'assistant', id: 'm1', usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: '/a' } }] } },
    ),
  });
  const state = { subFiles: new Map() };
  const p1 = await subAgentsFrom(sd, state);
  assert.equal(p1[0].status, 'running');
  const file = path.join(sd, 'agent-ccc.jsonl');
  fs.appendFileSync(file, jsonl(
    { type: 'user', timestamp: '2026-07-09T09:00:06.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'ok' }] } },
    { type: 'assistant', timestamp: '2026-07-09T09:00:07.000Z', message: { role: 'assistant', id: 'm2', usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'text', text: 'all done' }] } },
  ));
  await subAgentsFrom(sd, state); // observes growth (still running)
  // A single quiet poll right after growth stops is exactly what an ordinary
  // inter-turn "thinking" pause looks like — must NOT flip to completed yet,
  // or status flickers running/completed every time a still-working sub-agent
  // pauses between tool calls (the bug this grace period exists to prevent).
  const p3 = await subAgentsFrom(sd, state);
  assert.equal(p3[0].status, 'running');
  const p4 = await subAgentsFrom(sd, state); // second consecutive quiet poll: settled
  assert.equal(p4[0].status, 'completed');
});

test('background: a single quiet poll between tool calls does not flip to completed if activity resumes before the grace period expires', async () => {
  const sd = tmpSubagents({
    'agent-flick.meta.json': JSON.stringify({ agentType: 'x', description: 'y' }),
    'agent-flick.jsonl': jsonl(
      { type: 'user', timestamp: '2026-07-09T09:00:00.000Z', message: { role: 'user', content: 'go' } },
      { type: 'assistant', timestamp: '2026-07-09T09:00:01.000Z', message: { role: 'assistant', id: 'm1', content: [{ type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: '/a' } }] } },
    ),
  });
  const state = { subFiles: new Map() };
  const p1 = await subAgentsFrom(sd, state);
  assert.equal(p1[0].status, 'running'); // dangling tool_use

  const file = path.join(sd, 'agent-flick.jsonl');
  fs.appendFileSync(file, jsonl(
    { type: 'user', timestamp: '2026-07-09T09:00:02.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'ok' }] } },
    { type: 'assistant', timestamp: '2026-07-09T09:00:03.000Z', message: { role: 'assistant', id: 'm2', content: [{ type: 'text', text: 'thinking about the next step' }] } },
  ));
  await subAgentsFrom(sd, state); // observes growth (resets the quiet-poll count) — still running
  // One quiet poll: the model is composing its next tool call, so nothing new
  // has been written yet — an entirely ordinary pause, not "finished". Must
  // stay running here, or every such pause would flicker the status.
  const quiet = await subAgentsFrom(sd, state);
  assert.equal(quiet[0].status, 'running');

  fs.appendFileSync(file, jsonl(
    { type: 'assistant', timestamp: '2026-07-09T09:00:05.000Z', message: { role: 'assistant', id: 'm3', content: [{ type: 'tool_use', id: 'tu2', name: 'Bash', input: { command: 'ls' } }] } },
  ));
  const resumed = await subAgentsFrom(sd, state); // the next tool call lands before the grace period expires
  assert.equal(resumed[0].status, 'running');
});

function tmpProject(sessionId, transcriptLines, subagentFiles = {}) {
  const projects = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-proj-'));
  const bucket = path.join(projects, 'proj');
  fs.mkdirSync(bucket);
  fs.writeFileSync(path.join(bucket, `${sessionId}.jsonl`), transcriptLines);
  if (Object.keys(subagentFiles).length) {
    const sd = path.join(bucket, sessionId, 'subagents');
    fs.mkdirSync(sd, { recursive: true });
    for (const [n, c] of Object.entries(subagentFiles)) fs.writeFileSync(path.join(sd, n), c);
  }
  return projects;
}

test('subagentDetail background: prompt, ordered toolCalls with targets, result', async () => {
  const projects = tmpProject('sess1', jsonl({ type: 'user', message: { role: 'user', content: 'hi' } }), {
    'agent-ddd.jsonl': jsonl(
      { type: 'user', message: { role: 'user', content: 'find the bug' } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/x.js' } }] } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'the answer is 42' }] } },
    ),
  });
  const d = await subagentDetail('sess1', 'ddd', projects);
  assert.equal(d.prompt, 'find the bug');
  assert.deepEqual(d.toolCalls, [{ name: 'Read', target: '/x.js' }, { name: 'Bash', target: 'npm test' }]);
  assert.equal(d.result, 'the answer is 42');
});

test('subagentDetail background with no tool calls yields toolCalls: []', async () => {
  const projects = tmpProject('sess2', jsonl({ type: 'user', message: { role: 'user', content: 'hi' } }), {
    'agent-eee.jsonl': jsonl(
      { type: 'user', message: { role: 'user', content: 'say hi' } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'hi there' }] } },
    ),
  });
  const d = await subagentDetail('sess2', 'eee', projects);
  assert.deepEqual(d.toolCalls, []);
  assert.equal(d.result, 'hi there');
});

test('subagentDetail legacy: toolCalls is null (data never existed), prompt+result from the pair', async () => {
  const projects = tmpProject('sess3', jsonl(
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_9', name: 'Agent', input: { subagent_type: 'Explore', description: 'd', prompt: 'the legacy prompt' } }] } },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_9', content: 'legacy result text' }] } },
  ));
  const d = await subagentDetail('sess3', 'toolu_9', projects);
  assert.equal(d.toolCalls, null);
  assert.equal(d.prompt, 'the legacy prompt');
  assert.equal(d.result, 'legacy result text');
});

test('findTranscript does not cache a miss, so a late-written transcript is found', async () => {
  // A freshly launched session is analysed before its first turn exists on disk;
  // caching that null would leave cost + last-activity blank for its whole life.
  const dir = makeProjects();
  assert.equal(await findTranscript('late', dir), null);

  const file = writeTranscript(dir, { sessionId: 'late', ageDays: 1 });
  assert.equal(await findTranscript('late', dir), file);
});

test('recentCwds orders distinct cwds most-recently-seen first', async () => {
  const dir = makeProjects();
  const bucket = path.join(dir, 'bucket');
  fs.mkdirSync(bucket, { recursive: true });
  const file = path.join(bucket, 'drifted.jsonl');
  fs.writeFileSync(file, [
    JSON.stringify({ type: 'user', cwd: '/launch/dir', message: { role: 'user', content: 'start' } }),
    JSON.stringify({ type: 'assistant', cwd: '/launch/dir', message: { role: 'assistant', content: 'ok' } }),
    JSON.stringify({ type: 'user', cwd: '/launch/dir/sibling-repo', message: { role: 'user', content: 'cd sibling-repo' } }),
  ].join('\n') + '\n');

  assert.deepEqual(await recentCwds('drifted', dir), ['/launch/dir/sibling-repo', '/launch/dir']);
  assert.equal(await launchCwd('drifted', dir), '/launch/dir');
});

test('recentCwds puts a resume-reverted launch-dir line ahead of the drifted repo it followed, not in place of it', async () => {
  // Mirrors the real regression: a dormant session resumed to deliver a diff
  // comment writes fresh lines back at the launch dir before doing anything else,
  // so the launch dir is newest but the real work is still the next distinct cwd.
  const dir = makeProjects();
  const bucket = path.join(dir, 'bucket');
  fs.mkdirSync(bucket, { recursive: true });
  const file = path.join(bucket, 'resumed.jsonl');
  fs.writeFileSync(file, [
    JSON.stringify({ type: 'user', cwd: '/launch/dir', message: { role: 'user', content: 'start' } }),
    JSON.stringify({ type: 'user', cwd: '/launch/dir/sibling-repo', message: { role: 'user', content: 'cd sibling-repo' } }),
    JSON.stringify({ type: 'assistant', cwd: '/launch/dir/sibling-repo', message: { role: 'assistant', content: 'made changes' } }),
    // resume boundary: a freshly-launched process's Bash-tool tracking restarts
    // from the launch dir, even though the conversation carries over.
    JSON.stringify({ type: 'user', cwd: '/launch/dir', message: { role: 'user', content: 'review comments' } }),
  ].join('\n') + '\n');

  assert.deepEqual(await recentCwds('resumed', dir), ['/launch/dir', '/launch/dir/sibling-repo']);
});

test('recentCwds returns an empty array when the transcript does not exist', async () => {
  const dir = makeProjects();
  assert.deepEqual(await recentCwds('nope', dir), []);
});

test('reports cwd and summary from the transcript head', async () => {
  const dir = makeProjects();
  writeTranscript(dir, { sessionId: 's1', cwd: '/Users/me/vcs/widget', summary: 'fix the parser', ageDays: 1 });

  const { candidates } = await listResumable(new Set(), { windowDays: 7, now: NOW, projectsDir: dir });

  assert.equal(candidates[0].cwd, '/Users/me/vcs/widget');
  assert.equal(candidates[0].summary, 'fix the parser');
});

test('ai-title records update aiTitle and the last one wins', () => {
  const state = { totals: {}, subAgents: [], lastActivity: 0, summary: null, aiTitle: null };
  scanLine(JSON.stringify({ type: 'ai-title', aiTitle: 'First title', sessionId: 'abc' }), state);
  assert.equal(state.aiTitle, 'First title');
  scanLine(JSON.stringify({ type: 'ai-title', aiTitle: 'Updated title', sessionId: 'abc' }), state);
  assert.equal(state.aiTitle, 'Updated title');
});

test('ai-title entries with missing or empty aiTitle are ignored', () => {
  const state = { totals: {}, subAgents: [], lastActivity: 0, summary: null, aiTitle: null };
  scanLine(JSON.stringify({ type: 'ai-title', sessionId: 'abc' }), state);
  scanLine(JSON.stringify({ type: 'ai-title', aiTitle: '', sessionId: 'abc' }), state);
  assert.equal(state.aiTitle, null);
});

// A dropped API connection ends the turn on a synthetic assistant message flagged
// isApiErrorMessage — matches the real shape Claude Code writes to the transcript
// (verified against on-disk sessions that hit "API Error: Connection closed
// mid-response"). Status file has no equivalent, so this is the only signal.
const apiErrorLine = () => JSON.stringify({
  type: 'assistant',
  message: {
    id: 'msg_err',
    role: 'assistant',
    model: '<synthetic>',
    content: [{ type: 'text', text: 'API Error: Connection closed mid-response. The response above may be incomplete.' }],
  },
  error: 'server_error',
  isApiErrorMessage: true,
});

test('an api-error message sets apiError, so a session left there is not silently idle', () => {
  const state = { totals: {}, subAgents: [], lastActivity: 0, summary: null, apiError: false };
  scanLine(apiErrorLine(), state);
  assert.equal(state.apiError, true);
});

test('apiError clears once the conversation moves past the error (retry or a new user turn)', () => {
  const state = { totals: {}, subAgents: [], lastActivity: 0, summary: null, apiError: false };
  scanLine(apiErrorLine(), state);
  assert.equal(state.apiError, true);
  scanLine(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Picking up where I left off.' }] } }), state);
  assert.equal(state.apiError, false);
});

test('apiError is unaffected by message-less lines (e.g. a compaction/summary marker)', () => {
  const state = { totals: {}, subAgents: [], lastActivity: 0, summary: null, apiError: false };
  scanLine(apiErrorLine(), state);
  scanLine(JSON.stringify({ type: 'summary', summary: 'compacted' }), state);
  assert.equal(state.apiError, true, 'a line with no message must not reset the flag');
});

test('a sidechain (legacy inline sub-agent) api-error does not flag the parent conversation', () => {
  const state = { totals: {}, subAgents: [], lastActivity: 0, summary: null, apiError: false };
  const sub = JSON.parse(apiErrorLine());
  sub.isSidechain = true;
  scanLine(JSON.stringify(sub), state);
  assert.equal(state.apiError, false);
});

// Verified against a real on-disk transcript: Claude Code auto-appends message-less
// bookkeeping lines (turn_duration, then later an away_summary) right after an
// api-error, well before the user's next real turn. Neither has a `message` field,
// so they must NOT clear apiError — only a genuine user/assistant turn should.
test('apiError survives the auto-appended system bookkeeping lines that follow a real error', () => {
  const state = { totals: {}, subAgents: [], lastActivity: 0, summary: null, apiError: false };
  scanLine(apiErrorLine(), state);
  scanLine(JSON.stringify({ type: 'system', subtype: 'turn_duration', durationMs: 389036 }), state);
  assert.equal(state.apiError, true);
  scanLine(JSON.stringify({ type: 'system', subtype: 'away_summary', content: 'catching up' }), state);
  assert.equal(state.apiError, true);
});

// Claude Code writes one transcript line per content block (thinking/text/tool_use)
// of a single assistant turn, and every line repeats the SAME usage object for that
// one API call. Without dedup a multi-block turn is billed 2-3x.
test('usage repeated across content-block lines sharing one message.id is counted once', () => {
  const state = { totals: {}, subAgents: [], lastActivity: 0, summary: null, seenUsageIds: new Set() };
  const usage = { input_tokens: 100, output_tokens: 50 };
  const line = (block) => JSON.stringify({
    type: 'assistant',
    message: { id: 'msg_1', role: 'assistant', model: 'claude-sonnet-4', usage, content: [block] },
  });

  scanLine(line({ type: 'thinking', thinking: 'hmm' }), state);
  scanLine(line({ type: 'text', text: 'hello' }), state);
  scanLine(line({ type: 'tool_use', name: 'Bash', input: {} }), state);

  assert.deepEqual(state.totals['claude-sonnet-4'], { input: 100, output: 50, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 });
});

test('usage lines with distinct message.ids are each counted', () => {
  const state = { totals: {}, subAgents: [], lastActivity: 0, summary: null, seenUsageIds: new Set() };
  const line = (id, inputTokens) => JSON.stringify({
    type: 'assistant',
    message: { id, role: 'assistant', model: 'claude-sonnet-4', usage: { input_tokens: inputTokens, output_tokens: 0 }, content: [{ type: 'text', text: 'x' }] },
  });

  scanLine(line('msg_1', 100), state);
  scanLine(line('msg_2', 200), state);

  assert.equal(state.totals['claude-sonnet-4'].input, 300);
});

test('usage lines with no message.id are never collapsed together', () => {
  const state = { totals: {}, subAgents: [], lastActivity: 0, summary: null, seenUsageIds: new Set() };
  const line = (inputTokens) => JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', model: 'claude-sonnet-4', usage: { input_tokens: inputTokens, output_tokens: 0 }, content: [{ type: 'text', text: 'x' }] },
  });

  scanLine(line(100), state);
  scanLine(line(200), state);

  assert.equal(state.totals['claude-sonnet-4'].input, 300);
});

// B2 needs to parse a transcript streamed out of a container (docker cp/exec cat)
// — content in memory, no path to poll-cache against. analyzeLines is the
// stateless entry point for that; it must agree with the incremental file-path
// analyze() on the numbers that matter (cost + tokens), since both share
// scanLine/emptyState/summarise.
test('analyzeLines yields the same usd + tokens as analyze(path) for the same content', async () => {
  const dir = makeProjects();
  const sessionId = 's-usage';
  const cwd = '/work/proj';
  const bucket = path.join(dir, cwd.replace(/[/.]/g, '-'));
  fs.mkdirSync(bucket, { recursive: true });
  const file = path.join(bucket, `${sessionId}.jsonl`);
  const lines = [
    JSON.stringify({ type: 'user', cwd, message: { role: 'user', content: 'fix the widget' }, timestamp: new Date(NOW).toISOString() }),
    JSON.stringify({
      type: 'assistant',
      message: {
        id: 'msg_1',
        role: 'assistant',
        model: 'claude-sonnet-4',
        usage: { input_tokens: 1200, output_tokens: 340, cache_read_input_tokens: 50, cache_creation_input_tokens: 20 },
        content: [{ type: 'text', text: 'Fixed it.' }],
      },
      timestamp: new Date(NOW + 1000).toISOString(),
    }),
  ];
  fs.writeFileSync(file, lines.join('\n') + '\n');

  const fromLines = analyzeLines(lines);
  const fromFile = await analyze(sessionId, dir);

  assert.deepEqual({ usd: fromLines.usd, tokens: fromLines.tokens }, { usd: fromFile.usd, tokens: fromFile.tokens });
  assert.ok(fromFile.usd > 0);
});

// A sub-agent's own turns are billed too, so the session total must include them.
// They're costed exactly like the parent (per-turn usage summed), from the SAME
// source analyze already uses for each sub-agent's displayed usd — never the inline
// toolUseResult aggregate, which reflects one settle, not every turn.
const OPUS = 'claude-opus-4-8';
const HAIKU = 'claude-haiku-4-5-20251001';
const parentTurn = jsonl({
  type: 'assistant', timestamp: '2026-07-09T09:00:00.000Z',
  message: { role: 'assistant', id: 'p1', model: OPUS, usage: { input_tokens: 1000, output_tokens: 200 }, content: [{ type: 'text', text: 'hi' }] },
});

test('analyze folds background sub-agent cost into the session total', async () => {
  const projects = tmpProject('cost-bg', parentTurn, {
    'agent-sa1.jsonl': jsonl({
      type: 'assistant', timestamp: '2026-07-09T09:00:05.000Z',
      message: { role: 'assistant', id: 's1', model: HAIKU, usage: { input_tokens: 5000, output_tokens: 400 }, content: [{ type: 'text', text: 'done' }] },
    }),
  });
  const parentUsd = flat(OPUS, { input: 1000, output: 200 });
  const subUsd = flat(HAIKU, { input: 5000, output: 400 });
  const r = await analyze('cost-bg', projects);
  assert.ok(Math.abs(r.usd - (parentUsd + subUsd)) < 1e-9, `usd ${r.usd} should equal parent+sub ${parentUsd + subUsd}`);
  assert.ok(Math.abs(r.subAgentUsd - subUsd) < 1e-9, `subAgentUsd ${r.subAgentUsd} should equal ${subUsd}`);
});

test('analyze ignores the inline sub-agent aggregate when a background transcript exists (no double count)', async () => {
  const projects = tmpProject('cost-nodup', jsonl(
    { type: 'assistant', timestamp: '2026-07-09T09:00:00.000Z', message: { role: 'assistant', id: 'p1', model: OPUS, usage: { input_tokens: 1000, output_tokens: 200 }, content: [{ type: 'tool_use', id: 'toolu_1', name: 'Agent', input: { subagent_type: 'Explore', description: 'look' } }] } },
    { type: 'user', timestamp: '2026-07-09T09:00:10.000Z', toolUseResult: { agentType: 'Explore', resolvedModel: HAIKU, totalTokens: 199998, usage: { input_tokens: 99999, output_tokens: 99999 } }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'result' }] } },
  ), {
    'agent-sa1.jsonl': jsonl({
      type: 'assistant', timestamp: '2026-07-09T09:00:05.000Z',
      message: { role: 'assistant', id: 's1', model: HAIKU, usage: { input_tokens: 5000, output_tokens: 400 }, content: [{ type: 'text', text: 'done' }] },
    }),
  });
  const parentUsd = flat(OPUS, { input: 1000, output: 200 });
  const subUsd = flat(HAIKU, { input: 5000, output: 400 });
  const r = await analyze('cost-nodup', projects);
  assert.ok(Math.abs(r.usd - (parentUsd + subUsd)) < 1e-9, `usd ${r.usd} must count the background turns, not the inline aggregate`);
});

test('analyze folds the legacy inline sub-agent aggregate when there is no background transcript', async () => {
  const projects = tmpProject('cost-legacy', jsonl(
    { type: 'assistant', timestamp: '2026-07-09T09:00:00.000Z', message: { role: 'assistant', id: 'p1', model: OPUS, usage: { input_tokens: 1000, output_tokens: 200 }, content: [{ type: 'tool_use', id: 'toolu_9', name: 'Agent', input: { subagent_type: 'Explore', description: 'look' } }] } },
    { type: 'user', timestamp: '2026-07-09T09:00:10.000Z', toolUseResult: { agentType: 'Explore', resolvedModel: HAIKU, usage: { input_tokens: 3000, output_tokens: 100 } }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_9', content: 'result' }] } },
  ));
  const parentUsd = flat(OPUS, { input: 1000, output: 200 });
  const subUsd = flat(HAIKU, { input: 3000, output: 100 });
  const r = await analyze('cost-legacy', projects);
  assert.ok(Math.abs(r.usd - (parentUsd + subUsd)) < 1e-9, `usd ${r.usd} should equal parent+legacy ${parentUsd + subUsd}`);
  assert.equal(r.subAgents.length, 1);
  assert.equal(r.subAgents[0].kind, 'legacy');
  assert.ok(Math.abs(r.subAgents[0].usd - subUsd) < 1e-9);
});

test('analyze leaves a legacy sub-agent uncounted when its tool_result carries no usage', async () => {
  const projects = tmpProject('cost-legacy-nousage', jsonl(
    { type: 'assistant', timestamp: '2026-07-09T09:00:00.000Z', message: { role: 'assistant', id: 'p1', model: OPUS, usage: { input_tokens: 1000, output_tokens: 200 }, content: [{ type: 'tool_use', id: 'toolu_7', name: 'Agent', input: { subagent_type: 'Explore', description: 'look' } }] } },
    { type: 'user', timestamp: '2026-07-09T09:00:10.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_7', content: 'result' }] } },
  ));
  const parentUsd = flat(OPUS, { input: 1000, output: 200 });
  const r = await analyze('cost-legacy-nousage', projects);
  assert.ok(Math.abs(r.usd - parentUsd) < 1e-9, `usd ${r.usd} should equal parent-only ${parentUsd}`);
  assert.equal(r.subAgents[0].usd, null);
  assert.equal(r.subAgentUsd, 0);
});

test('analyze reports apiError when a transcript ends on a dropped API connection', async () => {
  const projects = tmpProject('ends-in-api-error', jsonl(
    { type: 'user', timestamp: '2026-07-09T09:00:00.000Z', message: { role: 'user', content: 'do the thing' } },
    { type: 'assistant', timestamp: '2026-07-09T09:00:05.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'working on it' }] } },
    {
      type: 'assistant',
      timestamp: '2026-07-09T09:00:10.000Z',
      message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: 'API Error: Connection closed mid-response. The response above may be incomplete.' }] },
      error: 'server_error',
      isApiErrorMessage: true,
    },
  ));
  const r = await analyze('ends-in-api-error', projects);
  assert.equal(r.apiError, true);
});

test('analyze reports apiError false once a later turn moves past the dropped connection', async () => {
  const projects = tmpProject('recovered-from-api-error', jsonl(
    {
      type: 'assistant',
      timestamp: '2026-07-09T09:00:00.000Z',
      message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: 'API Error: Connection closed mid-response. The response above may be incomplete.' }] },
      error: 'server_error',
      isApiErrorMessage: true,
    },
    { type: 'assistant', timestamp: '2026-07-09T09:00:05.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Picking back up.' }] } },
  ));
  const r = await analyze('recovered-from-api-error', projects);
  assert.equal(r.apiError, false);
});

// --- fork cost: a fork's transcript REPLAYS the parent's whole history --------
// `claude --resume <parent> --fork-session` copies every parent line into the fork's
// own jsonl (same uuids, same message.ids, same timestamps — only the per-line
// sessionId is rewritten), then appends the fork's own turns. Costing from byte 0
// therefore re-bills the parent on the fork's card. `since` (the fork's createdAt)
// is the bound: every copied line predates it by construction.
const FORK_AT = Date.parse('2026-07-09T12:00:00.000Z');
const inherited = jsonl(
  { type: 'user', timestamp: '2026-07-09T09:00:00.000Z', message: { role: 'user', content: 'parent prompt' } },
  { type: 'assistant', timestamp: '2026-07-09T09:00:01.000Z', message: { role: 'assistant', id: 'parent1', model: OPUS, usage: { input_tokens: 9000, output_tokens: 900 }, content: [{ type: 'text', text: 'parent work' }] } },
).trimEnd();
const ownTurn = jsonl(
  { type: 'assistant', timestamp: '2026-07-09T12:00:30.000Z', message: { role: 'assistant', id: 'own1', model: OPUS, usage: { input_tokens: 1000, output_tokens: 200 }, content: [{ type: 'text', text: 'fork work' }] } },
).trimEnd();

test('analyze with since bills only the turns after the fork point, not the replayed parent history', async () => {
  const projects = tmpProject('fork-own-only', `${inherited}\n${ownTurn}\n`);
  const r = await analyze('fork-own-only', projects, { since: FORK_AT });
  const ownUsd = flat(OPUS, { input: 1000, output: 200 });
  assert.ok(Math.abs(r.usd - ownUsd) < 1e-9, `usd ${r.usd} should equal the fork's own spend ${ownUsd}, not parent+own`);
  assert.deepEqual(r.tokens, { input: 1000, output: 200, cacheWrite: 0, cacheRead: 0 });
});

test('analyze without since is unchanged, so a non-fork card still bills its whole transcript', async () => {
  const projects = tmpProject('no-bound', `${inherited}\n${ownTurn}\n`);
  const r = await analyze('no-bound', projects);
  const bothUsd = flat(OPUS, { input: 9000, output: 900 }) + flat(OPUS, { input: 1000, output: 200 });
  assert.ok(Math.abs(r.usd - bothUsd) < 1e-9, `usd ${r.usd} should equal the full transcript ${bothUsd}`);
});

test('analyze with since drops the parent legacy sub-agents copied into a fork transcript', async () => {
  const projects = tmpProject('fork-legacy-subs', jsonl(
    { type: 'assistant', timestamp: '2026-07-09T09:00:00.000Z', message: { role: 'assistant', id: 'parent1', model: OPUS, usage: { input_tokens: 9000, output_tokens: 900 }, content: [{ type: 'tool_use', id: 'toolu_inherited', name: 'Agent', input: { subagent_type: 'Explore', description: 'parent look' } }] } },
    { type: 'user', timestamp: '2026-07-09T09:00:10.000Z', toolUseResult: { agentType: 'Explore', resolvedModel: HAIKU, usage: { input_tokens: 3000, output_tokens: 100 } }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_inherited', content: 'result' }] } },
    { type: 'assistant', timestamp: '2026-07-09T12:00:30.000Z', message: { role: 'assistant', id: 'own1', model: OPUS, usage: { input_tokens: 1000, output_tokens: 200 }, content: [{ type: 'tool_use', id: 'toolu_own', name: 'Agent', input: { subagent_type: 'Explore', description: 'fork look' } }] } },
    { type: 'user', timestamp: '2026-07-09T12:00:40.000Z', toolUseResult: { agentType: 'Explore', resolvedModel: HAIKU, usage: { input_tokens: 500, output_tokens: 40 } }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_own', content: 'result' }] } },
  ));
  const r = await analyze('fork-legacy-subs', projects, { since: FORK_AT });
  assert.deepEqual(r.subAgents.map((s) => s.label), ['fork look'], 'the parent\'s copied sub-agent must not appear on the fork');
  const ownSubUsd = flat(HAIKU, { input: 500, output: 40 });
  assert.ok(Math.abs(r.subAgentUsd - ownSubUsd) < 1e-9, `subAgentUsd ${r.subAgentUsd} should equal ${ownSubUsd}`);
});

// Only the .jsonl is replayed — the subagents/ dir is keyed by the fork's OWN session
// id and is never copied (verified on disk: every agent file under a real fork's dir
// postdates the fork). So background sub-agents are always the fork's own work and the
// bound must leave them alone; only the inline pairs above are ever inherited.
test('analyze with since still counts background sub-agents, which are never inherited by a fork', async () => {
  const projects = tmpProject('fork-bg-subs', `${inherited}\n${ownTurn}\n`, {
    'agent-sa1.jsonl': jsonl({
      type: 'assistant', timestamp: '2026-07-09T12:00:35.000Z',
      message: { role: 'assistant', id: 's1', model: HAIKU, usage: { input_tokens: 5000, output_tokens: 400 }, content: [{ type: 'text', text: 'done' }] },
    }),
  });
  const r = await analyze('fork-bg-subs', projects, { since: FORK_AT });
  const expected = flat(OPUS, { input: 1000, output: 200 }) + flat(HAIKU, { input: 5000, output: 400 });
  assert.ok(Math.abs(r.usd - expected) < 1e-9, `usd ${r.usd} should equal own turns + background sub ${expected}`);
});

test('analyzeLines honours since, so a devcontainer fork agrees with the file path', async () => {
  const lines = [...inherited.split('\n'), ...ownTurn.split('\n')];
  const r = analyzeLines(lines, { since: FORK_AT });
  const ownUsd = flat(OPUS, { input: 1000, output: 200 });
  assert.ok(Math.abs(r.usd - ownUsd) < 1e-9, `usd ${r.usd} should equal the fork's own spend ${ownUsd}`);
});

// The fork's label/age must NOT change: forkEntry deliberately inherits the parent's
// intent and name, and the [FORK] marker relies on the inherited summary still
// resolving. Only usage is bounded.
test('analyze with since keeps the inherited summary and last activity', async () => {
  const projects = tmpProject('fork-meta', `${inherited}\n${ownTurn}\n`);
  const r = await analyze('fork-meta', projects, { since: FORK_AT });
  assert.equal(r.summary, 'parent prompt');
  assert.equal(r.lastActivity, Date.parse('2026-07-09T12:00:30.000Z'));
});

test('usageSince bounds a fork at its createdAt and leaves every other entry unbounded', () => {
  assert.equal(usageSince({ forkedFrom: 'PARENT1', createdAt: 1700 }), 1700);
  assert.equal(usageSince({ createdAt: 1700 }), 0, 'a plain session bills its whole transcript');
  assert.equal(usageSince(null), 0);
  // A pre-split fork entry has no createdAt. Unbounded keeps the (over-counted) old
  // number rather than silently zeroing the card's whole cost.
  assert.equal(usageSince({ forkedFrom: 'PARENT1' }), 0);
});
