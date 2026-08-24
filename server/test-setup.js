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

// Same problem, a different real file: data-dir.js resolves DATA_DIR from
// AW_DATA_DIR at import time, and config-store.js/memory-store.js build on top
// of it with no path injection of their own — config-store.test.js already
// documents that it shares (and restores) the real ~/.agent-wrangler/config.json
// for lack of an alternative. Redirecting AW_DATA_DIR here, before any of those
// modules are imported, gives every test its own throwaway data dir instead —
// the archive-review feature (server/archive-review-runner.js) reads
// archiveReviewEnabled() off the real config.json and, if a real install ever
// turns it on, would otherwise make a dispatch/resume/fork/archive test spawn a
// real billed `claude -p` subprocess and append to real task memory. Same class
// of incident as the CODEX_HOME redirect above, with a bill attached.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-test-data-dir-'));
process.env.AW_DATA_DIR = dataDir;
process.on('exit', () => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});
