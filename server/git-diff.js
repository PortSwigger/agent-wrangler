import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

// The git empty-tree object id. `git diff <empty-tree>` compares the working tree
// against nothing, so a brand-new repo with no commit yet shows its tracked
// content as pure additions instead of erroring on a missing HEAD.
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

const DEFAULT_LINE_CAP = 2000;

// Diffs of a large working tree can dwarf execFile's default 1 MB stdout cap; a
// truncated buffer would corrupt the parse silently, so give it real headroom
// (the soft line cap is what actually bounds what we return to the client).
// The timeout is a hard ceiling on a single git call: a pathological repo, a slow
// FS, or a hung pre-diff hook must never hang a view-diff/diff-comments request
// indefinitely — on timeout execFile rejects (code null, not 1), so it surfaces as
// the view-diff error empty-state rather than a stuck socket. worktree.js sets no
// timeout convention, so 15 s is a deliberate default (comfortably above any real
// diff, well under a user's patience). Note the code-1-is-success --no-index path
// (noIndexDiff) is unaffected: a timeout is a distinct rejection, not exit code 1.
// GIT_OPTIONAL_LOCKS=0 keeps this genuinely READ-ONLY: by default `git status`/
// `git diff` against a working tree refresh and REWRITE .git/index (the stat cache)
// under index.lock — on the 3 s poll that lock collides with the live agent's own
// git ("Unable to create '.git/index.lock'"). Setting it here covers EVERY git call
// uniformly (all of them use EXEC_OPTS), so none of them takes optional locks.
export const EXEC_OPTS = {
  maxBuffer: 64 * 1024 * 1024,
  timeout: 15000,
  env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
};

// A single generated/minified changed line can be multi-MB; the cap counts LINES,
// not bytes, so without this one line would ship whole to the client and land in a
// single DOM node (browser freeze). Truncate any stored line past this, appending a
// visible marker — the safe-DOM renderer shows the marker as plain text, so no
// client change is needed.
const MAX_LINE_LEN = 2000;
const LINE_TRUNC_MARKER = '… (line truncated)';

function stripAbPrefix(p) {
  return (p.startsWith('a/') || p.startsWith('b/')) ? p.slice(2) : p;
}

// Pure unified-diff parser. Takes the raw output of a single `git diff` (any
// number of file sections) and returns the structured file/hunk/line form the
// view-diff contract needs, with per-line old/new line numbers computed from the
// hunk headers. No git, no fs — unit-testable in isolation. Status is derived
// from the section's metadata lines (new file / deleted file / rename); callers
// that KNOW the status (untracked, via --no-index) overwrite it afterwards.
// `budget` (optional) is a shared, mutable line budget threaded through every
// parseDiff call in one workingTreeDiff pass: `{ cap, kept, droppedLines }`. It
// bounds allocation AT PARSE TIME — once `cap` content lines are kept we stop
// constructing line objects entirely (a huge tracked change no longer builds
// thousands of objects only for applyLineCap to discard them), tallying the rest
// as droppedLines. Same accounting applyLineCap produced before, just charged
// earlier. Absent budget ⇒ parse everything (the pure, cap-free contract callers
// and tests rely on).
export function parseDiff(text, budget = null) {
  const files = [];
  if (!text) return files;
  let cur = null;
  let hunk = null;
  let oldLine = 0;
  let newLine = 0;
  const flush = () => { if (cur) files.push(cur); };
  // Push one content line, applying the per-line length cap and the shared budget.
  const addLine = (obj) => {
    if (obj.text.length > MAX_LINE_LEN) obj.text = obj.text.slice(0, MAX_LINE_LEN) + LINE_TRUNC_MARKER;
    if (budget) {
      if (budget.kept >= budget.cap) { budget.droppedLines += 1; return; }
      budget.kept += 1;
    }
    hunk.lines.push(obj);
  };

  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      flush();
      cur = { path: null, oldPath: undefined, status: 'modified', binary: false, hunks: [] };
      hunk = null;
      // Fallback path source: the `Binary files … differ` case emits no ---/+++
      // lines, so the a/…/b/… pair on this header is all we have to name it.
      const m = line.match(/^diff --git a\/(.*) b\/(.*)$/);
      if (m) cur.path = m[2];
      continue;
    }
    if (!cur) continue;
    if (line.startsWith('new file mode')) { cur.status = 'added'; continue; }
    if (line.startsWith('deleted file mode')) { cur.status = 'deleted'; continue; }
    if (line.startsWith('rename from ')) { cur.oldPath = line.slice(12); cur.status = 'renamed'; continue; }
    if (line.startsWith('rename to ')) { cur.path = line.slice(10); cur.status = 'renamed'; continue; }
    if (line.startsWith('Binary files ')) { cur.binary = true; continue; }
    if (line.startsWith('--- ')) {
      const p = line.slice(4);
      // The old side names a deleted file (its new side is /dev/null); for every
      // other status the +++ line below is the authoritative path.
      if (p !== '/dev/null' && cur.status === 'deleted') cur.path = stripAbPrefix(p);
      continue;
    }
    if (line.startsWith('+++ ')) {
      const p = line.slice(4);
      if (p !== '/dev/null') cur.path = stripAbPrefix(p);
      continue;
    }
    if (line.startsWith('@@')) {
      const m = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
      if (m) {
        oldLine = parseInt(m[1], 10);
        newLine = parseInt(m[2], 10);
        hunk = { header: line, oldStart: oldLine, newStart: newLine, lines: [] };
        cur.hunks.push(hunk);
      }
      continue;
    }
    if (!hunk) continue;
    if (line.startsWith('\\')) continue; // "\ No newline at end of file" — metadata, not content
    const kind = line[0];
    if (kind === '+') { addLine({ type: 'add', text: line.slice(1), oldLine: null, newLine }); newLine += 1; }
    else if (kind === '-') { addLine({ type: 'del', text: line.slice(1), oldLine, newLine: null }); oldLine += 1; }
    else if (kind === ' ') { addLine({ type: 'context', text: line.slice(1), oldLine, newLine }); oldLine += 1; newLine += 1; }
    // Anything else (a blank trailing split element) is not part of the hunk body.
  }
  flush();
  for (const f of files) if (f.oldPath === undefined) delete f.oldPath;
  return files;
}

