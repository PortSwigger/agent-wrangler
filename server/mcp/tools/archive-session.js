import { z } from 'zod';
import { archiveCascade, descendantsOf, containerStillInUse } from '../../control/handlers/archive.js';
import { stopContainer } from '../../runtimes/devcontainer.js';

// Stop another Agent Wrangler session and archive it — the session-to-session
// counterpart to the board's "Stop & archive" action (server/control/handlers/
// archive.js). An orchestrator uses it to CLOSE a worker session it spun off once
// that worker has reported its work done. Archive (not remove): the process is
// killed but the mapping is kept, so the session stays archived (findable in
// Search) and resumable. The pre-stop snapshot (cwd/intent/label) is resolved
// through the shared graph resolver so its archived row shows it the same way
// the board does.
//
// Two deliberate divergences from the board handler: rebuild is awaited (a
// synchronous MCP tool should reflect the result before returning, vs the
// handler's deferred setTimeout); and there is no process.kill(pid) fallback —
// killForSession already covers a live (managed) worker, and a missing target is
// rejected by the unknown-id guard below.
//
// A THIRD divergence, deliberate: there's no human here to offer the board's
// 3-way "kill jobs & archive / archive anyway / cancel" choice, so this always
// takes the safe option — nudge + bounded wait, then archive regardless — rather
// than silently killing a live background shell outright (the noisy-resume cause)
// or refusing to archive at all. A worker that's actually done rarely has one
// still running, so this costs nothing in the common case. `archiveCascade`
// (shared with the board's "Archive all") is exactly this per-session pattern,
// applied here to the target plus (by default) its descendants.
export const archiveSessionTool = {
  name: 'archive_session',
  description:
    'Stop and archive ANOTHER Agent Wrangler session — kill its process but keep it archived '
    + '(resumable), the same as the board\'s "Stop & archive". Use it to close a worker session '
    + 'you spun off once it has reported its work done. Get the target id from list_sessions. You '
    + 'cannot archive yourself (finish and stop — that archives automatically). By default this '
    + 'also archives any nested child sessions (spawned off this one) — pass archive_children: '
    + 'false to leave them running. For a devcontainer session the Docker container is LEFT '
    + 'RUNNING by default (so resume stays fast) — pass stop_container: true to also stop it, '
    + 'which is skipped if another active session still shares that container. This archives, it '
    + 'does not permanently remove.',
  inputSchema: {
    target: z.string().min(1).describe('Session id to stop and archive (card id, as returned by list_sessions).'),
    archive_children: z.boolean().optional().describe(
      'Also archive this session\'s nested children (transitively), descendants-first. Default true.',
    ),
    stop_container: z.boolean().optional().describe(
      'For a devcontainer session, also stop its Docker container after archiving. Default false '
      + '(the container is left running so resume is fast). Ignored for a non-devcontainer session, '
      + 'and withheld when another active session still shares the container.',
    ),
  },
  async handler({ deps, caller }, args = {}) {
    const target = (args.target ?? '').trim();
    if (!target) return errorResult('target is required.');
    // Null-safe: a null caller never equals a real id, so it can still archive.
    if (caller != null && target === caller) {
      return errorResult('Cannot archive yourself — finish your work and stop; the session is archived automatically.');
    }
    const entry = deps.sessionManager.entryFor(target);
    if (!entry) {
      return errorResult(`Unknown session ${target} — no such session on the board.`);
    }

    const node = deps.sessionFromGraph?.(target) ?? null;
    const archiveChildren = args.archive_children !== false;
    const sessions = deps.graph?.()?.sessions || [];
    const descendants = archiveChildren ? descendantsOf(target, sessions) : [];
    const archivedIds = [...descendants.map((d) => d.sessionId), target];
    const { unclean } = await archiveCascade(archivedIds, deps);
    await deps.rebuild?.();

    // Opt-in devcontainer container stop, mirroring the board's toast offer: left
    // running by default (fast resume), and even when requested it's WITHHELD while
    // another active session still shares the container — the same-cwd guard the
    // worktree-deletion offer uses. `sessions` is the pre-archive graph, so the
    // just-archived target + descendants are excluded via archivedIds. null when
    // not requested or the target isn't a devcontainer; a boolean = whether a
    // container was actually stopped (false when none was running OR it was withheld).
    let containerStopped = null;
    if (args.stop_container && entry.runtime === 'devcontainer' && entry.cwd) {
      // deps.stopContainer overrides the real docker-shelling helper in tests.
      const stop = deps.stopContainer || stopContainer;
      containerStopped = containerStillInUse(entry.cwd, sessions, archivedIds)
        ? false
        : Boolean(await stop(entry.cwd, {}));
    }

    const anyHasBackgroundShell = Boolean(node?.hasBackgroundShell) || descendants.some((d) => d.hasBackgroundShell);
    const structuredContent = {
      target,
      label: node?.label ?? null,
      archived: true,
      backgroundShellUncleanStop: anyHasBackgroundShell ? unclean : null,
      archivedChildren: descendants.length,
      containerStopped,
    };
    return {
      content: [{ type: 'text', text: JSON.stringify(structuredContent, null, 2) }],
      structuredContent,
    };
  },
};

function errorResult(message) {
  return { content: [{ type: 'text', text: message }], isError: true };
}
