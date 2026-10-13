import { spawn as defaultSpawn } from 'node:child_process';

export const PS_TIMEOUT_MS = 5000;

// Run `ps` and resolve its stdout, or null if it failed or didn't finish within
// timeoutMs. On timeout the child is abandoned, not awaited: a ps wedged in the
// kernel (lstat of a tty whose revoke is deadlocked) is unkillable, so we
// SIGKILL best-effort, unref it and drop its pipes so it can't hold the event
// loop or the caller.
export function boundedPs(args, { timeoutMs = PS_TIMEOUT_MS, spawn = defaultSpawn } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('ps', args, { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      return resolve(null);
    }
    let out = '';
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      finish(null);
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      child.stdout?.destroy();
      child.unref();
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', () => finish(null));
    child.on('close', (code) => finish(code === 0 ? out : null));
  });
}
