import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  resolveClaudeAutoEffort, resolveCodexAutoEffort, parseCodexConfigEffort,
  readClaudeSources, withAutoEffort, sourcesSignature,
} from './auto-effort.js';
import { claudeModelId } from './claude.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-auto-effort-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

// A fresh set of source paths under its own dir, each file written only if given.
let n = 0;
function sources({ remote, managed, dropIns = {}, user, codex } = {}) {
  const dir = path.join(tmp, String(n++));
  fs.mkdirSync(path.join(dir, 'managed-settings.d'), { recursive: true });
  const paths = {
    remote: path.join(dir, 'remote-settings.json'),
    mdm: [],
    managedFile: path.join(dir, 'managed-settings.json'),
    managedDropIns: path.join(dir, 'managed-settings.d'),
    user: path.join(dir, 'settings.json'),
    codexConfig: path.join(dir, 'config.toml'),
  };
  const write = (file, v) => v !== undefined && fs.writeFileSync(file, typeof v === 'string' ? v : JSON.stringify(v));
  write(paths.remote, remote);
  write(paths.managedFile, managed);
  for (const [name, v] of Object.entries(dropIns)) write(path.join(paths.managedDropIns, name), v);
  write(paths.user, user);
  write(paths.codexConfig, codex);
  return paths;
}

const claude = (value, opts) => resolveClaudeAutoEffort(value, readClaudeSources(sources(opts)));

test('an alias resolves to its family’s newest model id', () => {
  assert.equal(claudeModelId('opus'), 'claude-opus-5-5');
  assert.equal(claudeModelId('claude-opus-4-7'), 'claude-opus-4-7');
  assert.equal(claudeModelId('opusplan'), null);
});

test('with nothing set, a model runs at its documented default', () => {
  assert.equal(claude('opus'), 'medium');
  assert.equal(claude('claude-opus-4-7'), 'xhigh');
  assert.equal(claude('claude-fable-5-1'), 'high');
});

test('a managed effortLevel overrides the user’s', () => {
  const user = { effortLevel: 'high', modelSettings: { 'claude-opus-5-5': { effortLevel: 'xhigh' } } };
  assert.equal(claude('opus', { user }), 'xhigh');
  assert.equal(claude('opus', { user, managed: { effortLevel: 'low' } }), 'low');
  assert.equal(claude('opus', { user, remote: { effortLevel: 'low' } }), 'low');
  assert.equal(claude('claude-fable-5-1', { user, managed: { effortLevel: 'low' } }), 'low');
});

test('a user top-level effortLevel only reaches models older than Opus 5.5', () => {
  assert.equal(claude('opus', { user: { effortLevel: 'high' } }), 'medium');
  assert.equal(claude('claude-fable-5-1', { user: { effortLevel: 'xhigh' } }), 'xhigh');
  // An id with no documented default is unknown, never a guess from that key.
  assert.equal(claude('claude-opus-9', { user: { effortLevel: 'high' } }), null);
  assert.equal(claude('claude-opus-9', { user: { modelSettings: { 'claude-opus-9': { effortLevel: 'low' } } } }), 'low');
});

test('a modelSettings entry matches its alias and date-suffixed id', () => {
  assert.equal(claude('opus', { user: { modelSettings: { opus: { effortLevel: 'low' } } } }), 'low');
  assert.equal(claude('opus', { user: { modelSettings: { 'claude-opus-5-5-20260101': { effortLevel: 'xhigh' } } } }), 'xhigh');
  assert.equal(claude('opus', { user: { modelSettings: { 'claude-opus-5': { effortLevel: 'xhigh' } } } }), 'medium');
});

test('CLAUDE_CODE_EFFORT_LEVEL in a settings env block beats every settings file', () => {
  const managed = { effortLevel: 'low', env: { CLAUDE_CODE_EFFORT_LEVEL: 'max' } };
  assert.equal(claude('opus', { managed }), 'max');
  assert.equal(claude('opus', { managed: { effortLevel: 'low' }, user: { env: { CLAUDE_CODE_EFFORT_LEVEL: 'xhigh' } } }), 'xhigh');
  assert.equal(claude('opus', { user: { env: { CLAUDE_CODE_EFFORT_LEVEL: 'auto' } } }), 'medium');
});

