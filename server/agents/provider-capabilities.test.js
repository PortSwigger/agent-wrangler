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
import { waitingReasonFor } from '../state-reader.js';
import { lastAssistantText } from '../last-assistant.js';
import { mayExitForUpdate } from '../session-manager.js';
import { modelFamilies } from '../price-catalog.js';
import { setProviderMetadata, providerMetadataFor } from '../../public/provider-metadata.js';

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

// The paths that used to compare agent ids directly, driven by a provider core
// has never heard of: every behaviour comes from what its adapter declares.
test('fixture provider drives the former id checks through adapter capabilities', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-provider-moved-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'fixture.jsonl');
  fs.writeFileSync(file, ['rewound', 'kept'].map((text, i) => JSON.stringify({ uuid: `u${i}`, text })).join('\n') + '\n');
  const scanner = () => ({
    push: (line) => [{ kind: 'assistant', text: JSON.parse(line).text }],
    pushTagged: (line) => { const r = JSON.parse(line); return { uuid: r.uuid, events: [{ kind: 'assistant', text: r.text }] }; },
    // Prunes the first branch, standing in for a rewound conversation.
    selectLive: (tagged) => tagged.slice(1).flatMap((b) => b.events),
  });
  const fixture = {
    id: 'fixture', label: 'Fixture Agent', tmuxPrefix: 'fx_',
    terminal: { autoBlock: true, updatesOnExit: true },
    launch: { codexPolicy: true },
    history: { branches: true, findFiles: async () => [file], createScanner: scanner },
  };
  const linear = { ...fixture, id: 'linear', tmuxPrefix: 'ln_', terminal: {}, launch: {}, history: { ...fixture.history, branches: false } };
  const fixtures = registry.createAgentRegistry([fixture, linear]);

  // state-reader: the timed auto-block reason follows terminal.autoBlock.
  const clock = 'Auto mode is checking this action · denies in 1:47';
  assert.equal(waitingReasonFor(fixture, 'waiting', '').waitingReason, 'permission');
  assert.equal(waitingReasonFor(linear, 'waiting', clock), null);

  // last-assistant: branch pruning follows history.branches.
  assert.equal(await lastAssistantText({ agent: 'fixture', sessionId: 's' }, { adapterFor: fixtures.adapterFor }), 'kept');
  assert.equal(await lastAssistantText({ agent: 'linear', sessionId: 's' }, { adapterFor: fixtures.adapterFor }), 'kept');
  const branched = { ...fixture, history: { ...fixture.history, createScanner: () => ({ ...scanner(), selectLive: (tagged) => tagged[0].events }) } };
  assert.equal(await lastAssistantText({ agent: 'fixture', sessionId: 's' }, { adapterFor: () => branched }), 'rewound', 'a branching provider reads the live branch, not the last line');

  // session-manager: a clean exit's update check follows terminal.updatesOnExit,
  // by the entry's agent or, for an entry with none, the tmux prefix.
  assert.equal(mayExitForUpdate({ agent: 'fixture' }, 'fx_1', fixtures), true);
  assert.equal(mayExitForUpdate({}, 'fx_1', fixtures), true);
  assert.equal(mayExitForUpdate({ agent: 'linear' }, 'ln_1', fixtures), false);
  assert.equal(mayExitForUpdate({ agent: 'nonesuch' }, 'ln_1', fixtures), false);
  assert.equal(fixtures.adapterForTmux('fx_ab12').id, 'fixture');
  assert.equal(fixtures.adapterForTmux('zz_ab12'), null);

  // Browser: the dispatch dialog's policy row follows launch.codexPolicy.
  setProviderMetadata([fixture, linear].map((a) => registry.providerMetadata({ ...a, presentation: {}, controls: {} })));
  assert.equal(providerMetadataFor('fixture').controls.codexPolicy, true);
  assert.equal(providerMetadataFor('linear').controls.codexPolicy, false);
  setProviderMetadata([]);

  // price-catalog: families are parsed with the pattern the adapter supplies.
  assert.deepEqual(modelFamilies({ provider: 'nonesuch', pattern: /^fixture-([a-z]+)-(\d)$/ }), []);
  assert.deepEqual(registry.adapterFor('claude').usage.catalogFamilies.provider, 'anthropic');
});

test('built-in providers declare the capabilities the former id checks read', () => {
  const claude = registry.adapterFor('claude');
  const codex = registry.adapterFor('codex');
  assert.equal(claude.terminal.autoBlock, true);
  assert.ok(!codex.terminal.autoBlock);
  assert.equal(claude.history.branches, true);
  assert.ok(!codex.history.branches);
  assert.equal(codex.terminal.updatesOnExit, true);
  assert.ok(!claude.terminal.updatesOnExit);
  assert.equal(mayExitForUpdate({}, 'cx_ab12'), true, 'a legacy entry with no agent is still read by its Codex prefix');
  assert.equal(mayExitForUpdate({ agent: 'claude' }, 'cc_ab12'), false);
  assert.equal(registry.providerMetadata(codex).controls.codexPolicy, true);
  assert.equal(registry.providerMetadata(claude).controls.codexPolicy, false);
});

// Gemini is the provider added with nothing outside server/agents/ comparing ids:
// each shared path reads what its adapter declares, and an undeclared field means no.
test('Gemini declares every capability the shared paths read, and inherits none from Claude', () => {
  const gemini = registry.adapterFor('gemini');
  assert.equal(registry.adapterForTmux('gm_ab12'), gemini);
  assert.ok(!gemini.terminal.autoBlock && !gemini.terminal.updatesOnExit && !gemini.terminal.socketMail);
  assert.ok(!gemini.history.branches && !gemini.history.requiresResumeFile);
  assert.equal(mayExitForUpdate({}, 'gm_ab12'), false);
  const meta = registry.providerMetadata(gemini);
  assert.equal(meta.controls.codexPolicy, false);
  assert.equal(meta.supportsRemoteControl, false);
  assert.equal(meta.headless, true);
  assert.deepEqual(meta.billingProviders, [{ id: 'google', label: 'Google' }]);
  assert.equal(registry.supportsDisallowedTools('gemini'), false);
  assert.equal(gemini.presetsSessionId, true);
  assert.match(registry.launchTargetError('gemini', 'opus'), /"opus" is a claude model/);
  assert.equal(registry.launchTargetError('gemini', 'auto'), null);
  assert.match(registry.effortError('gemini', 'high', 'auto'), /Unknown effort/);
});
