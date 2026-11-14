import os from 'node:os';
import path from 'node:path';

// Base directory for all wrangler state — mappings.json, tasks.json, memory/,
// scratch sessions/, and the per-session symlinks. Overridable via AW_DATA_DIR so
// a dev instance can run against fully isolated state without touching the live
// board's ~/.agent-wrangler. Unset → the legacy default, so existing installs are
// unaffected.
function expandTilde(p) {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

// A test run that skipped `--import ./server/test-setup.js` (a bare `node --test
// server/x.test.js`, which agents run constantly) would otherwise resolve the
// REAL data dir, CODEX_HOME, GEMINI_CLI_HOME and CLAUDE_CONFIG_DIR, and suites
// like extensions-install.test.js wipe `extensions/` and `extensions.json` in
// their reset(): that is how a live board once lost every installed extension.
// So a test process runs the setup itself, before DATA_DIR is computed below.
export function isTestProcess({ env = process.env, execArgv = process.execArgv, argv = process.argv } = {}) {
  return Boolean(env.NODE_TEST_CONTEXT)
    || execArgv.some((a) => a === '--test' || a.startsWith('--test-'))
    || /\.test\.[cm]?js$/.test(argv[1] || '');
}

if (isTestProcess() && !process.env.AW_TEST_SETUP) await import('./test-setup.js');

export const DATA_DIR = process.env.AW_DATA_DIR
  ? path.resolve(expandTilde(process.env.AW_DATA_DIR))
  : path.join(os.homedir(), '.agent-wrangler');
