import test from 'node:test';
import assert from 'node:assert/strict';
import { agentList, agentCapabilities, dispatchModels } from './listing.js';
import { claude } from './claude.js';
import { codex } from './codex.js';

// A provider the registry has never heard of answers for itself: nothing here
// keys on an agent id.
const fixture = {
  id: 'fixture',
  label: 'Fixture',
  modelId: (value) => (value === 'big' ? 'fixture-big-2' : null),
  autoEffortResolver: () => (value) => (value === 'big' ? 'deep' : null),
  effortsForModel: (value) => (value === 'small' ? [{ value: 'light', label: 'Light' }] : [{ value: 'light', label: 'Light' }, { value: 'deep', label: 'Deep' }]),
  efforts: [{ value: 'light', label: 'Light' }, { value: 'deep', label: 'Deep' }],
  models: [{ value: 'big', label: 'Big', default: true }, { value: 'small' }],
  supportsDisallowedTools: true,
  askUserTool: 'ask_human',
  launch: { codexPolicy: false },
  terminal: { socketMail: false },
  isAvailable: async () => { throw new Error('probe failed'); },
};

test('a new adapter is listed from its own fields', async () => {
  const [row] = await agentList({ adapters: [fixture], env: {} });
  assert.deepEqual(row, {
    id: 'fixture',
    label: 'Fixture',
    available: false,
    models: [
      { value: 'big', resolved: 'fixture-big-2', label: 'Big', default: true, efforts: ['light', 'deep'], autoEffort: 'deep', background: false },
      { value: 'small', resolved: null, label: 'small', default: false, efforts: ['light'], autoEffort: null, background: false },
    ],
    efforts: [{ value: 'light', label: 'Light' }, { value: 'deep', label: 'Deep' }],
    capabilities: { disallowedTools: true, remoteControl: false, askUserTool: 'ask_human', sandbox: false, mailWhileWorking: false, headless: false },
  });
});

test('an adapter with a headless field can run one-shots, and the Background model is marked on its model', async () => {
  const oneshot = { ...fixture, headless: { defaultModel: () => 'small' } };
  const [row] = await agentList({ adapters: [oneshot], env: {} });
  assert.equal(row.capabilities.headless, true);
  assert.deepEqual(row.models.map((m) => m.background), [false, true], 'the default Background model is the first headless adapter\'s own default');
  const [chosen] = await agentList({ adapters: [oneshot], env: {}, background: { agent: 'fixture', model: 'big' } });
  assert.deepEqual(chosen.models.map((m) => m.background), [true, false]);
});

test('AW_DEFAULT_MODEL re-points the listed default', async () => {
  const [row] = await agentList({ adapters: [fixture], env: { AW_DEFAULT_MODEL: 'small' } });
  assert.deepEqual(row.models.map((m) => m.default), [false, true]);
});

test('the client agents frame models carry the resolved id (opus → claude-opus-…)', () => {
  const opus = dispatchModels(claude, {}).find((m) => m.value === 'opus');
  assert.equal(opus.resolved, claude.modelId('opus'));
  assert.match(opus.resolved, /^claude-opus-\d/);
  assert.equal(opus.label.startsWith('Opus'), true, 'the existing fields are unchanged');
  for (const m of dispatchModels(codex, {})) assert.equal(m.resolved, m.value);
});

test('Claude and Codex keep the behaviour the id checks encoded', () => {
  assert.deepEqual(agentCapabilities(claude), { disallowedTools: true, remoteControl: true, askUserTool: 'AskUserQuestion', sandbox: false, mailWhileWorking: true, headless: true });
  assert.deepEqual(agentCapabilities(codex), { disallowedTools: false, remoteControl: false, askUserTool: null, sandbox: true, mailWhileWorking: false, headless: true });
});
