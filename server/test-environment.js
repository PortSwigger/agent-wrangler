import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function isTestProcess({ env = process.env, execArgv = process.execArgv, argv = process.argv } = {}) {
  return Boolean(env.NODE_TEST_CONTEXT)
    || execArgv.some((a) => a === '--test' || a.startsWith('--test-'))
    || /\.test\.[cm]?js$/.test(argv[1] || '');
}

function hasIsolatedHomes() {
  try {
    const tmp = fs.realpathSync(os.tmpdir());
    return ['HOME', 'AW_DATA_DIR', 'CODEX_HOME', 'GEMINI_CLI_HOME', 'CLAUDE_CONFIG_DIR'].every((key) => {
      const dir = process.env[key];
      if (!dir || !fs.statSync(dir).isDirectory()) return false;
      const relative = path.relative(tmp, fs.realpathSync(dir));
      return relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
    });
  } catch {
    return false;
  }
}

if (isTestProcess() && (isTestProcess({ env: {} }) || !process.env.AW_TEST_SETUP || !hasIsolatedHomes())) {
  await import('./test-setup.js');
}
