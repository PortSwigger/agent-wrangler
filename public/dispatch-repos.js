// The dispatch dialog's "GitHub repos" field, shown instead of the folder for a
// runtime that runs sessions elsewhere. Mirrors server/locations/repos.js's
// normaliseRepos (public/ and server/ never cross-import); the server is the
// authority and re-checks every entry.

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const NAME = /^[A-Za-z0-9._-]{1,100}$/;

// { repos: ['owner/name', …], error: null } or { repos: [], error: 'why' } for
// what a person typed: commas, spaces or newlines between repos, GitHub URLs allowed.
export function parseRepoInput(text) {
  const repos = [];
  const seen = new Set();
  for (const raw of String(text || '').split(/[\s,]+/).filter(Boolean)) {
    const s = raw.replace(/^(?:https?:\/\/|git@)?github\.com[/:]/i, '').replace(/\.git$/i, '').replace(/\/+$/, '');
    const [owner, name, ...rest] = s.split('/');
    if (rest.length || !owner || !name || !OWNER.test(owner) || !NAME.test(name) || name === '.' || name === '..') {
      return { repos: [], error: `"${raw}" is not a GitHub repo; use owner/name.` };
    }
    const key = `${owner}/${name}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    repos.push(`${owner}/${name}`);
  }
  return { repos, error: null };
}

// Whether the runtime `runtimeId` (contributed by `extId`) runs its sessions at
// an execution location of its own, per the graph's extension runtime summaries.
export function runtimeHasLocation(extensions, extId, runtimeId) {
  if (!extId) return false;
  const e = (extensions || []).find((x) => x.id === extId);
  return Boolean(e?.runtimes?.find((r) => r?.id === runtimeId)?.location);
}
