import { findRuntime } from '../runtimes/index.js';
import { hasLocation, atLocation } from './index.js';
import { isValidBranchName } from '../worktree.js';

// The branch a location card works on: `{ branch, branchBase }` to store on
// the card, empty when neither is given.
export function checkLocationBranch({ branch, base }) {
  const out = {};
  for (const [key, field, v] of [['branch', 'branch', branch], ['base', 'branchBase', base]]) {
    if (v == null || v === '') continue;
    if (typeof v !== 'string' || !isValidBranchName(v)) throw new Error(`${key} "${v}" is not a valid git branch name`);
    out[field] = v;
  }
  if (out.branchBase && !out.branch) throw new Error('base needs a branch');
  return out;
}

// name_branch at a location: core records the new name, and the agent, which
// runs where its clones are, renames the branch itself.
export function renameLocationBranchText(from, to) {
  return [
    `This session's branch is now recorded as "${to}". In any checkout on "${from}", run git branch -m ${from} ${to}.`,
    'If you already pushed the old branch, push the new one and delete the old one on the remote.',
  ].join('\n');
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