// Enforce the soft cap across the WHOLE result: walk files/hunks/lines in order,
// keep the first `cap` content lines, drop the rest, and tally how many were
// dropped. Binary files carry no content lines, so they always survive (they're
// pure metadata). A hunk left with zero kept lines is dropped whole rather than
// emitted empty; a file whose hunks were all dropped is dropped too — never a
// half-built structure the client can't render.
// Count the content (hunk) lines across a set of parsed files — the same unit the
// soft cap bounds. Binary files carry no hunk lines, so they contribute 0. Used to
// charge the budget as untracked files are walked (see workingTreeDiff).
function countContentLines(files) {
  let n = 0;
  for (const f of files) for (const h of f.hunks) n += h.lines.length;
  return n;
}

function applyLineCap(files, cap) {
  let kept = 0;
  let dropped = 0;
  const out = [];
  for (const f of files) {
    if (f.binary || f.hunks.length === 0) { out.push(f); continue; }
    const hunks = [];
    for (const h of f.hunks) {
      const lines = [];
      for (const ln of h.lines) {
        if (kept < cap) { lines.push(ln); kept += 1; } else dropped += 1;
      }
      if (lines.length > 0) hunks.push({ ...h, lines });
    }
    if (hunks.length > 0) out.push({ ...f, hunks });
  }
  return { files: out, droppedLines: dropped };
}

async function hasHead(cwd) {
  try { await exec('git', ['-C', cwd, 'rev-parse', '--verify', 'HEAD'], EXEC_OPTS); return true; }
  catch { return false; }
}

// `git diff --no-index` is fully read-only — it never touches the index or the
// working tree — which is why it's safe against a directory a live agent owns.
// It intentionally exits 1 when the two inputs differ (our normal case), so treat
// code 1 as SUCCESS and read its stdout; only a code > 1 is a real failure.
// --no-ext-diff/--no-textconv keep a repo-configured external diff/textconv driver
// from EXECUTING during this read-only diff (defense in depth).
async function noIndexDiff(cwd, filePath) {
  try {
    const { stdout } = await exec('git', ['-C', cwd, 'diff', '--no-ext-diff', '--no-textconv', '--no-index', '--', '/dev/null', filePath], EXEC_OPTS);
    return stdout;
  } catch (e) {
    if (e.code === 1) return e.stdout || '';
    throw e;
  }
}

