import test from 'node:test';
import assert from 'node:assert/strict';
import * as registry from './index.js';
import { complementaryModel } from '../../public/review.js';

test('only absent historical provider defaults to Claude', () => {
  assert.equal(registry.adapterFor(undefined).id, 'claude');
  assert.equal(registry.adapterFor(null).id, 'claude');
  for (const id of ['fixture', '', 'codx']) assert.throws(() => registry.adapterFor(id), /Unknown agent/);
});

test('review selection uses declared preference despite shuffled availability', () => {
  const agents = [
    { id: 'fixture', reviewPriority: 30, models: [{ value: 'fixture-model', default: true }] },
    { id: 'codex', reviewPriority: 20, models: [{ value: 'codex-model', default: true }] },
    { id: 'claude', reviewPriority: 10, models: [{ value: 'claude-model', default: true }] },
  ];
  for (const order of [agents, [...agents].reverse(), [agents[1], agents[0], agents[2]]]) {
    assert.equal(complementaryModel('fixture', order), 'claude-model');
    assert.equal(complementaryModel('claude', order), 'codex-model');
    assert.equal(complementaryModel('codex', order), 'claude-model');
  }
  assert.equal(complementaryModel('claude', [agents[2]]), null);
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chatHandler } from '../control/handlers/chat.js';
import { findConversationFile, findConversationFiles } from '../conversation-file.js';
import { discoverSources } from '../search/corpus.js';
import { parseChunk } from '../search/index-worker.js';
import { scanAllDaily, rollup } from '../usage-report.js';

function fixtureProvider(file) {
  return {
    id: 'fixture', label: 'Fixture Agent',
    terminal: { contextSource: 'analysis' },
    analyze: async () => ({ contextPercent: 12 }),
    effortsForModel: (model) => model === 'plain' ? [] : [{ value: 'deep' }],
    history: {
      findFile: async () => file,
      findFiles: async () => [file],
      discoverSources: async () => [{ file, agent: 'fixture', id: 'fixture-conversation' }],
      extractLine(line) {
        if (!line) return null;
        const record = JSON.parse(line);
        return { record: { role: 1, text: record.fixtureText, tsSec: 1793232000 } };
      },
      createScanner() {
        return {
          pushTagged: (line) => ({ uuid: null, events: line ? [{ kind: 'user', text: JSON.parse(line).fixtureText, ts: 1793232000000 }] : [] }),
          selectLive: (tagged) => tagged.flatMap((t) => t.events),
          takeRewound: () => false, pending: () => null, lastTs: () => 1793232000000,
        };
      },
    },
    usage: {
      async scanDaily({ cardId, raw, task }) {
        const tokens = { input: 42, output: 7, cacheWrite: 0, cacheRead: 0 };
        raw.push({ cardId, owner: true, task, file: null, days: { '2026-10-29': { provider: 'fixture-api', usd: 0.2, estimatedUsd: 0.2, subAgentUsd: 0, tokens, byModel: { fixture: { usd: 0.2, estimatedUsd: 0.2, tokens } } } } });
      },
    },
  };
}

test('fixture provider routes chat, search and usage without a Claude fallback', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-provider-fixture-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'fixture.jsonl');
  fs.writeFileSync(file, JSON.stringify({ fixtureText: 'Only the fixture parser understands this conversation' }) + '\n');
  const fixture = fixtureProvider(file);
  const { adapterFor: resolveAdapter } = registry.createAgentRegistry([fixture]);
  assert.throws(() => resolveAdapter(), /Unknown agent/);
  assert.equal(await findConversationFile('conversation', 'fixture', { resolveAdapter }), file);
  assert.deepEqual(await findConversationFiles('conversation', 'fixture', { resolveAdapter }), [file]);
  const replies = [];
  await chatHandler.handler({ sessionId: 'fixture-card' }, {
    sessionFromGraph: () => ({ agent: 'fixture', liveSessionId: 'fixture-conversation' }),
    resolveAdapter, reply: (reply) => replies.push(reply),
  });
  assert.equal(replies[0].events[0].text, 'Only the fixture parser understands this conversation');
  assert.equal(replies[0].contextPercent, 12);
  const sources = await discoverSources({ providers: [fixture] });
  assert.equal(sources[0].agent, 'fixture');
  const parsed = parseChunk(sources[0].file, sources[0].agent, 0, resolveAdapter);
  assert.equal(parsed.count, 1);
  assert.match(new TextDecoder().decode(parsed.text), /Only the fixture parser/);
  fs.writeFileSync(path.join(dir, 'mappings.json'), JSON.stringify({ sessions: { 'fixture-card': { agent: 'fixture' } } }));
  const scan = await scanAllDaily({ dataDir: dir, projectsDir: path.join(dir, 'no-claude'), codexSessionsDir: path.join(dir, 'no-codex'), resolveAdapter });
  const report = rollup(scan, { start: Date.parse('2026-10-29'), end: Date.parse('2026-10-30') });
  assert.equal(report.totals.tokens.input, 42);
  assert.equal(report.totals.usd, 0.2);
  assert.equal(report.buckets[0].providers['fixture-api'].total.usd, 0.2);
  assert.equal(registry.effortError('fixture', 'deep', 'reasoning', resolveAdapter), null);
  assert.match(registry.effortError('fixture', 'deep', 'plain', resolveAdapter), /Unknown effort/);
});
