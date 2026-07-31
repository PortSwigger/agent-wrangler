import { local } from './local.js';
import { devcontainer } from './devcontainer.js';

// The runtime registry answers "where does the agent process run" — the host
// (`local`) or inside a container. A runtime is a small object; adding one is a new
// module here plus an entry in `ALL`. Contract:
//
//   id           (required) the string stored on `entry.runtime` and matched by
//                runtimeFor. `local` is stored as ABSENT (session-manager writes
//                `runtime === 'local' ? undefined : runtime`), so back-compat holds.
//   wrapLaunch   (required) async ({ inner, cwd, sessionId, worktree, workflow }) →
//                the command tmux actually runs. Receives the agent's already-built
//                inner command and returns it decorated (local: identity;
//                devcontainer: a `devcontainer up && docker cp && exec` script).
//                `workflow` is absent on fork (forks don't carry it).
//   preflight    (optional) async ({ cwd }) → a human-facing error string to REFUSE
//                the dispatch (thrown, surfaced on the board as a toast), or null to
//                proceed. Runs before any dir/worktree side effect — devcontainer
//                uses it to reject a repo with no .devcontainer config instead of
//                dead-paning on `devcontainer up`.
//   skipsHostResumeGuard  (optional, default falsey) when true, resume bypasses the
//                host `--resume` transcript/launch-dir guard — for a runtime whose
//                transcript lives IN-container (unreadable on the host, so the guard
//                can't see it, e.g. devcontainer). A runtime whose transcript lands
//                host-side (e.g. via a bind-mount) leaves this FALSE and keeps the
//                guard — copying devcontainer's `true` blindly would drop protection.
//   readLive     (optional) async ({ entry, tmuxName, socket }) → a live-status blob
//                { liveSid, status, rawStatus, waitingFor, name, updatedAt } or null.
//                Overrides the host liveState/pane-scrape when the status file is
//                in-container. Absent ⇒ state-reader reads the host filesystem.
//   analyze      (optional) async ({ entry, liveSid }) → a cost/token enrichment or
//                null. Overrides host transcript costing when the transcript is
//                in-container. Absent ⇒ state-reader costs the host transcript.
//
// Per-runtime POLICY (comms severing, worktree/fork/codex allowance, teardown
// timing) is deliberately NOT in the contract yet: no current runtime needs it, so
// adding it now would be dead code. A runtime that does (e.g. a firewalled sandbox
// that strips host-MCP flags) adds the capability field + the single site that
// reads it — see docs/superpowers/specs/2026-07-23-container-runtimes-unification.md.
const ALL = [local, devcontainer];
export const DEFAULT_RUNTIME = 'local';

// `runtime` absent/blank ⇒ local (back-compat: every pre-runtime entry is a
// host session). An unrecognised non-empty id throws rather than defaulting to
// local — silently running on the host when a container runtime was intended
// would drop the sandbox guarantee, so fail loud instead. (Contrast adapterFor,
// which defaults to claude: a wrong *agent* is cosmetic; a wrong *runtime* is a
// safety regression.)
export function runtimeFor(id) {
  if (!id) return local;
  const found = ALL.find((r) => r.id === id);
  if (!found) throw new Error(`unknown runtime: ${id}`);
  return found;
}
