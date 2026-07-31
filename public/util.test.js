import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  esc, truncate, wtSlug, repoRoot, locationLabel, isWorktree,
  branchBadge, tildify, timeAgo, pad2, throbDelayStyle, mostCommonCwd,
  safeHttpUrl,
} from './util.js';

// ── esc ──────────────────────────────────────────────────────────────────────
test('esc: escapes all five HTML special characters', () => {
  assert.equal(esc('<script>&"\''), '&lt;script&gt;&amp;&quot;&#39;');
});
test('esc: passes plain strings through unchanged', () => {
  assert.equal(esc('hello world'), 'hello world');
});
test('esc: coerces null/undefined to empty string', () => {
  assert.equal(esc(null), '');
  assert.equal(esc(undefined), '');
});

// ── truncate ─────────────────────────────────────────────────────────────────
test('truncate: leaves short strings unchanged', () => {
  assert.equal(truncate('hello', 10), 'hello');
});
test('truncate: truncates and appends ellipsis at the limit', () => {
  const r = truncate('hello world', 6);
  assert.equal(r.length, 6);
  assert.match(r, /…$/);
});
test('truncate: handles null/undefined gracefully', () => {
  assert.equal(truncate(null, 10), null);
  assert.equal(truncate('', 10), '');
});

// ── wtSlug ───────────────────────────────────────────────────────────────────
test('wtSlug: generates a kebab slug from intent, skipping stopwords', () => {
  assert.equal(wtSlug('add support for worktrees'), 'add-support-worktrees');
});
test('wtSlug: caps at 30 chars and strips leading/trailing dashes', () => {
  const slug = wtSlug('the quick brown fox jumps over a lazy dog');
  assert.ok(slug.length <= 30);
  assert.doesNotMatch(slug, /^-|-$/);
});
test('wtSlug: handles empty/null gracefully', () => {
  assert.equal(wtSlug(''), '');
  assert.equal(wtSlug(null), '');
});

// ── repoRoot ─────────────────────────────────────────────────────────────────
test('repoRoot: collapses a .claude/worktrees path to its repo root', () => {
  assert.equal(
    repoRoot('/Users/j/vcs/myrepo/.claude/worktrees/feat'),
    '/Users/j/vcs/myrepo',
  );
});
test('repoRoot: collapses a -worktree- sibling path to its repo', () => {
  assert.equal(
    repoRoot('/Users/j/vcs/myrepo-worktree-feat'),
    '/Users/j/vcs/myrepo',
  );
});
test('repoRoot: passes through a non-worktree path unchanged', () => {
  assert.equal(repoRoot('/Users/j/vcs/myrepo'), '/Users/j/vcs/myrepo');
});
test('repoRoot: strips a trailing slash so it dedups against the slashless path', () => {
  assert.equal(repoRoot('/Users/j/vcs/myrepo/'), '/Users/j/vcs/myrepo');
  assert.equal(repoRoot('/Users/j/vcs/myrepo///'), '/Users/j/vcs/myrepo');
});
test('repoRoot: folds a -worktree- sibling even with a trailing slash', () => {
  assert.equal(repoRoot('/Users/j/vcs/myrepo-worktree-feat/'), '/Users/j/vcs/myrepo');
});
test('repoRoot: keeps the filesystem root intact', () => {
  assert.equal(repoRoot('/'), '/');
});

// ── locationLabel ─────────────────────────────────────────────────────────────
test('locationLabel: returns an emoji-prefixed repo name', () => {
  const label = locationLabel('/Users/j/vcs/myrepo');
  assert.match(label, /^📁/);
  assert.match(label, /myrepo/);
});
test('locationLabel: returns empty string for falsy cwd', () => {
  assert.equal(locationLabel(''), '');
  assert.equal(locationLabel(null), '');
});

// ── isWorktree ────────────────────────────────────────────────────────────────
test('isWorktree: true for .claude/worktrees path', () => {
  assert.equal(isWorktree({ cwd: '/vcs/repo/.claude/worktrees/feat' }), true);
});
test('isWorktree: true for -worktree- sibling', () => {
  assert.equal(isWorktree({ cwd: '/vcs/repo-worktree-feat' }), true);
});
test('isWorktree: false for a normal cwd', () => {
  assert.equal(isWorktree({ cwd: '/vcs/repo' }), false);
});
test('isWorktree: false when cwd is absent', () => {
  assert.equal(isWorktree({}), false);
});

// ── branchBadge ───────────────────────────────────────────────────────────────
test('branchBadge: returns empty string for falsy branch', () => {
  assert.equal(branchBadge(''), '');
  assert.equal(branchBadge(null), '');
});
test('branchBadge: contains the branch name', () => {
  assert.match(branchBadge('feat/thing'), /feat\/thing/);
});
test('branchBadge: adds .main class for main/master', () => {
  assert.match(branchBadge('main'), /class="branch main"/);
  assert.match(branchBadge('master'), /class="branch main"/);
  assert.doesNotMatch(branchBadge('develop'), /class="branch main"/);
});

// ── tildify ───────────────────────────────────────────────────────────────────
test('tildify: collapses /Users/... home prefix to ~', () => {
  assert.equal(tildify('/Users/james/vcs/repo'), '~/vcs/repo');
});
test('tildify: collapses /home/... home prefix to ~', () => {
  assert.equal(tildify('/home/james/vcs/repo'), '~/vcs/repo');
});
test('tildify: leaves unrelated paths unchanged', () => {
  assert.equal(tildify('/etc/hosts'), '/etc/hosts');
});
test('tildify: returns empty string for falsy input', () => {
  assert.equal(tildify(''), '');
  assert.equal(tildify(null), '');
});

