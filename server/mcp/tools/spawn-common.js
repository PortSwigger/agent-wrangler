import fs from 'node:fs';
import { expandTilde } from '../../session-manager.js';

// Shared plumbing for the spawn_* tools (spawn_session, spawn_workflow). Both
// mirror the /ws `dispatch` handler: resolve the target task, bind memory to it
// BEFORE launch, dispatch a fresh card, assign it, rebuild. The only thing that
// differs between them is the dispatch payload itself (a freeform `intent` vs a
// skill-wrapped issue + forced worktree + orchestrator marker), so that piece is
// supplied by the caller via `buildDispatch` and everything else lives here once.
//
// `buildDispatch({ caller, callerEntry })` returns the dispatch-specific opts
// (intent + worktree* + workflow); it gets `callerEntry` so a tool can read the
// caller's workflow marker (spawn_session tags workers off it). Task resolution,
// model inheritance, add_dir validation, the memory binder, the post-launch
// assign/rebuild and the result shape are all identical and handled here.
export async function performSpawn({ deps, caller, args, buildDispatch }) {
  // `into` wins; otherwise inherit the caller's current task; null caller → Ad-hoc.
  const taskId = args.into ?? deps.taskStore.taskFor(caller)?.id ?? null;

  const agent = args.agent || 'claude';

  // Default the new session's model to the CALLER's model when none was given,
  // so work spun off inherits the model it was launched from. Only when the new
  // session runs the SAME agent — model names don't cross agents (opus vs
  // gpt-5.5). A null caller model means "agent default", which is the right
  // inherited default anyway, so the lookup is a no-op there.
  let { model } = args;
  const callerEntry = caller ? deps.sessionManager?.entryFor(caller) : null;
  if (model == null && callerEntry && (callerEntry.agent || 'claude') === agent) {
    model = callerEntry.model || undefined;
  }

  let addDirs;
  try {
    addDirs = expandAddDirs(args.add_dirs);
  } catch (e) {
    return errorResult(e.message);
  }

  let result;
  try {
    result = await deps.dispatch({
      cwd: args.cwd,
      model,
      agent,
      addDirs,
      ...buildDispatch({ caller, callerEntry }),
      spawnedBy: caller || undefined,
      // Bind the memory symlink to the resolved task BEFORE launch — the agent
      // reads AW_TASK_MEMORY / --add-dir at boot. dispatch mints the card id, so
      // we hand in a binder rather than binding after it returns.
      bindMemory: (sid) => deps.memoryStore.bindSession(sid, taskId),
    });
  } catch (e) {
    return errorResult(e?.message || 'Spawn failed');
  }

  // assign is a no-op if the task was deleted meanwhile — the session just falls
  // back to Ad-hoc, matching the /ws dispatch path.
  if (taskId) deps.taskStore.assign(result.sessionId, taskId);
  await deps.rebuild();

  const task = deps.taskStore.taskFor(result.sessionId) ?? null;
  const structuredContent = {
    sessionId: result.sessionId,
    cwd: result.cwd ?? null,
    agent,
    task,
  };
  return {
    content: [{ type: 'text', text: JSON.stringify(structuredContent, null, 2) }],
    structuredContent,
  };
}

// Tilde-expand each add_dir and confirm it exists and is a directory, so a bad
// grant fails the spawn cleanly rather than launching a session that can't read
// the path it was promised.
export function expandAddDirs(dirs) {
  if (!Array.isArray(dirs)) return [];
  return dirs.map((d) => {
    const p = expandTilde(String(d).trim());
    let stat;
    try {
      stat = fs.statSync(p);
    } catch {
      throw new Error(`add_dir does not exist: ${p}`);
    }
    if (!stat.isDirectory()) throw new Error(`add_dir is not a directory: ${p}`);
    return p;
  });
}

export function errorResult(message) {
  return { content: [{ type: 'text', text: message }], isError: true };
}
