import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { adapterFor, knownAgentIds } from './agents/index.js';
import { skillModelBlock, SKILL_PATH, BEGIN } from './skill-model-table.js';

// This repo has no build step, so THIS test is what enforces the generated
// block: adding a model to an adapter without running `npm run gen:models`
// fails here rather than silently shipping a stale skill.
test('the spawn-session skill’s model table matches the adapters', () => {
  const text = fs.readFileSync(SKILL_PATH, 'utf8');
  assert.equal(text, skillModelBlock(text), 'spawn-session SKILL.md is stale — run `npm run gen:models`');
});

test('every adapter model appears in the generated skill table', () => {
  const text = fs.readFileSync(SKILL_PATH, 'utf8');
  for (const id of knownAgentIds()) {
    for (const m of adapterFor(id).models) {
      assert.ok(text.includes(`\`${m.value}\``), `${id} model ${m.value} missing from the skill table`);
    }
  }
});

// A silent no-op would let the skill rot with this test still green.
test('a skill file without the markers throws rather than no-opping', () => {
  assert.throws(() => skillModelBlock('# no markers here'), /missing the generated-model markers/);
  assert.ok(BEGIN.includes('gen:models'), 'the marker should tell a human how to regenerate');
});
