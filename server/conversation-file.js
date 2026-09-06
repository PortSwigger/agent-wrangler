import { findTranscript } from './transcript-reader.js';
import { findRollout } from './agents/codex-rollout.js';

// Card conversation id + agent -> the file that conversation is recorded in.
//
// This exists because the two agents keep their conversations in completely
// different places, and every read path that forgot it silently degraded to an
// empty view rather than to an error: Claude transcripts live in the per-cwd
// project buckets under ~/.claude/projects, Codex rollouts under
// ~/.codex/sessions/<yyyy>/<mm>/<dd>/rollout-<ts>-<uuid>.jsonl. Resolving every
// session with findTranscript is exactly why the chat view showed Codex sessions
// as empty and had to be disabled for them (PR #94).
//
// One function rather than an `agent === 'codex'` fork at each call site, so a
// third read path cannot be added with only half the resolution.
//
// `agent` is normalised to 'codex' or 'claude' by both callers before it gets
// here; anything else falls to the Claude branch, which is the right default for
// a legacy entry with no agent field at all.
//
// The dirs are forwarded rather than stubbed so tests drive the REAL finders
// (walk order, filename matching, path caching) against a temp tree. Passing
// undefined leaves each finder on its own production default.
export function findConversationFile(convId, agent, { projectsDir, sessionsDir } = {}) {
  return agent === 'codex' ? findRollout(convId, sessionsDir) : findTranscript(convId, projectsDir);
}