// ── timeAgo ───────────────────────────────────────────────────────────────────
test('timeAgo: returns null for falsy input', () => {
  assert.equal(timeAgo(0), null);
  assert.equal(timeAgo(null), null);
});
test('timeAgo: returns "just now" for sub-5-second deltas', () => {
  assert.equal(timeAgo(Date.now() - 2000), 'just now');
});
test('timeAgo: returns seconds for sub-minute deltas', () => {
  assert.match(timeAgo(Date.now() - 30000), /^\d+s ago$/);
});
test('timeAgo: returns minutes for sub-hour deltas', () => {
  assert.match(timeAgo(Date.now() - 5 * 60000), /^\d+m ago$/);
});
test('timeAgo: returns hours for sub-day deltas', () => {
  assert.match(timeAgo(Date.now() - 3 * 3600000), /^\d+h ago$/);
});
test('timeAgo: returns days for multi-day deltas', () => {
  assert.match(timeAgo(Date.now() - 2 * 86400000), /^\d+d ago$/);
});

// ── pad2 ─────────────────────────────────────────────────────────────────────
test('pad2: pads single digits to two characters', () => {
  assert.equal(pad2(5), '05');
  assert.equal(pad2(0), '00');
});
test('pad2: leaves two-digit numbers unchanged', () => {
  assert.equal(pad2(12), '12');
  assert.equal(pad2(99), '99');
});

// ── throbDelayStyle ───────────────────────────────────────────────────────────
test('throbDelayStyle: returns empty string for a non-throbbing state', () => {
  assert.equal(throbDelayStyle('idle'), '');
  assert.equal(throbDelayStyle('unknown'), '');
});
test('throbDelayStyle: returns a style attribute for every throbbing state', () => {
  for (const st of ['working', 'needs-you', 'just-finished', 'snooze-alarm']) {
    assert.match(throbDelayStyle(st), /style="--throb-delay:-\d+ms"/);
  }
});

// ── mostCommonCwd ─────────────────────────────────────────────────────────────
const SCRATCH = '/home/u/.agent-wrangler/sessions';
const s = (cwd, at = 0) => ({ cwd, lastActivity: at });

test('mostCommonCwd: returns the sole real folder', () => {
  assert.equal(mostCommonCwd([s('/vcs/repo')], SCRATCH), '/vcs/repo');
});
test('mostCommonCwd: returns empty string when all sessions are scratch', () => {
  assert.equal(mostCommonCwd([s(`${SCRATCH}/20240101`), s(`${SCRATCH}/20240102`)], SCRATCH), '');
});
test('mostCommonCwd: scratch strictly outnumbers top folder → scratch wins', () => {
  assert.equal(mostCommonCwd([
    s(`${SCRATCH}/1`), s(`${SCRATCH}/2`), s(`${SCRATCH}/3`), s(`${SCRATCH}/4`),
    s('/vcs/repo'),
  ], SCRATCH), '');
});
test('mostCommonCwd: scratch equals top folder count → folder wins (tie goes to folder)', () => {
  assert.equal(mostCommonCwd([s(`${SCRATCH}/1`), s(`${SCRATCH}/2`), s('/vcs/repo'), s('/vcs/repo')], SCRATCH), '/vcs/repo');
});
test('mostCommonCwd: scratch outnumbers each folder individually but not the top one → scratch wins', () => {
  // 4 scratch, 3 in folder-A, 2 in folder-B: scratch(4) > top(3) → scratch
  assert.equal(mostCommonCwd([
    s(`${SCRATCH}/1`), s(`${SCRATCH}/2`), s(`${SCRATCH}/3`), s(`${SCRATCH}/4`),
    s('/vcs/a'), s('/vcs/a'), s('/vcs/a'),
    s('/vcs/b'), s('/vcs/b'),
  ], SCRATCH), '');
});
test('mostCommonCwd: folder outnumbers scratch → returns most common folder', () => {
  assert.equal(mostCommonCwd([
    s(`${SCRATCH}/1`),
    s('/vcs/repo'), s('/vcs/repo'), s('/vcs/repo'), s('/vcs/repo'),
  ], SCRATCH), '/vcs/repo');
});
test('mostCommonCwd: ties between folders broken by most recent activity', () => {
  assert.equal(mostCommonCwd([s('/vcs/a', 100), s('/vcs/b', 200)], SCRATCH), '/vcs/b');
});
test('mostCommonCwd: collapses worktree paths to repo root before counting', () => {
  assert.equal(mostCommonCwd([s('/vcs/repo-worktree-feat'), s('/vcs/repo')], SCRATCH), '/vcs/repo');
});
test('mostCommonCwd: returns empty string for empty session list', () => {
  assert.equal(mostCommonCwd([], SCRATCH), '');
});
test('mostCommonCwd: sessions with no cwd are ignored', () => {
  assert.equal(mostCommonCwd([{ lastActivity: 0 }, s('/vcs/repo')], SCRATCH), '/vcs/repo');
});

// ── safeHttpUrl ──────────────────────────────────────────────────────────────
test('safeHttpUrl: passes http and https urls through unchanged', () => {
  assert.equal(safeHttpUrl('http://example.com/x'), 'http://example.com/x');
  assert.equal(safeHttpUrl('https://example.com/x'), 'https://example.com/x');
});
test('safeHttpUrl: rejects dangerous schemes', () => {
  assert.equal(safeHttpUrl('javascript:alert(1)'), null);
  assert.equal(safeHttpUrl('data:text/html,<script>'), null);
  assert.equal(safeHttpUrl('file:///etc/passwd'), null);
});
test('safeHttpUrl: rejects unparseable urls', () => {
  assert.equal(safeHttpUrl('not a url'), null);
  assert.equal(safeHttpUrl(''), null);
});
