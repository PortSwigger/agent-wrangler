import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export async function commandOnPath(name) {
  try {
    const { stdout } = await exec('sh', ['-c', 'command -v "$1"', 'sh', name]);
    return Boolean(stdout.trim());
  } catch {
    return false;
  }
}

export function createInstalledAgents({ adapters, onPath = commandOnPath, ttlMs = 10_000, now = Date.now }) {
  let cached = null;
  let checkedAt = 0;
  let pending = null;
  return function installedAgents() {
    if (cached && now() - checkedAt < ttlMs) return Promise.resolve(cached);
    if (pending) return pending;
    pending = (async () => {
      const list = adapters();
      const flags = await Promise.all(list.map((a) => onPath(a.cli || a.id).catch(() => false)));
      cached = list.filter((_, i) => flags[i]).map((a) => a.id);
      checkedAt = now();
      return cached;
    })().finally(() => { pending = null; });
    return pending;
  };
}