async function listUntracked(cwd) {
  // `-z` gives NUL-separated, VERBATIM paths — git does NOT C-quote under `-z`, so
  // a name with a space, backslash, tab or unicode arrives byte-for-byte. That's
  // both what we display and the raw path we hand to `git diff --no-index` below,
  // so no manual unescaping is needed (manual unquoting is error-prone: unescaping
  // `\\`→`\` and then `\t`→TAB in separate passes double-decodes `a\tb`).
  const { stdout } = await exec('git', ['-C', cwd, 'status', '--porcelain', '-z', '--untracked-files=all'], EXEC_OPTS);
  const out = [];
  // Trailing NUL yields an empty final element; it won't match the `?? ` prefix.
  for (const entry of stdout.split('\0')) {
    if (entry.startsWith('?? ')) out.push(entry.slice(3));
  }
  return out;
}

// Structured, STRICTLY READ-ONLY working-tree diff for `cwd`. Never runs anything
// that mutates git's index or working tree (no `git add`, no `add -N`) — the tree
// may be in active use by a live agent. Combines tracked staged+unstaged changes
// (vs HEAD, or the empty tree on a repo with no commit yet) with a per-file
// --no-index diff of each untracked file. See the module for the return contract.
// Resolve the env override for the line cap. `Number(x) || DEFAULT` was wrong: it
// treats an explicit `0` (a deliberate "no lines") as falsy and falls back to the
// default. Honor any non-negative integer (including 0); fall back only when the
// var is unset/blank or not a valid non-negative integer.
function envLineCap() {
  const raw = process.env.AW_DIFF_LINE_CAP;
  if (raw == null || raw === '') return DEFAULT_LINE_CAP;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_LINE_CAP;
}

// Shared body of workingTreeDiff/branchDiff: diff `base` (a commit-ish) against the
// working tree, fan out untracked files, and enforce the line-cap budget. `base`
// already encodes which comparison point the caller wants (HEAD, the empty tree, or
// a merge-base) — this function doesn't know or care which.
async function diffAgainstBase(cwd, base, cap) {
  // Shared parse budget: caps line-object construction across BOTH the tracked diff
  // and every untracked --no-index diff, so nothing over the cap is ever built.
  const budget = { cap, kept: 0, droppedLines: 0 };

  // Tracked diff first, so its line count is charged against the budget BEFORE we
  // decide how many untracked files are worth spawning a process for.
  const { stdout } = await exec('git', ['-C', cwd, 'diff', '--no-ext-diff', '--no-textconv', base], EXEC_OPTS);
  const files = parseDiff(stdout, budget);

  // Cap the untracked-file fan-out by the SAME line budget we'll render, not just
  // the final output: a cwd with a large un-gitignored dir (build output, a stray
  // node_modules) would otherwise spawn one `git diff --no-index` per file —
  // hundreds/thousands of processes — even though only ~cap lines are ever shown.
  // Once the accumulated diff already fills the budget, stop spawning and count the
  // untracked files we deliberately skipped. Those files' lines are NOT read (the
  // whole point), so droppedLines can't include them — droppedFiles carries "plus N
  // more files not shown" instead. Still strictly read-only: no `git add`/`add -N`.
  let usedLines = countContentLines(files);
  const untracked = await listUntracked(cwd);
  let droppedFiles = 0;
  for (let i = 0; i < untracked.length; i += 1) {
    if (usedLines >= cap) { droppedFiles = untracked.length - i; break; }
    const p = untracked[i];
    const parsed = parseDiff(await noIndexDiff(cwd, p), budget);
    const f = parsed[0] || { path: p, status: 'untracked', binary: false, hunks: [] };
    f.status = 'untracked';
    f.path = p;
    delete f.oldPath;
    files.push(f);
    usedLines += countContentLines([f]);
  }

  if (files.length === 0) return { state: 'empty' };

  // applyLineCap now only PRUNES empty hunks/files the budget hollowed out (the
  // budget already stopped construction at the cap, so it drops nothing more); the
  // real dropped-line count is the budget's. Summing keeps it correct even if some
  // path ever parses without the budget.
  const { files: capped, droppedLines } = applyLineCap(files, cap);
  return { state: 'ok', files: capped, truncated: { droppedLines: budget.droppedLines + droppedLines, droppedFiles } };
}

export async function workingTreeDiff(cwd, { lineCap } = {}) {
  const cap = Number.isFinite(lineCap) ? lineCap : envLineCap();
  try {
    await exec('git', ['-C', cwd, 'rev-parse', '--is-inside-work-tree'], EXEC_OPTS);
  } catch {
    return { state: 'not-a-repo' };
  }
  const base = (await hasHead(cwd)) ? 'HEAD' : EMPTY_TREE;
  return diffAgainstBase(cwd, base, cap);
}

