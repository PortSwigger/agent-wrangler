import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Loaded via `node --test --import ./server/test-setup.js` (package.json's
// `test` script) so it runs before any test file, in every subprocess `node
// --test` spawns (verified: each test file gets its own process, and each one
// re-runs this preload first).
//
// This exists because a real machine-global dotfile got corrupted by the test
// suite: ensureCodexTrust (codex-trust.js), called from session-manager.js's
// dispatch/resume/fork, writes trust entries into `~/.codex/config.toml`. Tests
// that dispatch/resume/fork a codex-agent session stub the OTHER real-world
// effects (`sm._newSession`, `sm._save`), but nothing stubbed this — a
// `dispatch({ agent: 'codex', cwd: os.tmpdir() })` test genuinely persisted
// "trust os.tmpdir()" into this developer's real config.toml. Redirecting
// CODEX_HOME here for the whole test run makes that class of test byte-for-byte
// harmless by construction, present and future, without relying on every new
// test remembering to stub anything codex-trust-shaped.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-test-codex-home-'));
process.env.CODEX_HOME = dir;
process.on('exit', () => {
  fs.rmSync(dir, { recursive: true, force: true });
});
