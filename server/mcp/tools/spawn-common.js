import fs from 'node:fs';
import { autoCompactTokensError, expandTilde } from '../../session-manager.js';
import { launchTargetError, modelError } from '../../agents/index.js';
import { findRuntime } from '../../runtimes/index.js';
import { awaitLaunchStatus } from '../../runtimes/launch-status.js';

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

  // Reject a caller-supplied agent/model/effort the adapters don't offer, rather than
  // passing it through to a CLI that either errors in the pane or (for a bad
  // agent, which adapterFor silently resolves to claude) launches something the
  // caller didn't ask for. Validates `args.model`/`args.effort` and deliberately runs BEFORE
  // the inheritance fallback below: an existing entry may carry a model value
  // since dropped from an adapter, and failing a spawn over a string the caller
  // never supplied would break the inheritance this tool is meant to provide.
  //
  // A runtime that defines `validateModel` owns the model vocabulary for its
  // sessions, so core's per-agent check is skipped for it and the runtime is
  // asked instead; the accepted model reaches it as `ext.<extId>.model`.
  const rt = args.runtime ? findRuntime(args.runtime) : null;
  const ownsModel = typeof rt?.validateModel === 'function';
  const badTarget = launchTargetError(agent, ownsModel ? undefined : args.model, args.effort);
  if (badTarget) return errorResult(badTarget);
  if (ownsModel) {
    let modelErr;
    try {
      modelErr = await rt.validateModel({ agent, model: args.model ?? null, coreModelError: modelError });
    } catch (e) {
      modelErr = e?.message || 'Model validation failed';
    }
    if (modelErr) return errorResult(modelErr);
  }
  const autoCompactError = autoCompactTokensError(args.auto_compact_tokens, agent);
  if (autoCompactError) return errorResult(autoCompactError);

  // Default the new session's model to the CALLER's model when none was given,
  // so work spun off inherits the model it was launched from. Only when the new
  // session runs the SAME agent — model names don't cross agents (opus vs
  // gpt-5.5). A null caller model means "agent default", which is the right
  // inherited default anyway, so the lookup is a no-op there.
  // Effort inherits on exactly the same terms and for the same reason: the level
  // vocabularies differ per adapter (codex offers `ultra`, claude does not), so a
  // cross-agent spawn falls back to that agent's own default.
  let { model, effort } = args;
  const callerEntry = caller ? deps.sessionManager?.entryFor(caller) : null;
  if (callerEntry && (callerEntry.agent || 'claude') === agent) {
    // The caller's model belongs to the caller's agent, not to a runtime that owns its own.
    if (model == null && !ownsModel) model = callerEntry.model || undefined;
    if (effort == null) effort = callerEntry.effort || undefined;
  }
  let ext;
  if (ownsModel) {
    if (model != null) ext = { [rt.extId]: { model } };
    model = undefined;
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
      effort,
      agent,
      ext,
      addDirs,
      autoCompactTokens: args.auto_compact_tokens,
      ...buildDispatch({ caller, callerEntry }),
      spawnedBy: caller || undefined,
      // The resolved task, so the launch context (session.launchContext) sees it
      // BEFORE launch — dispatch mints the card id, so the assign below can only
      // land afterwards.
      taskId: taskId || undefined,
      launchReason: 'spawn',
    });
  } catch (e) {
    return errorResult(e?.message || 'Spawn failed');
  }

  // assign is a no-op if the task was archived (or is otherwise unknown) meanwhile
  // — the session just falls back to Ad-hoc, matching the /ws dispatch path.
  if (taskId) deps.taskStore.assign(result.sessionId, taskId);
  await deps.rebuild();

  const task = deps.taskStore.taskFor(result.sessionId) ?? null;
  // The caller's only way to name the session it just created — without this,
  // reporting it to the user means quoting the raw card id, which is never
  // meaningful to a human. Read post-rebuild so it reflects the label the new
  // card actually resolved to (see get-session-info.js's identical pattern).
  const label = deps.graph?.()?.sessions?.find((s) => s.sessionId === result.sessionId)?.label ?? null;
  const structuredContent = {
    sessionId: result.sessionId,
    label,
    cwd: result.cwd ?? null,
    agent,
    task,
  };
  // A runtime whose launch can still fail after dispatch (e.g. a cloud hand-off)
  // is waited on briefly, so a refused launch reaches the caller here rather than
  // only as a chip on the board. `wait: false` skips it for fan-outs.
  if (args.wait !== false) {
    const launch = await awaitLaunchStatus(deps.sessionManager?.entryFor(result.sessionId), deps.launchWait);
    if (launch) structuredContent.launch = launch;
  }
  const json = JSON.stringify(structuredContent, null, 2);
  if (structuredContent.launch?.state === 'failed') {
    // The card exists (and stays, so the board shows why); the caller decides
    // whether to archive it or retry.
    return {
      content: [{ type: 'text', text: `The session was created but its launch failed: ${structuredContent.launch.error}\n\n${json}` }],
      structuredContent,
      isError: true,
    };
  }
  return {
    content: [{ type: 'text', text: json }],
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
