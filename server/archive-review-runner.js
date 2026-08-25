import os from 'node:os';
import crypto from 'node:crypto';
import { execFile as defaultExecFile } from 'node:child_process';
import { findTranscript, readLines, textOf, usageSince } from './transcript-reader.js';
import { cleanClaudeEnv } from './agents/claude.js';
import { archiveReviewEnabled } from './config-store.js';

// Best-effort, background enrichment of a task's memory.md, triggered from
// SessionManager.archive() via the `_archiveReview` seam. When a Claude session
// is archived, a headless `claude -p --model haiku` process reads that
// session's own HUMAN turns only (see buildExcerpt) and appends a short
// "durable learnings" note to its task's memory file — pitfalls, explicit user
// preferences/corrections, decisions and why, cross-cutting constraints. Off
// by default (archiveReviewEnabled); the session's own agent already gets
// asked to write memory as it goes (see the task-memory skill) — this only
// catches what it forgot, and does so out-of-band so archive itself never
// waits on it.
//
// Deliberately human-turns-only, not the full transcript. The durable signal
// this is meant to capture — stated constraints/preferences, corrections,
// decisions, dead ends — lives almost entirely in what the user actually
// typed; assistant/tool content is the overwhelming majority of transcript
// bytes and carries almost none of that signal, so including it just spends
// tokens diluting the extraction with narrative the model then has to filter
// back out. A user's own correction ("no, that's wrong — do X instead")
// already carries the pitfall it's correcting; nothing is lost by dropping
// the assistant's preceding (wrong) claim.
//
// Deliberately excludes consolidating against EXISTING memory.md content —
// Haiku only ever sees the excerpt, never the file it's appending to. Keeping
// the prompt to just the session's own input is what keeps a review both
// cheap and reliably on-topic; deduping/consolidating accumulated notes is a
// separate job, not this one's.

const MAX_CONCURRENT = 2;
let inFlight = 0;
const queue = [];

function runQueued(fn) {
  return new Promise((resolve) => {
    queue.push({ fn, resolve });
    pump();
  });
}

function pump() {
  while (inFlight < MAX_CONCURRENT && queue.length) {
    const { fn, resolve } = queue.shift();
    inFlight += 1;
    fn().then(resolve).finally(() => {
      inFlight -= 1;
      pump();
    });
  }
}

const USER_TURN_CAP = 3000;
const EXCERPT_CAP = 40000;

// `<command-*>`/`<system-reminder>`/`<local-command-*>` wrapper blocks are
// harness-injected noise, never something the user actually said — dropping
// them keeps the excerpt to real conversation.
const WRAPPER_RE = /^<(command-|local-command|system-reminder)/;

function truncate(text, cap) {
  return text.length > cap ? `${text.slice(0, cap)} …[truncated]` : text;
}

// Build a plain-text excerpt of the session's HUMAN turns only (no assistant
// text, no tool calls) bounded by `sinceMs` (epoch ms — see
// usageSince/archiveReviewedAt at the call site), capped in total size so a
// very active session can't blow Haiku's context or run up cost. Returns ''
// if nothing qualifies (an empty/aborted session, one entirely predating the
// bound, or one that's all tool/assistant activity with no real user turns).
export function buildExcerpt(entries, sinceMs = 0) {
  const turns = [];
  for (const e of entries) {
    if (e.isMeta) continue;
    if (e.type !== 'user') continue;
    const m = e.message;
    if (!m) continue;
    if (sinceMs) {
      const t = typeof e.timestamp === 'string' ? Date.parse(e.timestamp) : NaN;
      if (Number.isFinite(t) && t < sinceMs) continue;
    }
    let text = textOf(m.content);
    if (!text) continue;
    if (WRAPPER_RE.test(text)) continue;
    text = truncate(text, USER_TURN_CAP);
    turns.push(text);
  }
  let body = turns.join('\n\n---\n\n');
  if (body.length > EXCERPT_CAP) {
    const head = Math.floor(EXCERPT_CAP * 0.45);
    const tail = EXCERPT_CAP - head;
    body = `${body.slice(0, head)}\n\n…[MIDDLE OF SESSION ELIDED]…\n\n${body.slice(-tail)}`;
  }
  return body;
}

const EXTRACTION_PROMPT = `The text on stdin is a series of one user's own messages from a coding session that has just ended, separated by "---". You are NOT shown the assistant's replies or any tool output — only what the user actually typed. Extract ONLY durable knowledge a DIFFERENT agent picking up this same task later would need and could not rediscover cheaply.

Write at most 5 markdown bullets. Each bullet must be a specific, checkable fact — name the file, function, PR, ticket, command, or error where the user's own words gave you one. Prefer, in order:
1. Explicit instructions, corrections or preferences the user stated ("do it this way", "never do X", "I prefer Y", "no, that's wrong — do Z instead").
2. Something the user said that reveals a pitfall or a wrong assumption they had to correct.
3. A decision the user made and the reason they gave, where the reason isn't obvious from the code.
4. Cross-cutting constraints the user stated (a blocking dependency, an external system that must be in a certain state).

HARD RULES:
- Do NOT recap what was asked for or what happened. No narrative. If a bullet would read like a status report, drop it.
- Do NOT restate anything already obvious from reading the code or the git history.
- Omit anything specific to one repo that belongs in that repo's own CLAUDE.md rather than shared task notes.
- Most sessions teach nothing durable. If there is nothing durable worth recording, output exactly: NONE — this is the expected, common outcome, not a failure.
- Output the bullets only. No preamble, no heading, no closing summary.`;