test('only the highest managed source with a policy key applies, unless it opts into merge', () => {
  assert.equal(claude('opus', { remote: { channelsEnabled: true }, managed: { effortLevel: 'low' } }), 'medium');
  assert.equal(claude('opus', { remote: { managedSourcesBehavior: 'first-wins' }, managed: { effortLevel: 'low' } }), 'low');
  assert.equal(claude('opus', { remote: { channelsEnabled: true, managedSourcesBehavior: 'merge' }, managed: { effortLevel: 'low' } }), 'low');
});

test('managed-settings.d drop-ins merge over managed-settings.json in name order', () => {
  const dropIns = { '20-b.json': { effortLevel: 'xhigh' }, '10-a.json': { effortLevel: 'low' }, '.hidden.json': { effortLevel: 'max' } };
  assert.equal(claude('opus', { managed: { effortLevel: 'high' }, dropIns }), 'xhigh');
});

test('the lowest maxEffortLevel from any source caps the level', () => {
  assert.equal(claude('opus', { managed: { effortLevel: 'xhigh' }, user: { maxEffortLevel: 'high' } }), 'high');
  assert.equal(claude('claude-opus-4-7', { remote: { maxEffortLevel: 'medium' } }), 'medium');
  // A model's own cap replaces its source's top-level one; "max" exempts it.
  const managed = { effortLevel: 'xhigh', maxEffortLevel: 'low', modelSettings: { 'claude-opus-5-5': { maxEffortLevel: 'max' } } };
  assert.equal(claude('opus', { managed }), 'xhigh');
});

test('unreadable or missing files leave the defaults standing', () => {
  assert.equal(claude('opus', { managed: '{not json', user: '[]' }), 'medium');
});

test('Codex: config.toml’s top-level level wins over the model’s catalog default', () => {
  assert.equal(parseCodexConfigEffort('model = "gpt-6-sol"\nmodel_reasoning_effort = "high"\n'), 'high');
  assert.equal(parseCodexConfigEffort('model = "x"\n[profiles.fast]\nmodel_reasoning_effort = "low"\n'), null);
  assert.equal(resolveCodexAutoEffort('gpt-6-astra'), 'low');
  assert.equal(resolveCodexAutoEffort('gpt-6-astra', { configEffort: 'high' }), 'high');
  assert.equal(resolveCodexAutoEffort('gpt-unknown'), null);
});

test('withAutoEffort adds autoEffort where known and leaves the rest as they were', () => {
  const paths = sources({ user: { modelSettings: { 'claude-opus-5-5': { effortLevel: 'high' } } }, codex: 'model_reasoning_effort = "xhigh"\n' });
  const claudeModels = [{ value: 'opus', label: 'Opus', default: true }, { value: 'opusplan', label: 'Plan' }];
  assert.deepEqual(withAutoEffort('claude', claudeModels, paths), [
    { value: 'opus', label: 'Opus', default: true, autoEffort: 'high' },
    { value: 'opusplan', label: 'Plan' },
  ]);
  assert.deepEqual(withAutoEffort('codex', [{ value: 'gpt-6-sol' }], paths), [{ value: 'gpt-6-sol', autoEffort: 'xhigh' }]);
  assert.deepEqual(withAutoEffort('other', claudeModels, paths), claudeModels);
});

test('a settings change is re-read and changes the sources signature', () => {
  const paths = sources({ user: { effortLevel: 'high' } });
  const before = sourcesSignature(paths);
  assert.equal(withAutoEffort('claude', [{ value: 'opus' }], paths)[0].autoEffort, 'medium');
  fs.writeFileSync(paths.user, JSON.stringify({ modelSettings: { 'claude-opus-5-5': { effortLevel: 'xhigh' } } }));
  assert.notEqual(sourcesSignature(paths), before);
  assert.equal(withAutoEffort('claude', [{ value: 'opus' }], paths)[0].autoEffort, 'xhigh');
  fs.writeFileSync(paths.managedFile, JSON.stringify({ effortLevel: 'low' }));
  assert.equal(withAutoEffort('claude', [{ value: 'opus' }], paths)[0].autoEffort, 'low');
});
