import { local } from './local.js';
import { devcontainer } from './devcontainer.js';

// The runtime registry answers "where does the agent process run" — the host
// (`local`) or inside a container. A runtime is a small object; a built-in one is
// a new module here plus an entry in `ALL`, and an extension contributes one
// through its manifest's `runtimes` array (validated by the loader, bound to the
// extension's façade and registered here by server/index.js — see
// registerRuntime). The contract is the SAME for both, so a built-in can later
// move out to an extension unchanged:
//
//   id           (required) the string stored on `entry.runtime` and matched by
//                runtimeFor. `local` is stored as ABSENT (session-manager writes
//                `runtime === 'local' ? undefined : runtime`), so back-compat holds.
//   label        (required) what the dispatch dialog's Runtime select shows, and
//                what a refusal names the runtime by.
//   wrapLaunch   async ({ inner, cwd, sessionId, worktree, workflow, launchContext })
//                → the command tmux actually runs. Receives the agent's already-built
//                inner command and returns it decorated (local: identity;
//                devcontainer: a `devcontainer up && docker cp && exec` script).
//                `workflow` is absent on fork (forks don't carry it).
//   buildLaunch  async ({ phase, intent, cwd, sessionId, model, ext }) → the WHOLE
//                pane command, replacing the agent adapter's (for a runtime whose
//                agent is not a local process at all, e.g. a hand-off to a remote
//                service). EXACTLY ONE of wrapLaunch/buildLaunch. When it is used,
//                dispatch skips the adapter's command, wrapLaunch and live-id
//                resolution, and the card is stored with no `liveSessionId`.
//                `phase` is always 'dispatch' in 1.19.0: a buildLaunch runtime MUST
//                declare `resumable: false` (the loader quarantines one that
//                doesn't), so resume and fork never reach it. The other phases
//                are reserved until a runtime needs them.
//   preflight    (optional) async ({ cwd, agent, workflow, worktree, ext }) → a
//                human-facing error string to REFUSE the dispatch (thrown,
//                surfaced on the board as a toast), or null to proceed. Runs before
//                any dir/worktree side effect — devcontainer uses it to reject a
//                repo with no .devcontainer config instead of dead-paning on
//                `devcontainer up`. `workflow`/`worktree` are booleans and `ext`
//                is the dialog's extension data narrowed to the runtime's own
//                extension (null for a built-in, or when none was sent); a runtime
//                that doesn't care ignores them, as devcontainer does.
//   resumable    (optional, default true) false ⇒ resume and fork are refused up
//                front (relaunchRefusal) and the graph tick never adopts a live
//                conversation id for the card (noteLiveSessionId).
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
//   deliver      (optional) async ({ entry, from, text }) → { ok: true } |
//                { ok: false, error } — how a peer message (send_message) reaches a
//                card whose agent has no local pane to paste into. `from` is the
//                sender's card id and `text` the BEGIN/END-fenced body the pane
//                paste would get. A runtime with `deliver` stores its cards as
//                `mailCapable: false`, so send_message routes them here (see
//                mcp/tools/send-message.js).
//
// Per-runtime POLICY (comms severing, teardown timing) is deliberately NOT in the
// contract yet: no current runtime needs it, so adding it now would be dead code.
// Worktree/workflow/codex allowance is the preflight's call (it is handed all
// three) and fork allowance is `resumable`. A runtime that does (e.g. a firewalled sandbox
// that strips host-MCP flags) adds the capability field + the single site that
// reads it — see docs/superpowers/specs/2026-07-23-container-runtimes-unification.md.
const ALL = [local, devcontainer];
export const DEFAULT_RUNTIME = 'local';
// What an extension's runtime may not be called. Handed to the loader by
// server/index.js (as `coreRuntimeIds`) rather than imported by it: this module
// pulls in devcontainer → agents/claude → agent-skills → extensions/index.js, so
// the loader importing it back would close a cycle.
export const BUILTIN_RUNTIME_IDS = ALL.map((r) => r.id);

// id -> the bound runtime an ACTIVE extension contributed, tagged with `extId`.
// Filled and emptied by server/index.js's activate/deactivate, never by the
// loader, and deliberately NOT keyed off anything under extensions/** — this
// module must not import it (the cycle above). The loader has already refused a
// colliding id, so the throw below is a backstop for a wiring bug, not a check
// a manifest can reach.
const registered = new Map();

export function registerRuntime(rt, extId) {
  if (!rt || typeof rt.id !== 'string' || !rt.id) throw new Error('registerRuntime: runtime needs an id');
  if (BUILTIN_RUNTIME_IDS.includes(rt.id) || registered.has(rt.id)) {
    throw new Error(`registerRuntime: runtime id "${rt.id}" is already registered`);
  }
  registered.set(rt.id, { ...rt, extId });
}

export function unregisterRuntimesFor(extId) {
  for (const [id, rt] of registered) if (rt.extId === extId) registered.delete(id);
}

// `runtime` absent/blank ⇒ local (back-compat: every pre-runtime entry is a
// host session). An unrecognised non-empty id throws rather than defaulting to
// local — silently running on the host when a container runtime was intended
// would drop the sandbox guarantee, so fail loud instead. (Contrast adapterFor,
// which defaults to claude: a wrong *agent* is cosmetic; a wrong *runtime* is a
// safety regression.) Built-ins resolve first, so an extension can never shadow
// one even if a registration slipped past the loader.
export function runtimeFor(id) {
  const found = findRuntime(id);
  if (!found) throw new Error(`unknown runtime: ${id}`);
  return found;
}

// The non-throwing lookup, for the paths that must keep working when a card's
// runtime has gone away (its extension disabled or uninstalled): the graph tick,
// where a throw would take buildGraph down for every card, and the live-id
// write-back. Null for an unknown id; absent/blank is still local.
export function findRuntime(id) {
  if (!id) return local;
  return ALL.find((r) => r.id === id) || registered.get(id) || null;
}

// Every runtime a dispatch can name right now, for spawn_session's validation
// (and its error, which lists them). `extId` only on an extension's.
export function knownRuntimes() {
  return [
    ...ALL.map(({ id, label }) => ({ id, label })),
    ...[...registered.values()].map(({ id, label, extId }) => ({ id, label, extId })),
  ];
}

// Null when a resume or fork of this card may proceed, else the human-facing
// reason it can't — thrown by _doResume and fork BEFORE anything is torn down,
// so a refused resume never kills a pane that was still holding the card. A
// missing runtime names the extension it came from when dispatch stamped one
// (`entry.runtimeExt`), since by now the extension may be uninstalled and there
// is nothing else left to read its id off.
export function relaunchRefusal(entry) {
  const id = entry?.runtime;
  const rt = findRuntime(id);
  if (!rt) {
    return entry?.runtimeExt
      ? `This session runs on runtime "${id}", which needs the "${entry.runtimeExt}" extension. Enable it in Settings → Extensions.`
      : `This session runs on runtime "${id}", which is not available (its extension is disabled or uninstalled).`;
  }
  if (rt.resumable === false) return `"${rt.label || rt.id}" sessions can't be resumed or forked`;
  return null;
}
