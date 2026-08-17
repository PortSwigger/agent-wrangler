// A board link is a small typed object. Supported types: `jira` (key/url, url
// resolved from a base+key) and `pr` (a GitHub pull-request url, from which the
// server derives repo/number and later writes a checkStatus). normaliseLink
// throws on an invalid item; the caller turns that into an MCP error.
const KNOWN_TYPES = new Set(['jira', 'pr']);

const GITHUB_PR_RE = /^https?:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/;

function normaliseJira(link, baseUrl) {
  const key = typeof link.key === 'string' && link.key.trim() ? link.key.trim() : undefined;
  const explicitUrl = typeof link.url === 'string' && link.url.trim() ? link.url.trim() : undefined;
  if (!key && !explicitUrl) throw new Error('Each jira link needs a key or url.');
  const url = explicitUrl ?? (baseUrl && key ? `${baseUrl}${key}` : undefined);
  const out = { type: 'jira' };
  if (key) out.key = key;
  if (url) out.url = url;
  return out;
}

export function normalisePr(link) {
  const url = typeof link.url === 'string' && link.url.trim() ? link.url.trim() : undefined;
  if (!url) throw new Error('PR links need a url.');
  const m = GITHUB_PR_RE.exec(url);
  if (!m) throw new Error('PR links must be a GitHub pull-request url like https://github.com/owner/repo/pull/123.');
  const out = { type: 'pr', url, repo: m[1], number: Number(m[2]) };
  // The poller owns checkStatus/dirty/unresolvedCount, but preserve them if a
  // set_links round-trip carries them (get_links returns them), so refreshing
  // the list doesn't wipe them.
  if (typeof link.checkStatus === 'string') out.checkStatus = link.checkStatus;
  if (typeof link.checkStatusFetchedAt === 'string') out.checkStatusFetchedAt = link.checkStatusFetchedAt;
  if (typeof link.dirty === 'boolean') out.dirty = link.dirty;
  if (typeof link.unresolvedCount === 'number') out.unresolvedCount = link.unresolvedCount;
  return out;
}

export function normaliseLink(link, baseUrl = '') {
  if (!link || typeof link !== 'object') throw new Error('Each link must be an object.');
  if (!KNOWN_TYPES.has(link.type)) throw new Error(`Unknown link type: ${link.type}. Supported: jira, pr.`);
  return link.type === 'pr' ? normalisePr(link) : normaliseJira(link, baseUrl);
}

export function normaliseLinks(links, baseUrl = '') {
  if (!Array.isArray(links)) throw new Error('links must be an array.');
  return links.map((l) => normaliseLink(l, baseUrl));
}

// Does a stored link match a remove_links selector? Selectors are match-only
// (never persisted), so they are deliberately NOT run through normaliseLink —
// we compare leniently instead. Different `type` ⇒ no match. For pr, when both
// urls are real GitHub pull urls we compare normalized repo+number so a trailing
// slash or ?query on either side still matches; otherwise trimmed url equality.
// For jira, a key match (trimmed, case-insensitive) or a trimmed url match wins.
export function linkMatches(stored, selector) {
  if (!stored || !selector || stored.type !== selector.type) return false;
  if (stored.type === 'pr') {
    const a = GITHUB_PR_RE.exec((stored.url || '').trim());
    const b = GITHUB_PR_RE.exec((selector.url || '').trim());
    if (a && b) return a[1] === b[1] && a[2] === b[2];
    return (stored.url || '').trim() === (selector.url || '').trim() && !!(selector.url || '').trim();
  }
  if (stored.type === 'jira') {
    const selKey = (selector.key || '').trim();
    if (selKey && (stored.key || '').trim().toLowerCase() === selKey.toLowerCase()) return true;
    const selUrl = (selector.url || '').trim();
    if (selUrl && (stored.url || '').trim() === selUrl) return true;
    return false;
  }
  return false;
}
