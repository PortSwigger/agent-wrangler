import { resolveResumeDir, launchCwd } from '../../transcript-reader.js';
import { NEVER_MESSAGED_FORK_MSG } from '../../session-manager.js';
import { ensureLaunchDir } from './resume-dir.js';

export const forkHandler = {
  type: 'fork',
  async handler(msg, ctx) {
    // Branch from the LIVE conversation: a previously-resumed session runs under a
    // post-fork id (graph `liveSessionId`) while its board id's own transcript is
    // frozen. For a never-resumed/dead/archived session liveSessionId is absent,
    // and the board id is itself the branch point.
    const s = ctx.sessionFromGraph(msg.sessionId);
    const parentEntry = ctx.sessionManager.entryFor(msg.sessionId);
    // A cloud card has nothing to fork: `--fork-session` is a HOST-transcript
    // operation and the cloud runtime has no buildFork equivalent, so without this
    // the chain below would resolve a `sourceId` (the card id, since a cloud entry
    // carries no liveSessionId) and hand it to a nonsense `claude --resume
    // --fork-session <card id>` — which fails open into a fresh empty local
    // session (see CLAUDE.md's resume-fails-open rule). Refuse early instead.
    if (parentEntry?.runtime === 'cloud') {
      throw new Error('A cloud session can\'t be forked — its conversation lives in the cloud, not in a local transcript. Teleport it to a worktree first, then fork the local card.');
    }
    // Prefer the graph's live id (tracks a running fork), then the mapping entry's
    // stored live id — authoritative for a preset-id agent and the fallback when the
    // graph node carries no live id yet (e.g. a devcontainer whose in-container status
    // file hasn't been read into the graph). Only THEN the card id, for a legacy entry
    // with no live id at all. Never `--resume` the card id when a real live id exists.
    const sourceId = s?.liveSessionId || parentEntry?.liveSessionId || msg.sessionId;
    // A never-messaged fork has no persisted conversation to branch from (and its
    // branch point was never saved). Refuse with guidance rather than launch a
    // `--resume` that dies on "No conversation found". (Caught by the router → client.)
    if (parentEntry?.forkedFrom && !(await launchCwd(sourceId))) {
      throw new Error(NEVER_MESSAGED_FORK_MSG);
    }
    const dir = await resolveResumeDir(msg.sessionId, {
      graphCwd: s?.cwd,
      entryCwd: parentEntry?.cwd,
    });
    // Same deleted-dir trap as resume; echo the fork's own params so the opt-in
    // re-send forks (not resumes).
    const ready = ensureLaunchDir({
      dir,
      recreateDir: msg.recreateDir,
      reply: ctx.reply,
      sessionId: msg.sessionId,
      extra: { action: 'fork', prompt: msg.prompt || '', name: msg.name || '' },
    });
    if (!ready) return;

    const { sessionId } = await ctx.sessionManager.fork({
      sourceId,
      parentId: msg.sessionId,
      parentEntry,
      cwd: dir,
      prompt: msg.prompt || '',
      name: msg.name || '',
      // Bind the fork's memory to the parent's task BEFORE launch, so the new
      // agent's AW_TASK_MEMORY / --add-dir resolve at boot — same as dispatch.
      bindMemory: (sid) => ctx.memoryStore.bindSession(sid, ctx.taskStore.taskFor(msg.sessionId)?.id || null),
    });
    // Land the fork in the parent's task (no-op if unassigned or the task was since
    // deleted — it falls back to Ad hoc).
    const t = ctx.taskStore.taskFor(msg.sessionId);
    if (t) ctx.taskStore.assign(sessionId, t.id);
    await ctx.rebuild();
    // The fork's id is server-generated; tell the client so it can select the new
    // card once the next graph contains it.
    ctx.reply({ type: 'forked', sessionId });
  },
};
