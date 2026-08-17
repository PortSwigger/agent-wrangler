import { execFile } from 'node:child_process';

// `command -v` (POSIX sh builtin) over `which` — the latter is a separate,
// sometimes-absent package on slim Linux.
function defaultRun() {
  return new Promise((resolve) => {
    execFile('sh', ['-c', 'command -v tmux'], (err, stdout) => resolve({ err, stdout: stdout || '' }));
  });
}

export class TmuxNotFoundError extends Error {
  constructor(searchedPath) {
    const hint = process.platform === 'darwin'
      ? 'brew install tmux'
      : "apt-get install tmux (or your distro's equivalent)";
    super(
      `tmux not found on PATH (searched: ${searchedPath}). `
      + `agent-wrangler requires tmux to run sessions — install it with \`${hint}\` and try again.`,
    );
    this.name = 'TmuxNotFoundError';
  }
}

// Resolve tmux to an absolute path so node-pty's posix_spawnp can't miss it, or
// throw rather than silently falling back to a bare "tmux" that only fails later,
// as a raw ENOENT, the first time something spawns it (dispatch/attach). Called
// once up front in server/index.js's main() (before acquireInstanceLock — a
// missing prerequisite is an environment fact, not an instance-ownership one) and
// again in SessionManager.init(), which by then can rely on tmux being present.
export async function resolveTmuxBin(run = defaultRun) {
  const { err, stdout } = await run();
  const resolved = err ? '' : stdout.trim();
  if (!resolved) throw new TmuxNotFoundError(process.env.PATH || '');
  return resolved;
}
