import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { analyzeLines } from './transcript-reader.js';
import { createNativeChatScanner } from './agents/chat-scanner.js';
import { analyzeCodex } from './agents/codex-rollout.js';
import { buildGraph } from './state-reader.js';
import { workerStatusWord, waitingStatusWord } from '../public/cards.js';

const fixture = (name) => fs.readFileSync(new URL(`./fixtures/api-error-label/${name}.jsonl`, import.meta.url), 'utf8').trim().split('\n');

async function nodeFor(enrichment, agent = 'claude') {
  const entry = { sessionId: 'fixture-session', liveSessionId: 'fixture-live', agent };
  const manager = {
    activeEntries: () => [], archivedEntries: () => [],
    entryFor: (id) => id === entry.sessionId ? entry : undefined,
    entryByTmux: () => entry, tmuxOwner: () => null, tmuxNameFor: () => null,
    deadTmuxNameFor: () => null, isArchived: () => false, scanSockets: () => [''], socketOf: () => '',
  };
  const graph = await buildGraph(manager, async () => enrichment, {
    discover: async () => [{ tmuxName: 'fixture-tmux', claudePid: 4242, agent, command: agent }],
    capture: async () => '',
    runtimeResolver: () => ({
      readLive: async () => ({ liveSid: entry.liveSessionId, status: 'idle' }),
      analyze: async () => enrichment,
    }),
  });
  return graph.sessions.find((s) => s.sessionId === entry.sessionId);
}

for (const [name, reason, expected] of [
  ['claude-blocking', 'api-error-blocking', 'error'],
  ['claude-transient', 'api-error', 'error'],
  ['claude-normal', null, 'idle'],
  ['claude-recovered', null, 'idle'],
]) {
  test(`transcript fixture ${name}: carries terminal error or normal reply through graph and label`, async () => {
    const lines = fixture(name);
    const enrichment = analyzeLines(lines);
    const node = await nodeFor(enrichment);
    assert.equal(node.waitingReason, reason);
    assert.equal(node.status, reason ? 'needs-you' : 'idle');
    if (reason) {
      assert.equal(node.waitingFor, enrichment.apiErrorText);
      assert.equal(waitingStatusWord(node.waitingReason), 'error');
    }
    assert.equal(workerStatusWord(node, { justFinished: new Set() }), expected);
    const scanner = createNativeChatScanner();
    const events = lines.flatMap((line) => scanner.push(line));
    assert.ok(events.some((e) => e.kind === 'assistant'));
    assert.equal(events.at(-1).text, JSON.parse(lines.findLast((line) => JSON.parse(line).type === 'assistant')).message.content[0].text);
  });
}

test('Codex normal-reply fixture: error wording in prose is not a terminal API error signal', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-api-label-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const id = '11111111-1111-4111-8111-111111111111';
  const lines = fixture('codex-normal');
  fs.writeFileSync(path.join(root, `rollout-2026-10-01T12-00-00-${id}.jsonl`), `${lines.join('\n')}\n`);
  const enrichment = await analyzeCodex(id, { sessionsDir: root });
  assert.equal(enrichment.hasTranscript, true);
  assert.equal(Boolean(enrichment.apiError), false);
  const node = await nodeFor(enrichment, 'codex');
  assert.equal(node.waitingReason, null);
  assert.equal(workerStatusWord(node, { justFinished: new Set() }), 'idle');
  const scanner = createNativeChatScanner('codex');
  assert.match(lines.flatMap((line) => scanner.push(line)).find((e) => e.kind === 'assistant').text, /API Error/);
});

test('ordinary permission prompts retain the reply label', () => {
  assert.equal(waitingStatusWord(null), 'reply');
  assert.equal(workerStatusWord({ managed: true, status: 'needs-you' }, { justFinished: new Set() }), 'reply');
});
