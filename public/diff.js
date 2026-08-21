// Pure, DOM-free helpers for the session diff view. Kept out of diff-view.js so
// the addressing/draft-key/payload logic is unit-testable under `node --test`
// with no browser globals (same split as snooze.js / workflow.js). No imports —
// this is a leaf.

// localStorage key holding a session's in-progress review drafts, so a reload or
// a failed send can't lose them (cleared only on a confirmed ok:true send). Keyed
// on the session's card id — the same handle the panel and the ws messages use.
export function draftsStorageKey(sessionId) {
  return `aw:diff-drafts:${sessionId}`;
}

export function draftStorageKeysForSource(sessionId, mode = 'working-tree', prKey = null) {
  const source = mode === 'pr' && prKey ? `pr:${prKey}` : mode;
  return {
    primary: draftsStorageKey(`${sessionId}:${source}`),
    legacy: mode === 'working-tree' || mode === 'branch' ? draftsStorageKey(sessionId) : null,
  };
}

export function clearSubmittedDraftSource({ currentKey, submittedKey }) {
  const removeKey = submittedKey || currentKey;
  return { removeKey, clearCurrent: removeKey === currentKey };
}

export function diffPrLinks(session, task) {
  const out = [];
  const seen = new Set();
  for (const link of [...(session?.links || []), ...(task?.links || [])]) {
    if (link?.type !== 'pr' || !link.url) continue;
    const key = link.repo && link.number ? `${link.repo}#${link.number}` : link.url;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      url: link.url,
      repo: link.repo,
      number: link.number,
      label: link.number ? `PR #${link.number}` : 'PR',
    });
  }
  return out;
}

// A diff line's review "side" follows the GitHub convention: a deletion is
// addressed on the OLD file (its newLine is null), everything else (an addition
// or an unchanged context line) on the NEW file. One place so the renderer's
// data attributes and the submit payload can't disagree.
export function lineSide(type) {
  return type === 'del' ? 'old' : 'new';
}

// The line number that addresses a line on its own side: the old number for a
// deletion, the new number otherwise. Returns null when the relevant number is
// absent (shouldn't happen for a real content line, but keeps callers total).
export function lineNumberFor(line) {
  if (!line) return null;
  return lineSide(line.type) === 'old' ? line.oldLine : line.newLine;
}

// Stable identity for a draft / a comment box: file path + side + the inclusive
// line RANGE it addresses. A single-line comment is startLine === endLine, so the
// key is range-aware for every draft (`file|side|start|end`) and re-opening the
// same span edits the existing draft rather than stacking a duplicate. The extra
// endLine segment is what distinguishes this from the old single-line `file|side|line`
// shape — see normalizeDraft for how a legacy draft migrates onto it.
export function draftKey(file, side, startLine, endLine) {
  return `${file}|${side}|${startLine}|${endLine}`;
}

// A line's presence key (`file|side|line`) — one per rendered content line, the unit
// diffLineKeys collects and draftAttached tests a draft's every range line against.
// Deliberately NOT draftKey: presence is per-line, addressing is per-range.
function presenceKey(file, side, line) {
  return `${file}|${side}|${line}`;
}

// Canonicalise any stored/incoming draft to the range shape `{ file, side, startLine,
// endLine, snapshot, body }`. **Backward compat lives here:** a legacy draft persisted
// under the old single-line shape has a `line` field and no start/end, so it's read as
// startLine === endLine === line — old localStorage drafts survive a load unchanged in
// meaning. Returns null for a non-object so callers can skip junk.
export function normalizeDraft(d) {
  if (!d || typeof d !== 'object') return null;
  const startLine = d.startLine ?? d.line;
  const endLine = d.endLine ?? d.line;
  return { file: d.file, side: d.side, startLine, endLine, snapshot: d.snapshot ?? '', body: d.body ?? '' };
}

// Normalise a click-and-drag selection into an inclusive line range on ONE side of
// ONE file. `anchor` is where the drag started, `current` where it's now (both
// `{file, side, line}`). A drag that has wandered onto a different file/side is not a
// valid range — return null so the caller keeps the last in-range position instead of
// spanning across sides. Otherwise the range is order-agnostic (drag up or down), so
// startLine ≤ endLine always; a single-line drag yields startLine === endLine, i.e. a
// single-line comment. One place so the drag handler and its test agree.
export function dragRange(anchor, current) {
  if (!anchor || !current) return null;
  if (anchor.file !== current.file || anchor.side !== current.side) return null;
  return {
    file: anchor.file,
    side: anchor.side,
    startLine: Math.min(anchor.line, current.line),
    endLine: Math.max(anchor.line, current.line),
  };
}

