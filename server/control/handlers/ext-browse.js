// Public GitHub repositories tagged with the extension topic, for the "+ Add
// extension" pane to list. A listing only: picking one sends its clone URL down
// the ordinary `ext-install` path, so the clone, the disclosure and the consent
// modal are exactly what a pasted URL gets. Nothing here vets a repository —
// anyone can tag theirs — and the pane says so.
//
// ON DEMAND ONLY, like ext-check-updates: one search per opening of the pane or
// press of Refresh, never on a timer. Unauthenticated, so GitHub's search limit
// (10 a minute per IP) applies; that is far more than a human browsing needs.
export const EXTENSION_TOPIC = 'agent-wrangler-extension';
const SEARCH_URL = `https://api.github.com/search/repositories?q=${encodeURIComponent(`topic:${EXTENSION_TOPIC} archived:false`)}&sort=stars&order=desc&per_page=100`;

// A module seam rather than an option on the frame, for the same reason as the
// install runners: a control frame is browser-supplied.
let fetchImpl = (...args) => fetch(...args);
export function _setBrowseFetchForTests(next = null) {
  fetchImpl = next || ((...args) => fetch(...args));
}

// Third-party data: only these fields leave the server, each coerced to a
// string or number, and only repositories whose clone URL is plain https on
// github.com — the install handler would refuse anything else anyway.
function toRepo(item) {
  const cloneUrl = String(item?.clone_url || '');
  const htmlUrl = String(item?.html_url || '');
  if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\.git$/.test(cloneUrl)) return null;
  if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/.test(htmlUrl)) return null;
  // The avatar is drawn as an <img>, so only GitHub's own avatar host is passed on.
  const avatar = String(item.owner?.avatar_url || '');
  return {
    fullName: String(item.full_name || ''),
    name: String(item.name || ''),
    owner: String(item.owner?.login || ''),
    avatarUrl: /^https:\/\/avatars\.githubusercontent\.com\//.test(avatar) ? avatar : '',
    description: String(item.description || ''),
    cloneUrl,
    htmlUrl,
    stars: Number(item.stargazers_count) || 0,
    language: String(item.language || ''),
    pushedAt: String(item.pushed_at || ''),
  };
}

export const extBrowseHandler = {
  type: 'ext-browse',
  async handler(msg, ctx) {
    // Every outcome is replied as ext-browse-results, never thrown: the
    // router's generic {type:'error'} would leave the pane saying "Searching…".
    try {
      const res = await fetchImpl(SEARCH_URL, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'agent-wrangler' },
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) {
        const limited = res.status === 403 || res.status === 429;
        throw new Error(limited ? 'GitHub\'s search rate limit was hit — try again in a minute.' : `GitHub answered ${res.status}.`);
      }
      const body = await res.json();
      const repos = (Array.isArray(body?.items) ? body.items : []).map(toRepo).filter(Boolean);
      ctx.reply({ type: 'ext-browse-results', topic: EXTENSION_TOPIC, repos });
    } catch (err) {
      ctx.reply({ type: 'ext-browse-results', topic: EXTENSION_TOPIC, repos: [], error: String(err?.message || err) });
    }
  },
};
