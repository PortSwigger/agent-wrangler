import fs from 'node:fs';
import os from 'node:os';
import { sendText as defaultSendText } from '../../tmux-scraper.js';
import { resolveResumeDir } from '../../transcript-reader.js';
import { waitForPaneReady } from './resume.js';

// After a resume the freshly-launched TUI may not be accepting input yet, so a
// paste can be dropped/mangled. Settle briefly before delivery on the resume path
// only. Bounded to ~2 s so it can never hang: Claude paints its OSC pane title once
// ready (waitForPaneReady returns as soon as it appears), while Codex sets no such
// title, so it simply falls through to the 2 s ceiling as a fixed settle — one
// agent-agnostic mechanism for both.
const RESUME_SETTLE_MS = 2000;
const RESUME_SETTLE_POLL_MS = 250;

// Compile the client's review comments into ONE plain-text message the agent can
// read in its pane. Pure + exported so the exact wording is unit-testable without
// tmux. Comments are grouped by file (first-seen order preserved) so same-file
// notes read together; each shows `path:line (side)` for a single line or
// `path:start-end (side)` for a range, the snapshotted code, then the reviewer's
// body. The snapshot is just indented here — it already carries its own per-line
// `>` marker on the commented rows and surrounding context above/below them (see
// rangeSnapshot on the client), so this must NOT also blanket-quote every row, or
// the marker would be double-nested and unreadable. Tolerates a legacy
// single-line comment carrying `line` instead of startLine/endLine, and a legacy
// (pre-context) plain-text snapshot with no marker of its own.
export function formatDiffComments(comments) {
  const list = Array.isArray(comments) ? comments : [];
  const byFile = new Map();
  for (const c of list) {
    const file = c.file || '(unknown file)';
    if (!byFile.has(file)) byFile.set(file, []);
    byFile.get(file).push(c);
  }
  const blocks = [];
  for (const cs of byFile.values()) {
    for (const c of cs) {
      const side = c.side ? ` (${c.side})` : '';
      const start = c.startLine ?? c.line;
      const end = c.endLine ?? c.line;
      const span = start === end ? `${start}` : `${start}-${end}`;
      const snapshot = String(c.snapshot ?? '').split(/\r?\n/).map((s) => `    ${s}`).join('\n');
      const body = String(c.body ?? '').trim();
      blocks.push(`${c.file}:${span}${side}\n${snapshot}\n    ${body}`);
    }
  }
  return `Review comments on the working-tree diff (${list.length}):\n\n${blocks.join('\n\n')}`;
}

// Deliver diff review comments into the target session's live pane. The delivery
// MUST NOT rely on resume "intent" — that's a silent no-op for Codex (only Claude
// threads it). So for a dormant session we resume WITHOUT intent purely to bring
// the pane live, then submit the message via sendText, which is agent-agnostic and
// works for both Claude and Codex. We only reply ok:true once delivery actually
// happened, so a failure lets the client keep the user's drafts.
export const diffCommentsHandler = {
  type: 'diff-comments',
  async handler(msg, ctx) {
    const { sessionId } = msg;
    const sendText = ctx.sendText || defaultSendText; // test seam; real impl in prod
    try {
      const comments = Array.isArray(msg.comments) ? msg.comments : [];
      if (comments.length === 0) {
        ctx.reply({ type: 'diff-comments-result', sessionId, ok: false, error: 'No comments to submit.' });
        return;
      }
      const message = formatDiffComments(comments);

      // Live iff the wrangler owns a live tmux pane for it (tmuxFor truthy) —
      // mirrors runSessionAction's liveness branch.
      let target = ctx.tmuxFor(sessionId);
      if (!target) {
        const entry = ctx.sessionManager.entryFor(sessionId);
        if (!entry) throw new Error(`Session ${sessionId} not found (it may have been archived).`);
        // Resume from the launch dir (bucketed under the LIVE id, per the resume
        // rules), recreating a cleaned-up worktree dir so the relaunch isn't
        // stranded in ~. NO intent — see the note above.
        let dir = await resolveResumeDir(entry.liveSessionId || sessionId, { entryCwd: entry.cwd });
        if (!dir || !fs.existsSync(dir)) {
          try { fs.mkdirSync(dir, { recursive: true }); } catch { dir = os.homedir(); }
        }
        // Bind memory BEFORE relaunch so the resumed agent's AW_TASK_MEMORY resolves
        // at boot, keyed on the stable card id (matches resume.js).
        ctx.memoryStore?.bindSession(sessionId, ctx.taskStore?.taskFor(sessionId)?.id || null);
        await ctx.sessionManager.resume(sessionId, dir);
        await ctx.rebuild?.();
        target = ctx.tmuxFor(sessionId);
        if (!target) throw new Error('Session did not come live after resume.');
        // Settle before delivery ONLY on this resume path — the already-live path
        // is already accepting input. ctx.waitForPaneReady is a test seam.
        const waitReady = ctx.waitForPaneReady || waitForPaneReady;
        await waitReady(target, ctx.socketFor(sessionId), { timeoutMs: RESUME_SETTLE_MS, pollMs: RESUME_SETTLE_POLL_MS });
      }

      await sendText(target, message, ctx.socketFor(sessionId));
      ctx.reply({ type: 'diff-comments-result', sessionId, ok: true });
    } catch (err) {
      ctx.reply({ type: 'diff-comments-result', sessionId, ok: false, error: String(err.message || err) });
    }
  },
};
