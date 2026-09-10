import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  adapterFor, agentError, modelError, launchTargetError, knownAgentIds, modelChoicesText,
} from './index.js';

test('a known agent/model pair passes, and an absent model is not a rejection', () => {
  assert.equal(launchTargetError('claude', 'opus'), null);
  assert.equal(launchTargetError('codex', 'gpt-5.6-sol'), null);
  assert.equal(launchTargetError('claude', undefined), null);
  assert.equal(launchTargetError('claude', ''), null);
  assert.equal(launchTargetError(undefined, undefined), null);
});

test('an unknown agent is caught, since adapterFor silently falls back to claude', () => {
  const err = agentError('codx');
  assert.match(err, /Unknown agent "codx"/);
  for (const id of knownAgentIds()) assert.match(err, new RegExp(id));
});

// Agent before model: validating the model first would report "unknown model
// for claude" (the adapterFor fallback) and hide the typo that caused it.
test('a bad agent is reported ahead of the model it makes unresolvable', () => {
  assert.match(launchTargetError('codx', 'gpt-5.6-sol'), /Unknown agent "codx"/);
});

test('an unknown model names the valid options for the agent it was given', () => {
  const err = modelError('claude', 'opus-5');
  assert.match(err, /Unknown model "opus-5" for agent "claude"/);
  for (const m of adapterFor('claude').models) assert.match(err, new RegExp(escape(m.value)));
});

// The mistake this check exists to catch: the "inherit my model" default never
// fires across agents, so a deliberate opposite-provider spawn is exactly where
// a Claude session reaches for `opus` against `agent: "codex"`.
test('a model belonging to the other agent says so', () => {
  assert.match(modelError('codex', 'opus'), /"opus" is a claude model — did you mean agent: "claude"\?/);
  assert.match(modelError('claude', 'gpt-5.6-sol'), /"gpt-5\.6-sol" is a codex model — did you mean agent: "codex"\?/);
});

// transcriptPrefixes map a transcript's message.model back to a pill; they must
// never widen what is accepted at LAUNCH, where the CLI takes only the alias.
test('a transcript model id is not accepted as a launch model', () => {
  assert.match(modelError('claude', 'claude-opus-5'), /Unknown model/);
});

// The generated description is the only enumeration of the model vocabulary an
// agent ever reads, so a model added to an adapter must surface in it.
test('the generated tool description carries every model of every agent', () => {
  const text = modelChoicesText();
  for (const id of knownAgentIds()) {
    assert.match(text, new RegExp(`${id}:`));
    for (const m of adapterFor(id).models) {
      assert.ok(text.includes(`${m.value} (${m.label})`), `missing ${id} model ${m.value}`);
    }
  }
});

function escape(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// modelError must be safe called on its own. launchTargetError already checks
// the agent first, but a future direct caller shouldn't have to know that — the
// misleading "unknown model … for claude" is exactly what this all exists to
// prevent, so the function reports the real fault itself.
test('modelError called with an unknown agent reports the AGENT, not a claude model', () => {
  assert.match(modelError('codx', 'gpt-5.6-sol'), /Unknown agent "codx"/);
  assert.doesNotMatch(modelError('codx', 'gpt-5.6-sol'), /for agent "claude"/);
});
