import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { adapterFor } from './agents/index.js';
import { lastAssistantText } from './last-assistant.js';

for (const agent of ['claude', 'codex']) {
  test(`lastAssistantText reads the final ${agent} assistant text, collapsed and truncated`, async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-last-assistant-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const id = '11111111-2222-3333-4444-555555555555';
    const bucket = path.join(dir, agent === 'claude' ? '-work-a' : '2026/07/01');
    fs.mkdirSync(bucket, { recursive: true });
    const messages = [ ['assistant', 'first'], ['user', 'question'], ['assistant', 'last\n' + 'x'.repeat(300)] ];
    const lines = messages.map(([role, text]) => agent === 'claude'
      ? { type: role, timestamp: '2026-07-01T09:00:00.000Z', message: { role, content: [{ type: 'text', text }] } }
      : { type: 'response_item', timestamp: '2026-07-01T09:00:00.000Z', payload: { type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] } });
    fs.writeFileSync(path.join(bucket, agent === 'claude' ? `${id}.jsonl` : `rollout-2026-07-01T09-00-00-${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    assert.equal(await lastAssistantText({ agent, liveSessionId: id }, { adapterFor, historyOptions: { projectsDir: dir, codexSessionsDir: dir } }), 'last ' + 'x'.repeat(195) + '…');
  });
}

test('lastAssistantText is null without a transcript or when history fails', async () => {
  assert.equal(await lastAssistantText(null, { adapterFor }), null);
  assert.equal(await lastAssistantText({ liveSessionId: 'missing' }, { adapterFor, historyOptions: { projectsDir: '/nonexistent' } }), null);
  assert.equal(await lastAssistantText({}, { adapterFor: () => { throw new Error('broken'); } }), null);
});
