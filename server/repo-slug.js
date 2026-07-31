// Derive a GitHub "owner/repo" slug from a session's git remote, so the client
// can turn a bare "PR #N" terminal reference into a github.com/<slug>/pull/<n>
// link. Leaf module (node built-ins only) — never imports session-manager /
// state-reader / index, same discipline as worktree.js.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

// origin remote → "owner/repo" | null. Handles both remote shapes we see:
//   - SSH scp form:  [user@]github.com:owner/repo(.git)   ← custom-SSO user before @
//   - URL form:      https|ssh|git ://[user@]github.com/owner/repo(.git)(/)
// Any non-github.com host, or an unparseable string, yields null.
export function parseGithubSlug(remoteUrl) {
  if (!remoteUrl) return null;
  const s = String(remoteUrl).trim();
  let m = s.match(/^(?:[^@]+@)?github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (m) return `${m[1]}/${m[2]}`;
  m = s.match(/^(?:https?|ssh|git):\/\/(?:[^@/]+@)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  if (m) return `${m[1]}/${m[2]}`;
  return null;
}

// dir -> "owner/repo" | null. Cache misses too: a non-GitHub / remote-less dir
// must not be re-shelled on every board rebuild. Remotes don't change mid-session;
// a server restart clears the cache.
const slugCache = new Map();

export async function repoSlugFor(dir) {
  if (!dir) return null;
  if (slugCache.has(dir)) return slugCache.get(dir);
  let slug = null;
  try {
    const { stdout } = await exec('git', ['-C', dir, 'remote', 'get-url', 'origin']);
    slug = parseGithubSlug(stdout);
  } catch {
    slug = null;
  }
  slugCache.set(dir, slug);
  return slug;
}
