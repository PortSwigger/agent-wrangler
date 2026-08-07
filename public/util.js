// Pure formatting / render helpers shared by every view. No module state and no
// DOM — safe to import anywhere without a cycle. State-dependent helpers
// (isScratchDir/tildeCollapse, which read sessionsDir/homeDir) stay in app.js.

const WT_STOPWORDS = new Set(['the','a','an','to','of','for','on','in','at','and','or','is','are','be','with','this','that','please','can','you','i','we','my','our','it']);
// A short branch slug from a dispatch intent: first three non-stopword tokens.
export function wtSlug(intent) {
  const words = (String(intent || '').toLowerCase().match(/[a-z0-9]+/g) || [])
    .filter((w) => !WT_STOPWORDS.has(w)).slice(0, 3);
  return words.join('-').slice(0, 30).replace(/^-+|-+$/g, '');
}

export function truncate(s, n) {
  return s && s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s;
}

// HTML-escape for interpolation into innerHTML strings.
export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Abbreviate the user's home dir to ~ so a full path stays readable.
export function tildify(p) {
  return p ? p.replace(/^\/(?:Users|home)\/[^/]+/, '~') : '';
}

export function timeAgo(ms) {
  if (!ms) return null;
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// Inline --throb-delay that phases an animated card to the wall clock, so an
// element recreated by a re-render (the grid rebuilds every ~4s) resumes
// mid-cycle rather than snapping back to the keyframe start — the visible
// "reset/jump". Covers every 1.1s animation: the working/just-finished bar-throb
// AND the needs-you/just-finished/snooze-alarm ring flashes (all share the 1100ms
// period, so one delay phases them in lockstep). `stateClass` is the card's full
// class string, which may carry modifiers (`needs-you focused`, `… snooze-alarm`),
// so match tokens rather than the whole string. 1100 = one cycle. Inherits to ::before.
const THROB_STATES = /\b(?:working|needs-you|just-finished|snooze-alarm)\b/;
export function throbDelayStyle(stateClass) {
  return THROB_STATES.test(stateClass) ? ` style="--throb-delay:-${Date.now() % 1100}ms"` : '';
}

export function pad2(n) { return String(n).padStart(2, '0'); }

// Compact, two-unit duration: "1h 47m", "3h", "3d 2h", "22m", "<1m". Anything
// non-positive or missing (no createdAt) returns null so the caller omits it.
export function fmtDuration(ms) {
  if (!ms || ms <= 0) return null;
  const DAY = 86400e3;
  const HOUR = 3600e3;
  const d = Math.floor(ms / DAY);
  const h = Math.floor((ms % DAY) / HOUR);
  const m = Math.floor((ms % HOUR) / 60e3);
  if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  if (m > 0) return `${m}m`;
  return '<1m';
}

const WORKTREE_MARKER = '/.claude/worktrees/';
// Collapse a worktree path (<repo>/.claude/worktrees/<branch> or a wrangler
// `<repo>-worktree-<branch>` sibling) to its repo root; non-worktree paths pass
// through. Worktrees are ephemeral, so they fold into the owning repo for both
// location labels and folder suggestions. The real checked-out branch comes from
// s.branch (server-read), rendered via branchBadge — not inferred from the path.
export function repoRoot(cwd) {
  // Normalise away trailing slashes first, else `some/path` and `some/path/`
  // read as distinct (the dedup keys diverge, `.pop()` below returns ''), so the
  // folder suggester shows both. Keep the filesystem root `/` intact.
  cwd = cwd.replace(/\/+$/, '') || '/';
  if (cwd.includes(WORKTREE_MARKER)) return cwd.split(WORKTREE_MARKER)[0];
  const seg = cwd.split('/').pop();
  if (seg && seg.includes('-worktree-')) {
    const repo = seg.slice(0, seg.indexOf('-worktree-'));
    return `${cwd.slice(0, cwd.length - seg.length)}${repo}`;
  }
  return cwd;
}

export function locationLabel(cwd) {
  if (!cwd) return '';
  const base = repoRoot(cwd);
  const repo = base.split('/').filter(Boolean).slice(-1)[0] || base;
  return `📁 ${esc(repo)}`;
}

// Whether a session runs inside a git worktree (cwd is a wrangler-created
// `<repo>-worktree-<branch>` sibling or a `.claude/worktrees/` dir). Surfaced as
// the `⌥ wt` pill on the card meta line.
export function isWorktree(s) {
  const cwd = s.cwd || '';
  return cwd.includes('-worktree-') || cwd.includes('/.claude/worktrees/');
}

// A git-branch glyph + branch name, in purple. Shared by the detail header and
// the task-view cards so the branch reads identically in both.
// Most frequent cwd among a task's sessions (ties → most recently active).
// Scratch dirs (under sessionsDir) are excluded from the count; if scratch
// strictly outnumbers the single most common folder, '' is returned so a fresh
// scratch dir applies. Ties between scratch and the top folder go to the folder.
export function mostCommonCwd(sessions, sessionsDir) {
  const isScratch = (cwd) => !!sessionsDir && (cwd === sessionsDir || cwd.startsWith(`${sessionsDir}/`));
  let scratchCount = 0;
  const stats = new Map();
  for (const s of sessions) {
    if (!s.cwd) continue;
    if (isScratch(s.cwd)) { scratchCount++; continue; }
    const cwd = repoRoot(s.cwd);
    const cur = stats.get(cwd) || { count: 0, at: 0 };
    cur.count += 1;
    cur.at = Math.max(cur.at, s.lastActivity || 0);
    stats.set(cwd, cur);
  }
  let best = null;
  for (const [cwd, v] of stats)
    if (!best || v.count > best.count || (v.count === best.count && v.at > best.at)) best = { cwd, ...v };
  if (!best || scratchCount > best.count) return '';
  return best.cwd;
}

// Only http(s) links are clickable; anything else (javascript:, data:, …) is
// rendered as plain text so a hostile url can't execute on click.
export function safeHttpUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

export function branchBadge(branch) {
  if (!branch) return '';
  const main = branch === 'main' || branch === 'master' ? ' main' : '';
  return `<span class="branch${main}"><svg class="branch-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="6" x2="6" y1="3" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg><span class="branch-name">${esc(branch)}</span></span>`;
}