// Human label for a draft/editor's span: "Line 12" for a single line, "Lines 12–18"
// (en dash) for a range. One place so the draft block, editor and any test agree.
export function rangeLabel(startLine, endLine) {
  return startLine === endLine ? `Line ${startLine}` : `Lines ${startLine}–${endLine}`;
}

// Lines of surrounding code included above/below a comment's own span, so the
// agent doesn't have to re-open the file just to see what a one-line note is
// about.
export const SNAPSHOT_CONTEXT_LINES = 3;

// The snapshot text for a comment span: the target span (marked `>`) plus up to
// SNAPSHOT_CONTEXT_LINES lines of surrounding context on EACH side (unmarked),
// captured from the currently-rendered diff so the note stays meaningful even if
// the code later changes. Context is taken by POSITION in the hunk's own line
// order (not re-filtered by `side`) — a deletion's neighbours are typically
// unchanged `context` lines, which only carry a side of 'new' (see lineSide), so
// re-applying the side filter to them would skip exactly the lines a human
// expects to see right above/below the span. Each row is numbered with its OWN
// natural line number (old for a deletion, new otherwise) so it reads the same
// as the panel's own gutters. A single line yields just that one marked row (no
// context) when the hunk has none to give.
export function rangeSnapshot(diff, file, side, startLine, endLine) {
  if (!diff || diff.state !== 'ok') return '';
  for (const f of diff.files || []) {
    if (f.binary || f.path !== file) continue;
    for (const h of f.hunks || []) {
      const lines = h.lines || [];
      let first = -1;
      let last = -1;
      for (let i = 0; i < lines.length; i += 1) {
        if (lineSide(lines[i].type) !== side) continue;
        const num = lineNumberFor(lines[i]);
        if (num == null || num < startLine || num > endLine) continue;
        if (first === -1) first = i;
        last = i;
      }
      if (first === -1) continue; // span not in this hunk — try the next one
      const from = Math.max(0, first - SNAPSHOT_CONTEXT_LINES);
      const to = Math.min(lines.length - 1, last + SNAPSHOT_CONTEXT_LINES);
      const rows = [];
      for (let i = from; i <= to; i += 1) {
        const ln = lines[i];
        const num = lineNumberFor(ln);
        // Marked iff THIS row itself is on the target side and in range — an
        // interleaved row of the other side (e.g. a deletion between two
        // commented additions) is only ever context, matching how the panel's
        // own .selected/.drag-selecting highlight is side-scoped (highlightRange).
        const marker = lineSide(ln.type) === side && num != null && num >= startLine && num <= endLine ? '>' : ' ';
        rows.push(`${marker} ${num ?? '?'}: ${ln.text ?? ''}`);
      }
      return rows.join('\n');
    }
  }
  return '';
}

// Find the draft (if any) ANCHORED at a given line on a side — i.e. whose endLine is
// this line. A draft renders under the LAST line of its range, so lineEl asks this per
// row to decide where the draft block hangs; a single-line draft anchors on its own
// line (start === end). Returns { key, draft } or null. Scans the (small) drafts map
// rather than a key lookup because a range key can't be reconstructed from one line.
export function draftAnchoredAt(drafts, file, side, line) {
  for (const [key, d] of Object.entries(drafts || {})) {
    if (!d) continue;
    const end = d.endLine ?? d.line;
    if (d.file === file && d.side === side && end === line) return { key, draft: d };
  }
  return null;
}

// Compile the in-memory drafts map into the wire payload the server expects
// (`{ file, side, startLine, endLine, snapshot, body }[]`). Drops any draft whose body
// is blank (a Save of an empty box is a delete, but this is belt-and-braces) so an
// empty comment can never reach the agent. Tolerates a legacy `line`-only draft.
// Insertion order is preserved.
export function buildCommentsPayload(drafts) {
  const out = [];
  for (const d of Object.values(drafts || {})) {
    const body = String(d?.body ?? '').trim();
    if (!body) continue;
    const startLine = d.startLine ?? d.line;
    const endLine = d.endLine ?? d.line;
    out.push({ file: d.file, side: d.side, startLine, endLine, snapshot: d.snapshot ?? '', body });
  }
  return out;
}

// Count of live drafts (non-blank bodies) — drives the "Send to agent (N)" label
// and its enabled/hidden state.
export function draftCount(drafts) {
  return buildCommentsPayload(drafts).length;
}

// Keydown predicate for the inline comment editor: Cmd+Enter (mac) or Ctrl+Enter
// (elsewhere) SAVES the draft. Plain Enter is deliberately excluded so it inserts
// a newline in the multi-line textarea instead of submitting; Shift/Alt+Enter also
// don't save (they're newline/no-ops). One place so the handler and its test agree.
export function isSaveCommentKey(e) {
  return Boolean(e && e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey);
}

