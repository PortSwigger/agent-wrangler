import crypto from 'node:crypto';
import { runHeadlessClaude } from './headless-claude.js';

// Reviewers (human and bot) usually post within seconds of a PR opening or a
// push landing, so the first observation of a fresh head waits this long before
// reading the PR at all — nothing else about a seconds-old head is actionable.
export const COMMENT_SETTLE_MS = 10000;
export const MAX_COMMENTS = 100;
export const MAX_BODY = 1500;
export const TONES = ['green', 'amber', 'red'];

// `gh pr view --json` exposes neither review-thread resolution nor inline
// comments, so this is one GraphQL call keyed off the PR url. `last:` on the
// flat lists keeps the newest when a PR outgrows the page.
export const COMMENTS_QUERY = `query($url:URI!){resource(url:$url){...on PullRequest{author{login}
comments(last:100){nodes{id author{login __typename} body createdAt updatedAt url}}
reviews(last:100){nodes{id author{login __typename} state body submittedAt updatedAt url}}
reviewThreads(first:100){nodes{id isResolved isOutdated path line comments(first:30){nodes{id author{login __typename} body createdAt updatedAt url}}}}}}}`;

const clip = (s, n) => (s = String(s || '').trim()).length > n ? `${s.slice(0, n)} …` : s;
const who = (a) => ({ author: a?.login || 'ghost', bot: a?.__typename === 'Bot' });

// Flatten the GraphQL payload to one chronological list the UI and the
// triage prompt both read. A review whose only content is its inline comments
// is a container, not a comment (its `COMMENTED` state says nothing), and a
// PENDING review is an unsubmitted draft only its author can see.
export function normaliseComments(resource, fetchedAt = Date.now()) {
  if (!resource) throw new Error('PR not found when reading comments');
  const items = [];
  for (const c of resource.comments?.nodes || []) {
    items.push({ id: c.id, kind: 'comment', ...who(c.author), body: clip(c.body, MAX_BODY), at: c.createdAt, updatedAt: c.updatedAt, url: c.url });
  }
  for (const r of resource.reviews?.nodes || []) {
    if (r.state === 'PENDING' || (!String(r.body || '').trim() && r.state === 'COMMENTED')) continue;
    items.push({ id: r.id, kind: 'review', state: r.state, ...who(r.author), body: clip(r.body, MAX_BODY), at: r.submittedAt, updatedAt: r.updatedAt, url: r.url });
  }
  let unresolved = 0;
  for (const t of resource.reviewThreads?.nodes || []) {
    if (!t.isResolved) unresolved++;
    for (const c of t.comments?.nodes || []) {
      items.push({ id: c.id, kind: 'thread', threadId: t.id, resolved: !!t.isResolved, outdated: !!t.isOutdated, path: t.path || null, line: t.line ?? null,
        ...who(c.author), body: clip(c.body, MAX_BODY), at: c.createdAt, updatedAt: c.updatedAt, url: c.url });
    }
  }
  items.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  const truncated = Math.max(0, items.length - MAX_COMMENTS);
  const kept = items.slice(truncated);
  // Edits and thread resolution change what the summary should say, so both
  // feed the fingerprint the runner re-triages on.
  const fingerprint = crypto.createHash('sha1').update(kept.map((i) => `${i.id}:${i.updatedAt}:${i.resolved ?? ''}`).join('\n')).digest('hex');
  return { fetchedAt, prAuthor: resource.author?.login || null, items: kept, truncated, unresolved, fingerprint };
}

const TRIAGE_PROMPT = `The text on stdin is JSON describing the comments on a GitHub pull request opened by an automated coding agent: the PR author, then every conversation comment, review and inline review-thread comment in time order. Thread comments carry "resolved". Classify what the comments collectively mean for merging and summarise them for the human who owns this PR.

Output exactly one JSON object and nothing else: {"tone":"green"|"amber"|"red","summary":"..."}.

tone rules, in precedence order:
- "red" = merging is blocked: a reviewer requested changes or asked for something to be fixed before merge, an unresolved thread points at a defect (bug, regression, security, data loss, broken behaviour), or a reviewer said do not merge.
- "amber" = needs attention but nothing clearly blocks: questions awaiting an answer, suggestions or nits left unresolved, style or naming feedback, or comments whose intent is unclear.
- "green" = all good: approvals, resolved threads, praise, or purely informational bot output (coverage, preview links, size labels).
A thread that is resolved, or a request the author has visibly answered or fixed in a later comment, no longer counts against the PR. When unsure between two tones, choose the more cautious one.

summary: one to three short sentences in plain English, at most 400 characters. Lead with what needs doing (or that nothing does), name who asked where that helps, and never quote long passages. No markdown, no preamble.`;

export function parseTriage(text) {
  const match = String(text || '').match(/\{[\s\S]*\}/);
  if (!match) return null;
  let parsed;
  try { parsed = JSON.parse(match[0]); } catch { return null; }
  if (!TONES.includes(parsed?.tone) || typeof parsed.summary !== 'string' || !parsed.summary.trim()) return null;
  return { tone: parsed.tone, text: clip(parsed.summary.replace(/\s+/g, ' '), 400) };
}

// Payload for the triage prompt. Bodies shrink when the whole thing would be
// large: a hundred long comments is a cost problem, not a classification one.
export function triageInput(comments, pr) {
  const base = { pr: { url: pr?.url, branch: pr?.branch, reviewDecision: pr?.reviewDecision || null, author: comments.prAuthor }, truncatedOlder: comments.truncated };
  for (const cap of [MAX_BODY, 500, 200]) {
    const text = JSON.stringify({ ...base, comments: comments.items.map((i) => ({ ...i, body: clip(i.body, cap) })) });
    if (text.length <= 60000 || cap === 200) return text;
  }
}

// One Haiku call per distinct comment fingerprint. Never throws: a failed or
// unparseable run is an amber "unavailable" verdict, so a broken classifier
// can hold up a merge for at most one poll and never forever.
export async function summariseComments(comments, pr, { run = runHeadlessClaude } = {}) {
  const { text, liveSessionId, error } = await run(TRIAGE_PROMPT, triageInput(comments, pr));
  const verdict = error ? null : parseTriage(text);
  if (verdict) return { ...verdict, liveSessionId, error: false };
  const reason = String(error?.message || error || 'unrecognised reply').split('\n')[0].slice(0, 160);
  return { tone: 'amber', text: `Summary unavailable (${reason}). Read the comments yourself before merging.`, liveSessionId, error: true };
}

// The automatic-merge gate. Comments still awaiting their verdict hold the
// merge for a poll; a red verdict holds it until a human approves the head.
// Mirrored client-side in public/jobs.js — keep the two in step.
export function commentsBlockMerge(sub) {
  const c = sub?.prComments;
  if (!c?.items?.length) return false;
  const s = sub.commentSummary;
  if (!s || s.fingerprint !== c.fingerprint) return true;
  return s.tone === 'red';
}