// Best-effort ref to compare a branch against for `branchDiff`, in priority order:
// 1. the branch's configured upstream (`@{upstream}`) — the normal case once pushed;
// 2. `origin/<branch-name>` directly, in case an upstream link is missing but the
//    remote branch exists under the same name;
// 3. origin's default branch, however it's discoverable. `refs/remotes/origin/HEAD`
//    only exists after a `git clone` (or an explicit `git remote set-head`) — a repo
//    set up via init+remote-add+fetch (every wrangler worktree: freshly cut off main
//    and NOT pushed until PR creation, so this is the common path, not a corner case)
//    never gets it. Probing `origin/main`/`origin/master` directly covers that.
// Returns null when nothing resolves (no remote at all, or a default branch under
// neither common name) — the caller reports that as `state: 'no-remote'`.
async function resolveBranchBase(cwd) {
  try {
    const { stdout } = await exec('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], EXEC_OPTS);
    const ref = stdout.trim();
    if (ref) return ref;
  } catch { /* no upstream configured */ }

  try {
    const { stdout } = await exec('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'], EXEC_OPTS);
    const branch = stdout.trim();
    if (branch && branch !== 'HEAD') {
      const ref = `origin/${branch}`;
      await exec('git', ['-C', cwd, 'rev-parse', '--verify', '--quiet', ref], EXEC_OPTS);
      return ref;
    }
  } catch { /* detached HEAD, or origin/<branch> doesn't exist */ }

  try {
    const { stdout } = await exec('git', ['-C', cwd, 'symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], EXEC_OPTS);
    const ref = stdout.trim();
    if (ref) return ref;
  } catch { /* origin/HEAD not set (init+remote-add+fetch never sets it) */ }

  for (const ref of ['origin/main', 'origin/master']) {
    try {
      await exec('git', ['-C', cwd, 'rev-parse', '--verify', '--quiet', ref], EXEC_OPTS);
      return ref;
    } catch { /* try the next candidate */ }
  }
  return null;
}

// The "full branch" diff: everything different from the branch's remote lineage —
// committed local commits AND uncommitted working-tree changes in one comparison.
// Note this is "vs origin/branch" (or its fallback), NOT necessarily the same
// comparison a PR's Files-changed tab shows: once pushed, resolveBranchBase prefers
// the branch's own upstream over the repo's default branch, so a pushed branch's
// "full branch" diff is unpushed commits + uncommitted only (by design — "what have
// I done that isn't on my remote yet" is the point once there IS a remote copy to
// diff against; the pre-push fallback to the default branch is what gives the
// full-since-fork-point view). The resolved ref is always returned as `baseRef` so
// the UI can show what it's actually comparing against. Diffs against the
// MERGE-BASE of HEAD and the resolved ref (not the ref's tip directly): if the
// remote side has since gained commits this branch doesn't have, diffing straight
// against its tip would show those as reverted here, which is backwards —
// merge-base isolates just this branch's own additions since it diverged.
export async function branchDiff(cwd, { lineCap } = {}) {
  const cap = Number.isFinite(lineCap) ? lineCap : envLineCap();
  try {
    await exec('git', ['-C', cwd, 'rev-parse', '--is-inside-work-tree'], EXEC_OPTS);
  } catch {
    return { state: 'not-a-repo' };
  }
  // Distinct reasons for the client: no commit yet (nothing to merge-base against,
  // regardless of whether a remote is configured) vs no resolvable ref (there IS a
  // repo with commits, it's just not pushed anywhere yet) — a repo can have a remote
  // configured but zero commits, where "push this branch first" would be misleading.
  if (!(await hasHead(cwd))) return { state: 'no-remote', reason: 'no-head' };

  const remoteRef = await resolveBranchBase(cwd);
  if (!remoteRef) return { state: 'no-remote', reason: 'no-ref' };

  let base;
  try {
    const { stdout } = await exec('git', ['-C', cwd, 'merge-base', 'HEAD', remoteRef], EXEC_OPTS);
    base = stdout.trim();
  } catch {
    return { state: 'no-remote', reason: 'no-ref' }; // e.g. unrelated histories — nothing sensible to diff against
  }
  if (!base) return { state: 'no-remote', reason: 'no-ref' };

  const result = await diffAgainstBase(cwd, base, cap);
  return { ...result, baseRef: remoteRef };
}
