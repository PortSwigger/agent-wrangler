import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Jira links on the board: the `jira` link type (a key and/or url on a task or
// session, set through set_links), the base URL a bare key is resolved against,
// and the chip drawn for it (public/index.js, a `link.chip` contribution). Core
// keeps the generic link plumbing and the `pr` type; this owns everything that
// knows what a Jira link is. Off, stored jira links are kept untouched (they
// round-trip through set_links) but draw no chip.
//
// Leaf-safe like every manifest under server/extensions/**: path/url only.

export const dir = path.dirname(fileURLToPath(import.meta.url));

// The base URL a bare key is appended to. The Settings value wins; an empty one
// falls back to AW_JIRA_BASE_URL, an org-wide default for a company's own
// deployment. No org is assumed otherwise — a public build must not point at any
// one company's Jira. A trailing slash is added when missing, since the key is
// appended directly.
export function baseUrlFrom(configured, env = process.env) {
  const v = typeof configured === 'string' && configured.trim() ? configured.trim() : (env.AW_JIRA_BASE_URL || '').trim();
  if (!v) return '';
  return v.endsWith('/') ? v : `${v}/`;
}

export function normaliseJira(link, baseUrl) {
  const key = typeof link.key === 'string' && link.key.trim() ? link.key.trim() : undefined;
  const explicitUrl = typeof link.url === 'string' && link.url.trim() ? link.url.trim() : undefined;
  if (!key && !explicitUrl) throw new Error('Each jira link needs a key or url.');
  const url = explicitUrl ?? (baseUrl && key ? `${baseUrl}${key}` : undefined);
  const out = { type: 'jira' };
  if (key) out.key = key;
  if (url) out.url = url;
  return out;
}

export function normalise({ link, host }) {
  if (link?.type !== 'jira') return undefined;
  return normaliseJira(link, baseUrlFrom(host.settings.get('baseUrl')));
}

export default {
  id: 'jira',
  label: 'Jira',
  description: 'Jira issue links on tasks and sessions, with the base URL a bare issue key links to.',
  help: 'Lets agents attach a Jira issue to a task or session and draws it as a chip. Turning it off hides the chips and stops new Jira links being set; links already stored are kept.',
  author: 'Agent Wrangler',
  dir,
  defaultEnabled: true,
  requires: [],
  engines: { wranglerApi: '^1.18.0' },
  settings: [{
    key: 'baseUrl',
    type: 'text',
    label: 'Jira base URL',
    help: 'What a bare issue key is appended to, e.g. https://yourcompany.atlassian.net/browse/. Empty uses the AW_JIRA_BASE_URL environment variable if set, otherwise a bare key shows as plain text.',
    placeholder: 'https://yourcompany.atlassian.net/browse/',
  }],
  hooks: { 'links.normalise': normalise },
  client: 'public/index.js',
};
