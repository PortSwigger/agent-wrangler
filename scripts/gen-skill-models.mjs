#!/usr/bin/env node
// Regenerate the model table in the spawn-session skill from the agent adapters.
// There is no build step in this repo and this file is checked in — the guard is
// `spawn-session-skill-models.test.js`, which regenerates in memory and fails if
// the file has drifted. So adding a model to an adapter cannot silently leave the
// skill stale: `npm test` says so, and `npm run gen:models` fixes it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The table renders the bundled snapshots, exactly as the test does — so point
// DATA_DIR at an empty dir before anything reads this machine's fetched prices.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-gen-models-'));
process.env.AW_DATA_DIR = dataDir;
try {
  const { skillModelBlock, SKILL_PATH } = await import('../server/skill-model-table.js');
  const before = fs.readFileSync(SKILL_PATH, 'utf8');
  const after = skillModelBlock(before);
  if (before === after) {
    console.log('spawn-session SKILL.md model table already up to date');
  } else {
    fs.writeFileSync(SKILL_PATH, after);
    console.log('spawn-session SKILL.md model table regenerated');
  }
} finally {
  fs.rmSync(dataDir, { recursive: true, force: true });
}
