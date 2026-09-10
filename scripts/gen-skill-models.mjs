#!/usr/bin/env node
// Regenerate the model table in the spawn-session skill from the agent adapters.
// There is no build step in this repo and this file is checked in — the guard is
// `spawn-session-skill-models.test.js`, which regenerates in memory and fails if
// the file has drifted. So adding a model to an adapter cannot silently leave the
// skill stale: `npm test` says so, and `npm run gen:models` fixes it.
import fs from 'node:fs';
import { skillModelBlock, SKILL_PATH } from '../server/skill-model-table.js';

const before = fs.readFileSync(SKILL_PATH, 'utf8');
const after = skillModelBlock(before);
if (before === after) {
  console.log('spawn-session SKILL.md model table already up to date');
} else {
  fs.writeFileSync(SKILL_PATH, after);
  console.log('spawn-session SKILL.md model table regenerated');
}