const DISALLOWED_TOOLS = [
  'Bash', 'Read', 'Write', 'Edit', 'NotebookEdit', 'Glob', 'Grep', 'WebFetch',
  'WebSearch', 'Task', 'Agent', 'TodoWrite', 'BashOutput', 'KillShell', 'Skill',
  'SlashCommand',
];

// Spawn the headless Haiku reviewer. Returns { text, liveSessionId, error }.
// `liveSessionId` (a fresh uuid, never `--no-session-persistence`) is what lets
// this review's spend land in `entry.priorLiveSessionIds` — the existing cost
// scanners (usage-report.js, cost-report.mjs) already walk that field, so the
// spend is visible for free, and the transcript survives for debugging what
// Haiku actually saw. `execFile` (not shell) with the excerpt on stdin, so
// there's no argv length limit and no shell-quoting surface.
export async function reviewExcerpt(excerpt, {
  execFile = defaultExecFile,
  timeoutMs = 120000,
} = {}) {
  const liveSessionId = crypto.randomUUID();
  const args = [
    '-p', '--model', 'haiku',
    '--strict-mcp-config',
    '--setting-sources', '',
    '--disallowed-tools', DISALLOWED_TOOLS.join(' '),
    '--session-id', liveSessionId,
    '--output-format', 'json',
    EXTRACTION_PROMPT,
  ];
  return new Promise((resolve) => {
    const child = execFile('claude', args, {
      cwd: os.tmpdir(),
      env: cleanClaudeEnv(),
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
    }, (err, stdout) => {
      if (err) { resolve({ text: null, liveSessionId, error: err }); return; }
      let parsed;
      try { parsed = JSON.parse(stdout); } catch (e) { resolve({ text: null, liveSessionId, error: e }); return; }
      resolve({ text: typeof parsed.result === 'string' ? parsed.result.trim() : null, liveSessionId, error: null });
    });
    child.stdin.end(excerpt);
  });
}

function sectionFor(text, label) {
  const date = new Date().toISOString().slice(0, 10);
  const heading = label ? `## Session review — ${date} (${label})` : `## Session review — ${date}`;
  return `\n${heading}\n\n${text}\n`;
}

// The one entry point, called unawaited from SessionManager.archive(). All
// effects (subprocess, filesystem) are injected via `deps` so this is unit
// testable without spawning anything real. Returns a mode string:
//   'skipped' — a guard declined (feature off, non-Claude, no task, no
//               transcript, or the bounded excerpt had nothing in it)
//   'none'    — Haiku ran and found nothing durable (its own NONE guard)
//   'written' — a section was appended to the task's memory.md
//   'error'   — the subprocess failed or returned unparseable output
export async function runArchiveReview(sessionId, entry, task, deps = {}) {
  const {
    memoryStore,
    findTranscriptFn = findTranscript,
    readLinesFn = readLines,
    review = reviewExcerpt,
    // Called once the subprocess has actually run, with the fresh liveSessionId
    // it used — regardless of outcome, since a spawned-but-unparseable review
    // still spent real tokens and should be attributed. `advanceReviewedAt`
    // (only true on a successful written/none outcome) is what the caller uses
    // to decide whether to move the excerpt bound forward: an error leaves it
    // where it was, so the NEXT archive naturally retries the same span rather
    // than silently losing it.
    onStamp = () => {},
    isEnabled = archiveReviewEnabled,
  } = deps;

  if (!isEnabled()) return 'skipped';
  if ((entry?.agent || 'claude') !== 'claude') return 'skipped';
  if (!task?.id) return 'skipped';

  const liveId = entry?.liveSessionId || sessionId;
  const transcript = await findTranscriptFn(liveId);
  if (!transcript) return 'skipped';

  const sinceMs = Math.max(usageSince(entry), entry?.archiveReviewedAt || 0);
  const excerptEntries = await readLinesFn(transcript);
  const excerpt = buildExcerpt(excerptEntries, sinceMs);
  if (!excerpt) return 'skipped';

  return runQueued(async () => {
    const { text, liveSessionId, error } = await review(excerpt);
    const success = !error && text != null;
    onStamp({ reviewLiveSessionId: liveSessionId, advanceReviewedAt: success });
    if (!success) return 'error';
    if (!looksLikeBullets(text)) return 'none';
    memoryStore.append(task.id, sectionFor(text, entry?.lastLabel || entry?.intent));
    return 'written';
  });
}

// Guards against writing free-text prose into memory.md. Verified empirically:
// a genuinely thin excerpt sometimes makes Haiku respond with something like
// "I don't see a transcript in your message" instead of the instructed `NONE`
// — a confused non-answer, not durable knowledge, and it must never be
// appended. A real answer always LEADS with a bullet (EXTRACTION_PROMPT: "no
// preamble, no heading"), so checking only the first non-blank line — not
// every line — is the reliable filter without being so strict it drops a
// genuine multi-line bullet whose wording happens not to match `[-*]` exactly
// on a later line. `NONE` itself (no leading `-`/`*`) also correctly falls
// through this as "nothing to write".
function looksLikeBullets(text) {
  const firstLine = text.split('\n').map((l) => l.trim()).find(Boolean);
  return Boolean(firstLine && /^[-*]\s/.test(firstLine));
}
