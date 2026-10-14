import { getExtensions } from './extensions/index.js';
import { logError } from './log.js';

// The `session.prepare` seam: what extensions run before a NEW session is set
// up. Each enabled extension's `hooks['session.prepare']` is awaited, in order,
// with `{ sessionId, taskId, cwd, repoRoot, willCreateWorktree, agent, host }`
// and answers `void | { abort?, warnings? }`:
//   abort    — a message; the dispatch fails with it, before any worktree or
//              pane exists. Later extensions are not asked.
//   warnings — messages the board toasts; the launch goes ahead.
// It runs before the worktree is created, so a hook can bring the repo up to
// date (`git pull --ff-only`) and the worktree then branches from fresh state.
// Dispatch only — resume and fork reuse an existing checkout and never ask.
//
// A hook that throws or overruns PREPARE_TIMEOUT_MS is logged and skipped: one
// broken or slow extension must not keep a session from launching.
export const PREPARE_TIMEOUT_MS = 60_000;

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export async function collectPrepare(
  payload,
  { ext = getExtensions(), hostApiFor = () => undefined, onError = logError, timeoutMs = PREPARE_TIMEOUT_MS } = {},
) {
  const warnings = [];
  for (const { extId, fn } of ext.hooks?.['session.prepare'] || []) {
    let out;
    try {
      out = await withTimeout(Promise.resolve().then(() => fn({ ...payload, host: hostApiFor(extId) })), timeoutMs);
    } catch (err) {
      onError(`[ext:${extId}] session.prepare failed — skipped`, err);
      continue;
    }
    if (out == null) continue;
    if (typeof out !== 'object' || Array.isArray(out)) {
      onError(`[ext:${extId}] session.prepare must return { abort?, warnings? } — ignored`);
      continue;
    }
    for (const w of Array.isArray(out.warnings) ? out.warnings : []) {
      if (typeof w === 'string' && w.trim()) warnings.push(w);
    }
    if (typeof out.abort === 'string' && out.abort.trim()) return { abort: out.abort, warnings };
  }
  return { abort: null, warnings };
}
