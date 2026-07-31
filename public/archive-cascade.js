// Pure archive-cascade helpers, split out of app.js so they're unit-testable
// without a DOM (see snooze.js). Mirrors the server's descendantsOf (server/
// control/handlers/archive.js) — kept as a separate implementation since public/
// and server/ never cross-import in this codebase; both walk the same generic
// `parentSession` link (see the child-sessions design).

// The transitive closure of `parentSession` links under `sessionId`, walked over
// `sessions` (board nodes). "Descendant" is transitive, not just direct
// children, since a spawned child can itself have children (chaining).
export function descendantsOf(sessionId, sessions) {
  const childrenOf = new Map();
  for (const s of sessions) {
    if (s.parentSession) {
      const list = childrenOf.get(s.parentSession) || [];
      list.push(s);
      childrenOf.set(s.parentSession, list);
    }
  }
  const result = [];
  const seen = new Set();
  const queue = [sessionId];
  while (queue.length) {
    const id = queue.shift();
    for (const child of childrenOf.get(id) || []) {
      if (seen.has(child.sessionId)) continue;
      seen.add(child.sessionId);
      result.push(child);
      queue.push(child.sessionId);
    }
  }
  return result;
}

// The archive-confirm dialog's summary for a target + its descendants: the
// descendant list, whether ANY of them (target included) has a live background
// job, and how many sit in needs-you (archiving discards that unanswered
// question, since nothing keeps running to answer it).
export function cascadeSummary(target, sessions) {
  const descendants = descendantsOf(target.sessionId, sessions);
  return {
    descendants,
    count: descendants.length,
    hasBackgroundShell: Boolean(target.hasBackgroundShell) || descendants.some((s) => s.hasBackgroundShell),
    needsYou: descendants.filter((s) => s.status === 'needs-you').length,
  };
}

// Body text for the "descendants present" archive-confirm dialog (see
// archiveSession() in app.js). Names what's attached and separately flags
// anything riskier (a live background job anywhere in the set, a descendant
// waiting on the user).
export function cascadeDialogBody(target, sessions) {
  const { count, hasBackgroundShell, needsYou } = cascadeSummary(target, sessions);
  let body = `This has ${count} connected session${count === 1 ? '' : 's'} still active.`;
  if (hasBackgroundShell) body += ' One of them has a background job running — it\'ll be asked to wrap up first.';
  if (needsYou > 0) {
    body += ` ${needsYou} ${needsYou === 1 ? 'is' : 'are'} waiting on your input — archiving discards that question; `
      + 'it can\'t be nudged to finish since nothing is running for it.';
  }
  return body;
}

// Whether some OTHER tracked session (any relationship, live or dormant) still
// points at `worktreePath` — the actual danger the worktree-deletion offer must
// guard against (a review sharing its reviewed session's cwd with no worktree of
// its own, for example). Keyed on cwd, not parentSession. `ignoreIds` excludes
// sessions already known to be archived in the SAME operation (the target, and
// every descendant a cascade archived alongside it) — computed client-side off
// the same descendant list the dialog used, not a network round-trip, so it
// can't race a still-draining cascade.
export function worktreeStillInUse(worktreePath, sessions, ignoreIds) {
  const ignore = new Set(ignoreIds);
  return sessions.some((s) => !ignore.has(s.sessionId) && s.cwd === worktreePath);
}

// Whether some OTHER tracked devcontainer session (live or dormant) still points
// at `cwd` — i.e. shares the container the devcontainer runtime brought up for
// that workspace dir (a dispatch/resume/fork against the same repo all reuse ONE
// container). The "Stop container" offer must be withheld while one does, exactly
// as worktreeStillInUse withholds worktree deletion: stopping it would pull the
// rug from under a sibling session still using it. Unlike worktreeStillInUse this
// also filters on runtime — a HOST session sharing the cwd uses no container, so
// it mustn't block the stop. `ignoreIds` excludes sessions archived in the SAME
// operation (target + any cascade descendants), computed client-side off the same
// list the toast used so it can't race a still-draining archive. A parallel copy
// lives server-side in server/control/handlers/archive.js (see worktreeStillInUse
// / descendantsOf for why the two aren't shared).
export function containerStillInUse(cwd, sessions, ignoreIds) {
  const ignore = new Set(ignoreIds);
  return sessions.some((s) => !ignore.has(s.sessionId) && s.runtime === 'devcontainer' && s.cwd === cwd);
}
