// A board link is a small typed object. Core owns `pr` (a GitHub pull-request
// url, from which the server derives repo/number and later writes a
// checkStatus); every other type is claimed by an extension through its
// `links.normalise` hook (the jira extension claims `jira`). normaliseLink
// throws on an invalid item; the caller turns that into an MCP error.
const GITHUB_PR_RE = /^https?:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/;

export function normalisePr(link) {
  const url = typeof link.url === 'string' && link.url.trim() ? link.url.trim() : undefined;
  if (!url) throw new Error('PR links need a url.');
  const m = GITHUB_PR_RE.exec(url);
  if (!m) throw new Error('PR links must be a GitHub pull-request url like https://github.com/owner/repo/pull/123.');
  const out = { type: 'pr', url, repo: m[1], number: Number(m[2]) };
  // The poller owns checkStatus/headSha/dirty/unresolvedCount, but a set_links
  // round-trip carries them back from get_links and must not wipe them.
  if (typeof link.checkStatus === 'string') out.checkStatus = link.checkStatus;
  if (typeof link.checkStatusFetchedAt === 'string') out.checkStatusFetchedAt = link.checkStatusFetchedAt;
  if (typeof link.headSha === 'string') out.headSha = link.headSha;
  if (typeof link.dirty === 'boolean') out.dirty = link.dirty;
  if (typeof link.unresolvedCount === 'number') out.unresolvedCount = link.unresolvedCount;
  return out;
}

// The first enabled extension whose `links.normalise` hook returns a link claims
// the type. `ext` is the loaded registry, `hostApiFor` maps an extension id to
// its façade; both are read per call so a live enable/disable is seen.
export function createLinkNormaliser(ext, hostApiFor) {
  return (link) => {
    for (const { extId, fn } of ext?.hooks?.['links.normalise'] || []) {
      const host = hostApiFor(extId);
      if (!host) continue;
      const out = fn({ link, host });
      if (out != null) return out;
    }
    return undefined;
  };
}

// `existing` is the scope's currently stored list. set_links is a full replace,
// so an agent round-tripping get_links resends links whose owning extension is
// now off; those are passed through unchanged rather than failing the whole
// write. A link nothing claims and nothing already stored is rejected.
export function normaliseLink(link, { claim = () => undefined, existing = [] } = {}) {
  if (!link || typeof link !== 'object') throw new Error('Each link must be an object.');
  if (link.type === 'pr') return normalisePr(link);
  const claimed = typeof link.type === 'string' ? claim(link) : undefined;
  if (claimed != null) return claimed;
  const kept = existing.find((e) => e && e.type === link.type && linkMatches(e, link));
  if (kept) return kept;
  throw new Error(`Unknown link type: ${link.type}. Supported: pr${typeof link.type === 'string' && link.type ? `, and "${link.type}" only if its extension is enabled` : ''}.`);
}

export function normaliseLinks(links, opts = {}) {
  if (!Array.isArray(links)) throw new Error('links must be an array.');
  return links.map((l) => normaliseLink(l, opts));
}

// Does a stored link match a remove_links selector? Selectors are match-only
// (never persisted), so they are deliberately NOT run through normaliseLink —
// we compare leniently instead. Different `type` ⇒ no match. For pr, when both
// urls are real GitHub pull urls we compare normalized repo+number so a trailing
// slash or ?query on either side still matches; otherwise trimmed url equality.
// For every other type, a key match (trimmed, case-insensitive) or a trimmed url
// match wins.
export function linkMatches(stored, selector) {
  if (!stored || !selector || stored.type !== selector.type) return false;
  if (stored.type === 'pr') {
    const a = GITHUB_PR_RE.exec((stored.url || '').trim());
    const b = GITHUB_PR_RE.exec((selector.url || '').trim());
    if (a && b) return a[1] === b[1] && a[2] === b[2];
    return (stored.url || '').trim() === (selector.url || '').trim() && !!(selector.url || '').trim();
  }
  const selKey = (selector.key || '').trim();
  if (selKey && (stored.key || '').trim().toLowerCase() === selKey.toLowerCase()) return true;
  const selUrl = (selector.url || '').trim();
  return !!selUrl && (stored.url || '').trim() === selUrl;
}
