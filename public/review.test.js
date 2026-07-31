import { test } from 'node:test';
import assert from 'node:assert/strict';
import { complementaryModel, reviewDispatchOpts } from './review.js';

const AGENTS = [
  { id: 'claude', label: 'Claude', models: [
    { value: 'opus', label: 'Opus', default: true },
    { value: 'sonnet', label: 'Sonnet' },
  ] },
  { id: 'codex', label: 'Codex', models: [
    { value: 'gpt-5.5', label: 'GPT-5.5', default: true },
    { value: 'gpt-5.4', label: 'GPT-5.4' },
  ] },
];

test('complementaryModel: source Claude → Codex default value', () => {
  assert.equal(complementaryModel('claude', AGENTS), 'gpt-5.5');
});

test('complementaryModel: source Codex → Claude default value', () => {
  assert.equal(complementaryModel('codex', AGENTS), 'opus');
});

test('complementaryModel: only the source agent installed → null', () => {
  assert.equal(complementaryModel('claude', [AGENTS[0]]), null);
});

test('complementaryModel: falls back to first model when none marked default', () => {
  const agents = [{ id: 'claude', models: [{ value: 'opus' }] },
                  { id: 'codex', models: [{ value: 'gpt-5.4' }, { value: 'gpt-5.5' }] }];
  assert.equal(complementaryModel('claude', agents), 'gpt-5.4');
});

test('complementaryModel: tolerates missing/empty models and empty list', () => {
  assert.equal(complementaryModel('claude', [{ id: 'claude' }, { id: 'codex' }]), null);
  assert.equal(complementaryModel('claude', []), null);
  assert.equal(complementaryModel('claude', undefined), null);
});

test('reviewDispatchOpts: carries the source cwd/agent and tags parentSession = the source session', () => {
  const s = { cwd: '/repo', agent: 'codex' };
  assert.deepEqual(reviewDispatchOpts('SRC1', s), { cwd: '/repo', sourceAgent: 'codex', parentSession: 'SRC1' });
});

test('reviewDispatchOpts: defaults sourceAgent to claude when the source has none', () => {
  const s = { cwd: '/repo' };
  assert.deepEqual(reviewDispatchOpts('SRC1', s), { cwd: '/repo', sourceAgent: 'claude', parentSession: 'SRC1' });
});
