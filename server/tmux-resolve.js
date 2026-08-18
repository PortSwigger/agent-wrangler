import path from 'node:path';
import { execFile } from 'node:child_process';

// `command -v` (POSIX sh builtin) over `which` — the latter is a separate,
// sometimes-absent package on slim Linux.
function defaultRun() {
  return new Promise((resolve) => {
    execFile('sh', ['-c', 'command -v tmux'], (err, stdout) => resolve({ err, stdout: stdout || '' }));
  });
}

// Exported (not inlined into TmuxNotFoundError) so a test can assert both
// branches without monkeypatching process.platform. The Linux command stays
// its own code span, matching the README's phrasing — the "or your distro's
// equivalent" aside is prose, not something a user could paste as-is.
export function installHint(platform = process.platform) {
  return platform === 'darwin'
    ? { cmd: 'brew install tmux', note: '' }
    : { cmd: 'apt-get install tmux', note: " (or your distro's equivalent)" };
}

export class TmuxNotFoundError extends Error {
  constructor(searchedPath) {
    const { cmd, note } = installHint();
    super(
      `tmux not found on PATH (searched: ${searchedPath || '<empty>'}). `
      + `agent-wrangler requires tmux to run sessions — install it with \`${cmd}\`${note} and try again.`,
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
// `command -v` can also emit a bare name via a shell function/alias override —
// require an absolute path so callers (e.g. pty-channel.js's PATH-prepend) never
// silently gain a relative `.` entry.
export async function resolveTmuxBin(run = defaultRun) {
  const { err, stdout } = await run();
  const resolved = err ? '' : stdout.trim();
  if (!resolved || !path.isAbsolute(resolved)) throw new TmuxNotFoundError(process.env.PATH || '');
  return resolved;
}
