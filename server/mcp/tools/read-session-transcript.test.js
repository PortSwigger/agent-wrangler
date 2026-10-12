import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readSessionTranscriptTool, clipText } from './read-session-transcript.js';

function writeTranscript(projectsDir, sessionId, lines) {
  const bucket = path.join(projectsDir, '-work-a');
  fs.mkdirSync(bucket, { recursive: true });
  const file = path.join(bucket, `${sessionId}.jsonl`);
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return file;
}

function userLine(text, i) {
  return { type: 'user', cwd: '/work/a', message: { role: 'user', content: text }, timestamp: new Date(Date.UTC(2026, 6, 1, 9, i)).toISOString() };
}

function assistantLine(text, i) {
  return { type: 'assistant', cwd: '/work/a', message: { role: 'assistant', content: [{ type: 'text', text }] }, timestamp: new Date(Date.UTC(2026, 6, 1, 9, i)).toISOString() };
}

function deps(projectsDir, entries) {
  return {
    projectsDir,
    // Real mapping entries are keyed by card id and don't carry it themselves.
    sessionManager: { entryFor: (id) => { const e = entries.find((x) => x.sessionId === id); if (!e) return null; const { sessionId, ...rest } = e; return rest; } },
  };
}

function setup(lines, entry = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-read-transcript-'));
  const file = writeTranscript(dir, 'live1', lines);
  const entries = [{ sessionId: 'CARD1', liveSessionId: 'live1', name: 'Redaction pipeline', cwd: '/work/a', ...entry }];
  return { dir, file, d: deps(dir, entries) };
}

test('returns every turn and the transcript path when the conversation is short', async () => {
  const { file, d } = setup([userLine('fix the bug', 0), assistantLine('Fixed it.', 1)]);

  const out = await readSessionTranscriptTool.handler({ deps: d }, { sessionId: 'CARD1' });

  const s = out.structuredContent;
  assert.equal(s.sessionId, 'CARD1');
  assert.equal(s.label, 'Redaction pipeline');
  assert.equal(s.totalMessages, 2);
  assert.equal(s.omittedMessages, 0);
  assert.deepEqual(s.messages.map((m) => [m.role, m.text]), [['user', 'fix the bug'], ['assistant', 'Fixed it.']]);
  assert.equal(s.transcriptPath, file);
  assert.match(out.content[0].text, new RegExp(`read ${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
});

test('keeps only the first 5 and last 5 of a long conversation', async () => {
  const lines = [];
  for (let i = 0; i < 20; i += 1) lines.push(i % 2 ? assistantLine(`a${i}`, i) : userLine(`u${i}`, i));
  const { d } = setup(lines);

  const s = (await readSessionTranscriptTool.handler({ deps: d }, { sessionId: 'CARD1' })).structuredContent;

  assert.equal(s.totalMessages, 20);
  assert.equal(s.omittedMessages, 10);
  assert.deepEqual(s.messages.map((m) => m.text), ['u0', 'a1', 'u2', 'a3', 'u4', 'a15', 'u16', 'a17', 'u18', 'a19']);
});

test('drops tool calls and harness wrappers, keeping only conversation text', async () => {
  const { d } = setup([
    userLine('<command-name>/clear</command-name>', 0),
    userLine('real question', 1),
    { type: 'assistant', cwd: '/work/a', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] }, timestamp: '2026-07-01T09:02:00.000Z' },
    { type: 'user', cwd: '/work/a', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'a\nb' }] }, timestamp: '2026-07-01T09:03:00.000Z' },
    assistantLine('answer', 4),
  ]);

  const s = (await readSessionTranscriptTool.handler({ deps: d }, { sessionId: 'CARD1' })).structuredContent;

  assert.deepEqual(s.messages.map((m) => [m.role, m.text]), [['user', 'real question'], ['assistant', 'answer']]);
});

test('clipText keeps the start and end of a long message', () => {
  const words = Array.from({ length: 1000 }, (_, i) => `w${i}`);
  const out = clipText(words.join(' '));
  assert.ok(out.startsWith('w0 w1 '));
  assert.ok(out.endsWith('w998 w999'));
  assert.match(out, /…\[760 words omitted\]…/);
  assert.ok(!out.includes(' w500 '));
  assert.equal(clipText('short message'), 'short message');
});

test('lists transcripts from conversations the session cleared away', async () => {
  const { dir, d } = setup([userLine('after clear', 0)], { priorLiveSessionIds: ['pre-clear'] });
  const earlier = writeTranscript(dir, 'pre-clear', [userLine('before clear', 0)]);

  const s = (await readSessionTranscriptTool.handler({ deps: d }, { sessionId: 'CARD1' })).structuredContent;

  assert.deepEqual(s.messages.map((m) => m.text), ['after clear']);
  assert.deepEqual(s.earlierTranscriptPaths, [earlier]);
});

test('errors for an unknown session or one with no transcript yet', async () => {
  const { dir } = setup([userLine('x', 0)]);
  const unknown = await readSessionTranscriptTool.handler({ deps: deps(dir, []) }, { sessionId: 'NOPE' });
  assert.equal(unknown.isError, true);

  const fresh = await readSessionTranscriptTool.handler({ deps: deps(dir, [{ sessionId: 'CARD2' }]) }, { sessionId: 'CARD2' });
  assert.equal(fresh.isError, true);
  assert.match(fresh.content[0].text, /no transcript/);
});
