import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPromptMonitor } from './prompt-monitor.js';

const claude = (text) => JSON.stringify({ type: 'user', timestamp: '2026-09-28T10:00:00.000Z', message: { role: 'user', content: text } }) + '\n';
const codex = (text) => JSON.stringify({ type: 'response_item', timestamp: '2026-09-28T10:00:00.000Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } }) + '\n';

test('onPrompt observes new Claude and Codex turns once, including terminal prompts', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'aw-prompts-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const files = { CLAUDE: path.join(dir, 'claude.jsonl'), CODEX: path.join(dir, 'codex.jsonl') };
  const byLiveId = { 'c-live': files.CLAUDE, 'x-live': files.CODEX };
  await fsp.writeFile(files.CLAUDE, claude('historic'));
  await fsp.writeFile(files.CODEX, codex('historic'));
  const entries = [
    { sessionId: 'CLAUDE', liveSessionId: 'c-live', agent: 'claude' },
    { sessionId: 'CODEX', liveSessionId: 'x-live', agent: 'codex' },
  ];
  const seen = [];
  const sm = {
    activeEntries: () => entries,
    entryFor: (id) => entries.find((e) => e.sessionId === id),
    _fireExtHooks: async (name, payload) => seen.push({ name, ...payload }),
  };
  const monitor = createPromptMonitor(sm, { findFile: (id) => byLiveId[id] });
  await monitor.seed();
  await monitor.poll();
  assert.deepEqual(seen, [], 'startup history is not replayed');

  // A partial JSONL line is held until the agent finishes writing it.
  const next = claude('from terminal');
  await fsp.appendFile(files.CLAUDE, next.slice(0, -1));
  await monitor.poll();
  assert.deepEqual(seen, []);
  await fsp.appendFile(files.CLAUDE, '\n');
  await fsp.appendFile(files.CODEX, codex('from board'));
  await monitor.poll();
  await monitor.poll();
  assert.deepEqual(seen.map((x) => [x.name, x.sessionId, x.text]), [
    ['onPrompt', 'CLAUDE', 'from terminal'], ['onPrompt', 'CODEX', 'from board'],
  ]);
  assert.equal(seen[0].liveSessionId, 'c-live');
  assert.equal(seen[1].agent, 'codex');

  const queued = JSON.stringify({
    type: 'attachment', timestamp: '2026-09-28T10:01:00.000Z',
    attachment: { type: 'queued_command', commandMode: 'prompt', prompt: 'queued prompt' },
  }) + '\n';
  await fsp.appendFile(files.CLAUDE, queued + claude('queued prompt'));
  await fsp.appendFile(files.CODEX, codex('<environment_context>injected</environment_context>'));
  await monitor.poll();
  assert.deepEqual(seen.slice(2).map((x) => x.text), ['queued prompt'], 'queued prompt fires once; synthetic context never fires');

  // A newly launched conversation has no seed cursor: its first prompt counts.
  entries.push({ sessionId: 'NEW', liveSessionId: 'new-live', agent: 'claude' });
  files.NEW = path.join(dir, 'new.jsonl');
  byLiveId['new-live'] = files.NEW;
  await fsp.writeFile(files.NEW, claude('launch prompt'));
  await monitor.poll();
  assert.equal(seen.at(-1).text, 'launch prompt');
  assert.equal(seen.at(-1).sessionId, 'NEW');

  // A card can resume against another conversation file; the new transcript's
  // first prompt must be seen without replaying the old file.
  const resumed = path.join(dir, 'resumed.jsonl');
  byLiveId['x-resumed'] = resumed;
  entries[1].liveSessionId = 'x-resumed';
  await fsp.writeFile(resumed, codex('resume prompt'));
  await monitor.poll();
  assert.equal(seen.at(-1).text, 'resume prompt');
  assert.equal(seen.at(-1).sessionId, 'CODEX');
});
