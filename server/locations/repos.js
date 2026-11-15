import path from 'node:path';
import { findRuntime } from '../runtimes/index.js';
import { hasLocation, atLocation } from './index.js';
import { isValidBranchName } from '../worktree.js';

// A session at a location works on GitHub repos (`owner/name`) it clones
// itself, stored on the card as `entry.repos`.

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const NAME = /^[A-Za-z0-9._-]{1,100}$/;
export const MAX_REPOS = 20;

// `owner/name` strings, trimmed, de-duplicated (GitHub names are
// case-insensitive) and in the given order. A GitHub URL or `.git` suffix is
// reduced to `owner/name`. Throws on anything else, naming the bad entry.
export function normaliseRepos(list) {
  if (list == null) return [];
  if (!Array.isArray(list)) throw new Error('repos must be an array of "owner/name" strings');
  const out = [];
  const seen = new Set();
  for (const raw of list) {
    if (typeof raw !== 'string') throw new Error(`repos entries must be "owner/name" strings (got ${JSON.stringify(raw)})`);
    const s = raw.trim()
      .replace(/^(?:https?:\/\/|git@)?github\.com[/:]/i, '')
      .replace(/\.git$/i, '')
      .replace(/\/+$/, '');
    const [owner, name, ...rest] = s.split('/');
    if (rest.length || !owner || !name || !OWNER.test(owner) || !NAME.test(name) || name === '.' || name === '..') {
      throw new Error(`"${raw}" is not a GitHub repo; use owner/name`);
    }
    const key = `${owner}/${name}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(`${owner}/${name}`);
  }
  if (out.length > MAX_REPOS) throw new Error(`A session takes at most ${MAX_REPOS} repos.`);
  return out;
}

export function holdsRepo(repos, repo) {
  const want = String(repo || '').toLowerCase();
  return (repos || []).some((r) => r.toLowerCase() === want);
}

// The repos a child of `parent` may have: `repos`, the ones it asked for that
// the parent holds (every one the parent holds when it asked for none), and
// `withheld`, the ones it asked for that the parent does not hold. A withheld
// repo reaches the child only through request_repo and the human's answer.
export function childRepos(parent, asked) {
  if (!atLocation(parent)) return { repos: asked, withheld: [] };
  const held = parent.repos || [];
  if (!asked.length) return { repos: [...held], withheld: [] };
  return { repos: asked.filter((r) => holdsRepo(held, r)), withheld: asked.filter((r) => !holdsRepo(held, r)) };
}

// The line a child's brief carries for the repos it asked for and was not given.
export function withheldReposBrief(withheld) {
  if (!withheld?.length) return '';
  const one = withheld.length === 1;
  return `You were also asked to work on ${withheld.join(', ')}, which the session that started you cannot reach, so you were not given ${one ? 'it' : 'them'}. If you need ${one ? 'it' : 'them'}, ask the human with the request_repo tool and carry on with what you can meanwhile.`;
}

// Where each repo is cloned at the location: `<cwd>/<name>`, or
// `<cwd>/<owner>-<name>` when two repos share a name.
export function repoDirs(cwd, repos) {
  const names = repos.map((r) => r.split('/')[1].toLowerCase());
  return repos.map((repo, i) => {
    const [owner, name] = repo.split('/');
    const clash = names.filter((n) => n === names[i]).length > 1;
    return { repo, dir: cwd ? path.posix.join(cwd, clash ? `${owner}-${name}` : name) : (clash ? `${owner}-${name}` : name) };
  });
}

// The first lines of a location session's prompt: which repos to work on and
// how to get them.
export function reposBrief(cwd, repos, { branch, base } = {}) {
  if (!repos?.length) return '';
  const lines = repoDirs(cwd, repos).map(({ repo, dir }) => `- ${repo}: git clone --filter=blob:none https://github.com/${repo}.git ${dir}`);
  const switchCmd = ['git switch -c', branch, base && `origin/${base}`].filter(Boolean).join(' ');
  const branching = branch
    ? `In each clone, create and check out the branch \`${branch}\` off ${base ? `\`origin/${base}\`` : 'the default branch'} (\`${switchCmd}\`) before changing anything, and push only to that branch.`
    : 'In each clone, create a new branch off the default branch before changing anything. Push and open pull requests as you normally would.';
  return [
    `Work in ${repos.length === 1 ? 'this GitHub repository' : 'these GitHub repositories'}. Clone ${repos.length === 1 ? 'it' : 'each one'} from GitHub first:`,
    ...lines,
    branching,
  ].join('\n');
}

// The repos in `added` a card holding `have` can take: each one not already held
// (GitHub names are case-insensitive). Throws for one sharing a name with a held
// repo, since repoDirs would then move the held repo's clone to `<owner>-<name>`.
export function reposToAdd(have, added) {
  const held = new Set((have || []).map((r) => r.toLowerCase()));
  const out = normaliseRepos(added).filter((r) => !held.has(r.toLowerCase()));
  for (const repo of out) {
    const name = repo.split('/')[1].toLowerCase();
    const same = (have || []).find((h) => h.split('/')[1].toLowerCase() === name);
    if (same) throw new Error(`This session already has a repo named "${repo.split('/')[1]}" (${same}), so ${repo} can't be added alongside it.`);
  }
  return out;
}

// The mail telling a location session it can now reach `added`: where to clone
// each one, and, on a card with a branch, that the branch is the only push.
export function addedReposMail(cwd, repos, added, { branch, lead = 'The human added' } = {}) {
  const one = added.length === 1;
  const dirs = repoDirs(cwd, repos).filter((r) => added.includes(r.repo));
  return [
    `${lead} ${added.join(', ')} to this session, and you can reach ${one ? 'it' : 'them'} from where you run now. Clone ${one ? 'it' : 'each one'} when you need ${one ? 'it' : 'them'}:`,
    ...dirs.map(({ repo, dir }) => `- ${repo}: git clone --filter=blob:none https://github.com/${repo}.git ${dir}`),
    ...(branch ? [`To change one, create and check out \`${branch}\` in its clone (\`git switch -c ${branch}\`): it is the only branch you can push.`] : []),
  ].join('\n');
}

// The branch a location card works on: `{ branch, branchBase }` to store on
// the card, empty when neither is given.
export function checkLocationBranch({ branch, base, repos }) {
  const out = {};
  for (const [key, field, v] of [['branch', 'branch', branch], ['base', 'branchBase', base]]) {
    if (v == null || v === '') continue;
    if (typeof v !== 'string' || !isValidBranchName(v)) throw new Error(`${key} "${v}" is not a valid git branch name`);
    out[field] = v;
  }
  if (out.branchBase && !out.branch) throw new Error('base needs a branch');
  if (out.branch && !repos?.length) throw new Error('branch needs GitHub repos to branch');
  return out;
}

// name_branch at a location: core records the new name, and the agent, which
// runs where its clones are, renames the branch itself.
export function renameLocationBranchText(entry, from, to) {
  const dirs = repoDirs(entry?.cwd || '', entry?.repos || []).map((r) => r.dir);
  return [
    `This session's branch is now recorded as "${to}". Rename it in each clone that has "${from}":`,
    ...dirs.map((d) => `- git -C ${d} branch -m ${from} ${to}`),
    'If you already pushed the old branch, push the new one and delete the old one on the remote.',
  ].join('\n');
}

const GITHUB_PR = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/\d+/i;

export function prRepoOf(url) {
  const m = GITHUB_PR.exec(String(url || ''));
  return m ? `${m[1]}/${m[2]}` : null;
}

// Null when a location card may hold this pr link, else why not. A card on
// this machine may hold any.
export function prLinkRefusal(entry, link) {
  if (!atLocation(entry) || link?.type !== 'pr') return null;
  const repo = prRepoOf(link.url);
  if (repo && holdsRepo(entry.repos, repo)) return null;
  const held = entry.repos?.length ? entry.repos.join(', ') : 'none';
  return `${link.url} is not a pull request in this session's repos (${held}), so it can't be linked.`;
}

export const MAX_UNPUSHED_REPOS = 50;
export const MAX_UNPUSHED_COMMITS = 20;
const MAX_TEXT = 300;

function text(v, max = MAX_TEXT) {
  return typeof v === 'string' && v ? v.replace(/[\0\r\n]+/g, ' ').slice(0, max) : null;
}

function cleanFinding(f) {
  if (!f || typeof f !== 'object') return null;
  const commits = Array.isArray(f.commits)
    ? f.commits.filter((c) => c && typeof c.sha === 'string' && /^[0-9a-f]{4,64}$/i.test(c.sha))
      .slice(0, MAX_UNPUSHED_COMMITS)
      .map((c) => ({ sha: c.sha, subject: text(c.subject) || '' }))
    : [];
  const error = text(f.error);
  if (!commits.length && !error) return null;
  return { repo: text(f.repo, 200), dir: text(f.dir, 4096), commits, ...(error ? { error } : {}) };
}

// For each card in `ids` at a location, what archiving it could lose:
// `[{ sessionId, label, repos: [{ repo, dir, commits: [{ sha, subject }], error? }] }]`,
// empty when nothing is at risk. Asked of the runtime's `location.unpushed`; a
// runtime without one has nothing to report. A hook that fails or answers
// off-shape is reported as an error rather than passed as clean.
export async function findUnpushed(ids, { entryFor, labelFor = () => null, runtimeOf = findRuntime } = {}) {
  const out = [];
  const seenRefs = new Set();
  for (const sessionId of ids) {
    const entry = entryFor(sessionId);
    if (!atLocation(entry)) continue;
    const refKey = `${entry.runtime}\n${JSON.stringify(entry.location)}`;
    if (seenRefs.has(refKey)) continue;
    seenRefs.add(refKey);
    let rt = null;
    try { rt = runtimeOf(entry.runtime); } catch { rt = null; }
    let repos;
    try {
      if (!hasLocation(rt)) throw new Error('its runtime is not available');
      if (typeof rt.location.unpushed !== 'function') continue;
      const raw = await rt.location.unpushed({ ref: entry.location, entry });
      if (!Array.isArray(raw)) throw new Error('the runtime answered without a list');
      repos = raw.slice(0, MAX_UNPUSHED_REPOS).map(cleanFinding).filter(Boolean);
    } catch (err) {
      repos = [{ repo: null, dir: null, commits: [], error: `Could not check for unpushed commits: ${err?.message || err}` }];
    }
    if (repos.length) out.push({ sessionId, label: labelFor(sessionId) || entry.intent || sessionId, repos });
  }
  return out;
}

// One plain-text paragraph per card, for an MCP or host refusal.
export function unpushedText(found) {
  return found.map((f) => [
    `${f.label}:`,
    ...f.repos.map((r) => r.error
      ? `  ${r.repo || r.dir || 'session'}: ${r.error}`
      : `  ${r.repo || r.dir}: ${r.commits.length} commit${r.commits.length === 1 ? '' : 's'} on no remote branch (${r.commits.slice(0, 3).map((c) => `${c.sha} ${c.subject}`).join('; ')}${r.commits.length > 3 ? '; …' : ''})`),
  ].join('\n')).join('\n');
}
