import test from 'node:test';
import assert from 'node:assert/strict';
import { setProviderMetadata, providerMetadataFor, providerChoices, canSwitchProviderModel, needsYouTitle, billingProviderChoices } from './provider-metadata.js';
import { autoCompactPresetTokens } from './auto-compact-presets.js';
import { providerMetadata, registeredAgents } from '../server/agents/index.js';

const fixture = { id: 'fixture', billingProviders: [{ id: 'fixture-api', label: 'Fixture API' }], label: 'Fixture Agent', presentation: { icon: 'generic', color: '#123456', estimatedCost: true }, controls: { switchModel: true, autoCompact: { presets: [75000] } } };

test('board search, model controls and notifications use provider metadata', () => {
  setProviderMetadata([...registeredAgents().map(providerMetadata), fixture]);
  assert.equal(providerChoices().find((p) => p.value === 'fixture').label, 'Fixture Agent');
  assert.equal(providerMetadataFor('fixture').presentation.estimatedCost, true);
  assert.equal(canSwitchProviderModel({ agent: 'fixture', managed: true, status: 'idle' }), true);
  assert.equal(canSwitchProviderModel({ agent: 'fixture', managed: true, status: 'working' }), false);
  assert.equal(canSwitchProviderModel({ agent: 'codex', managed: true, status: 'idle' }), false);
  assert.deepEqual(autoCompactPresetTokens('fixture'), [75000]);
  assert.deepEqual(autoCompactPresetTokens('unknown'), []);
  assert.equal(needsYouTitle({ agent: 'fixture' }), 'Fixture Agent needs you');
  assert.equal(needsYouTitle({ agent: 'unknown' }), 'unknown needs you');
  assert.equal(needsYouTitle({}), 'Claude needs you');
  assert.deepEqual(billingProviderChoices().map((p) => p.label), ['All providers', 'Anthropic', 'OpenAI', 'Fixture API']);
});