// Parse a localStorage drafts blob back into a plain object, tolerating a missing
// or corrupt value (returns {} rather than throwing, so a stray write can never
// wedge the panel). Only accepts a plain object of draft records. Each record is
// normalised onto the range shape and RE-KEYED under its range draftKey, so a
// legacy single-line draft (old `file|side|line` key, `line` field) loads as a
// startLine===endLine range under the new `file|side|start|end` key — otherwise a
// subsequent Save would compute the new key and orphan the old entry as a duplicate.
// A record we can't key (missing file/side/line) is kept verbatim rather than dropped.
export function parseDrafts(raw) {
  if (!raw) return {};
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return {}; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const out = {};
  for (const [k, d] of Object.entries(parsed)) {
    const norm = normalizeDraft(d);
    if (norm && norm.file != null && norm.side != null && norm.startLine != null && norm.endLine != null) {
      out[draftKey(norm.file, norm.side, norm.startLine, norm.endLine)] = norm;
    } else {
      out[k] = d;
    }
  }
  return out;
}

// The set of per-line PRESENCE keys (file|side|line) for every content line present
// in a `diff` reply. Lets the panel tell which drafts still have their span present
// (rendered inline) from those the agent has since edited/removed (orphaned → surfaced
// separately). A non-ok/empty diff has no lines, so every draft is orphaned.
export function diffLineKeys(diff) {
  const keys = new Set();
  if (!diff || diff.state !== 'ok') return keys;
  for (const f of diff.files || []) {
    if (f.binary) continue;
    for (const h of f.hunks || []) {
      for (const ln of h.lines || []) {
        const num = lineNumberFor(ln);
        if (num == null) continue;
        keys.add(presenceKey(f.path, lineSide(ln.type), num));
      }
    }
  }
  return keys;
}

// A draft is "attached" iff both ENDPOINTS of its span are present on its side in the
// current diff — the start (where the highlight begins) and the end (where the draft
// block anchors). If either endpoint is gone (an agent edit shrank/moved the code), the
// range would render wrongly/nowhere, so it's detached: surfaced separately but still
// counted and sent. Endpoints only, NOT every integer line, because a span's interior
// legitimately skips numbers — an old-side range crosses context lines (indexed on the
// new side), and any range can straddle a hunk boundary (a gap in line numbers). A
// draft with no addressable span (junk / missing fields) is treated as detached.
function draftAttached(d, presentKeys) {
  if (!presentKeys || !d) return false;
  const start = d.startLine ?? d.line;
  const end = d.endLine ?? d.line;
  if (d.file == null || d.side == null || start == null || end == null) return false;
  return presentKeys.has(presenceKey(d.file, d.side, start))
    && presentKeys.has(presenceKey(d.file, d.side, end));
}

// Split drafts into `attached` (their whole span is present in the current diff, so
// they render inline) and `detached` (orphaned by an agent edit). Detached drafts are
// invisible in the inline render yet still counted and sent, so the panel surfaces them
// in a dedicated section. Insertion order kept.
export function partitionDrafts(drafts, presentKeys) {
  const attached = {};
  const detached = {};
  for (const [k, d] of Object.entries(drafts || {})) {
    if (draftAttached(d, presentKeys)) attached[k] = d;
    else detached[k] = d;
  }
  return { attached, detached };
}

// The set of presence keys for a draft's whole span — the lines lineEl highlights with
// `.selected` while the draft (or an in-progress selection) is active. One place so the
// renderer's highlight and the attachment test address lines identically.
export function draftSpanKeys(d) {
  const keys = new Set();
  if (!d) return keys;
  const start = d.startLine ?? d.line;
  const end = d.endLine ?? d.line;
  if (d.file == null || d.side == null || start == null || end == null) return keys;
  for (let n = start; n <= end; n += 1) keys.add(presenceKey(d.file, d.side, n));
  return keys;
}

// True when a `diff` reply must be DROPPED as stale: it carries an older monotonic
// request id than the newest one we've sent, i.e. a slow older server pipeline
// landing after a newer poll — applying it would flash the diff backwards. A reply
// with no id (legacy server, or a request that predated the id) is never stale.
export function isStaleReply(replyReqId, latestReqId) {
  if (typeof replyReqId !== 'number' || typeof latestReqId !== 'number') return false;
  return replyReqId < latestReqId;
}

// True when an incoming diff re-render must be DEFERRED because a comment editor is
// open: replaceChildren would destroy the editor DOM (losing the user's typed text)
// and — since activeKey would stay set against a now-gone box — wedge polling. The
// stashed diff is applied when the editor closes.
export function shouldDeferDiffRender(activeKey, editorInDom) {
  return activeKey != null || Boolean(editorInDom);
}
