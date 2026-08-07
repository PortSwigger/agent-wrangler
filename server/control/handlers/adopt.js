import { readMeta } from '../../search/corpus.js';
import { findTranscript } from '../../transcript-reader.js';
import { codex as codexAdapter } from '../../agents/codex.js';
import { resumeSession } from './resume.js';

// Put a conversation that has no card onto the board and resume it. Search reads
// every transcript on disk, so it routinely surfaces conversations the wrangler
// never launched — an ad-hoc CLI run, or one whose mapping was long ago forgotten
// — and without this they were read-only text with no way back into a terminal.
//
// The conversation id is a LOOKUP KEY into the search index, never launch input:
// the doc it resolves to supplies the agent and the cwd, so a client can't name an
// arbitrary directory (or an id that isn't a real conversation) to launch in. An id
// the index doesn't know is refused rather than guessed at — the button that sends
// this only ever exists on a result the index just returned.
//
// Every failure answers `adopt-failed` (never a bare `error`) and carries the
// conversation id back: the clicked button is disabled until it hears about its own
// request, and a generic error toast would leave it stuck saying "Starting…".

// Defence in depth on the id before it reaches `--resume <id>`: doc.id is
// self-reported by the transcript's own JSON (corpus.js prefers it over the
// filename stem), so it is file content, not a name we derived.
const ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

export const ADOPT_UNKNOWN_MSG =
  "Can't start a session from this conversation — the search index no longer has it. Rebuild the index and try again.";
export const ADOPT_NO_CODEX_MSG =
  "This is a Codex conversation, but the `codex` binary isn't on PATH — install it (or put it on the launchd PATH) to resume Codex sessions.";

const fail = (ctx, sessionId, message) => ctx.reply({ type: 'adopt-failed', sessionId, message });

export async function adoptConversation(msg, ctx, {
  docs = () => readMeta().docs || [],
  transcriptFor = findTranscript,
  codexAvailable = () => codexAdapter.isAvailable(),
  resume = resumeSession,
} = {}) {
  const liveSessionId = String(msg.sessionId || '');
  if (!ID_RE.test(liveSessionId)) {
    fail(ctx, liveSessionId, ADOPT_UNKNOWN_MSG);
    return;
  }

  // Already on the board (a stale result list, or a double click that raced the
  // first adopt): point at the card that exists instead of minting a second one.
  // A live one is left strictly alone — resuming it would kill a running pane —
  // while a dormant or archived one is resumed, since "get me back into this
  // conversation" is exactly what was asked for.
  const owner = ctx.sessionManager.cardForLive(liveSessionId);
  if (owner) {
    if (!ctx.sessionManager.tmuxNameFor(owner)) await resume(owner, ctx);
    ctx.reply({ type: 'adopted', sessionId: owner, liveSessionId, alreadyMapped: true });
    return;
  }

  const doc = docs().find((d) => d && d.id === liveSessionId && !d.dead);
  if (!doc) {
    fail(ctx, liveSessionId, ADOPT_UNKNOWN_MSG);
    return;
  }
  const agent = doc.agent === 'codex' ? 'codex' : 'claude';
  if (agent === 'codex' && !(await codexAvailable())) {
    fail(ctx, liveSessionId, ADOPT_NO_CODEX_MSG);
    return;
  }
  // Claude's resume fails OPEN into a blank session, so _doResume refuses when the
  // transcript isn't findable. Check it HERE too, before the entry exists: a refusal
  // afterwards would leave a card for a conversation that can never be resumed.
  // (Codex rollouts aren't in the Claude project buckets findTranscript walks.)
  if (agent === 'claude' && !(await transcriptFor(liveSessionId))) {
    fail(ctx, liveSessionId, ADOPT_UNKNOWN_MSG);
    return;
  }

  const { sessionId } = ctx.sessionManager.adopt({
    liveSessionId,
    agent,
    // The transcript's own cwd. For Claude it's only a fallback — resumeSession
    // re-derives the launch dir from the transcript head (the bucket `--resume`
    // needs); for Codex, which isn't cwd-bucketed, it IS the launch dir.
    cwd: doc.cwd || '',
    // No name: the board derives a live card's label from the agent's own title /
    // transcript summary, which beats anything we could stamp here. The ai-title
    // rides along as the intent so a dormant card (a cancelled resume) still reads
    // as something other than its cwd basename.
    intent: doc.title || '',
  });

  try {
    await resume(sessionId, ctx);
  } catch (err) {
    // Roll the card back rather than leave a phantom the user has to clean up —
    // adopt+resume is one action from where they clicked. Note a resume that only
    // PROMPTS (resume-needs-dir: the transcript's dir is gone) doesn't throw; that
    // card is deliberately kept, so answering the prompt resumes it in place.
    ctx.sessionManager.forget(sessionId);
    ctx.memoryStore.forget(sessionId);
    await ctx.rebuild();
    fail(ctx, liveSessionId, String(err?.message || err));
    return;
  }
  // resumeSession rebuilds on the path that launches; this covers the one that
  // didn't (the needs-dir prompt), so the dormant card still appears on the board.
  await ctx.rebuild();
  ctx.reply({ type: 'adopted', sessionId, liveSessionId });
}

export const adoptConversationHandler = {
  type: 'adopt-conversation',
  async handler(msg, ctx) {
    try {
      await adoptConversation(msg, ctx);
    } catch (err) {
      // The router's generic error envelope would never reach the waiting button.
      fail(ctx, String(msg.sessionId || ''), String(err?.message || err));
    }
  },
};
