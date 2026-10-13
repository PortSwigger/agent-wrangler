import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execP = promisify(execFile);

// Killing a tmux session while the agent is still running in it can deadlock macOS:
// the pane shell revokes its tty (vn_revoke) while the agent is still in close(), and
// both sleep forever (and later wedge every tty-resolving `ps`). So signal the agent
// first and let it exit; only then fall back to the kill. A normal exit can't race.
const GRACE_MS = 3000;
const POLL_MS = 100;
const PS_BOUND_MS = 2000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Resolve with `p`, or with `fallback` after `ms` — never hangs on a wedged child.
function bounded(p, ms, fallback) {
  let t;
  return Promise.race([p.catch(() => fallback), new Promise((r) => { t = setTimeout(() => r(fallback), ms); })])
    .finally(() => clearTimeout(t));
}

async function psChildren() {
  const { stdout } = await execP('ps', ['-axo', 'pid=,ppid='], { timeout: PS_BOUND_MS });
  const children = new Map();
  for (const line of stdout.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s*$/);
    if (!m) continue;
    const ppid = Number(m[2]);
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid).push(Number(m[1]));
  }
  return children;
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function descendants(children, roots) {
  const out = [];
  const seen = new Set(roots);
  const queue = [...roots];
  while (queue.length) {
    for (const c of children.get(queue.shift()) || []) {
      if (seen.has(c)) continue;
      seen.add(c);
      out.push(c);
      queue.push(c);
    }
  }
  return out;
}

// SIGTERM everything running under the panes of `scope` ({ session } or { all: true }),
// then wait up to graceMs for it to exit. Never throws: any failure just means the
// caller's kill proceeds as before. `run(tmuxArgs)` is the caller's tmux runner. The
// seams (children/signal/alive) are for tests.
export async function stopPaneProcesses(run, scope, {
  graceMs = GRACE_MS,
  children = () => bounded(psChildren(), PS_BOUND_MS + 500, null),
  signal = (pid) => process.kill(pid, 'SIGTERM'),
  alive = isAlive,
} = {}) {
  try {
    const args = scope.all ? ['list-panes', '-a', '-F', '#{pane_pid}'] : ['list-panes', '-s', '-t', scope.session, '-F', '#{pane_pid}'];
    const { stdout } = await run(args);
    const panePids = String(stdout || '').split('\n').map((s) => Number(s.trim())).filter((n) => n > 1);
    if (!panePids.length) return;
    const tree = await children();
    if (!tree) return;
    const pids = descendants(tree, panePids);
    for (const pid of pids) { try { signal(pid); } catch { /* already gone */ } }
    const deadline = Date.now() + graceMs;
    while (pids.some(alive) && Date.now() < deadline) await sleep(POLL_MS);
  } catch { /* fall through to the hard kill */ }
}

// kill-session / kill-server, but with the agent given the chance to exit first.
export async function gentleKill(run, scope, opts) {
  await stopPaneProcesses(run, scope, opts);
  return run(scope.all ? ['kill-server'] : ['kill-session', '-t', scope.session]);
}
