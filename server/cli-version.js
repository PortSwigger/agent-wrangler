import { execFile as defaultExecFile } from 'node:child_process';

const cache = new Map();

// The installed version of an agent CLI (`<bin> --version`), as `x.y.z`, or
// null when it cannot be run or read. Cached briefly: a launch under a tool
// policy asks once, and an upgrade is picked up within a minute.
export function cliVersion(bin, { execFile = defaultExecFile, ttlMs = 60_000, now = Date.now } = {}) {
  const hit = cache.get(bin);
  if (hit && now() - hit.at < ttlMs) return hit.version;
  const version = new Promise((resolve) => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('CLAUDE_CODE_') && k !== 'CLAUDECODE'));
    execFile(bin, ['--version'], { env, timeout: 10_000 }, (err, stdout) => {
      const m = !err && /(\d+\.\d+\.\d+)/.exec(String(stdout));
      resolve(m ? m[1] : null);
    });
  });
  cache.set(bin, { at: now(), version });
  version.then((v) => { if (!v) cache.delete(bin); });
  return version;
}

export function _resetCliVersionCacheForTests() {
  cache.clear();
}
