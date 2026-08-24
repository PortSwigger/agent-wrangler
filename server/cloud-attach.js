import { readConfig, writeConfig } from './config-store.js';

// The attach gate: ONE question ("can this account attach a local pane to a
// running cloud session?"), ONE answer, in one module. Interactive attach is not
// enabled for every account yet, and the day it is, flipping it on is a single
// config flag — which only works if nothing else in the codebase forms its own
// opinion.
//
// EXACTLY THREE CALLERS ask, and no other speculative attach behaviour exists
// anywhere:
//   1. `_doResume`'s cloud branch (session-manager.js) — refuses with
//      CLOUD_ATTACH_UNSUPPORTED_MSG, or builds `claude --cloud <session_…>`.
//   2. the client's Terminal-button greying, via the graph-level
//      `cloudAttachSupported` field.
//   3. the launch watcher (cloud-launch-watch.js), which calls
//      `recordAttachRefusal()` when it sees the CLI's refusal line on an ATTACH
//      pane, and `recordAttachSuccess()` when an attach runs its whole watch window
//      without printing it (the only positive evidence there is).
// Everything else that needs the answer — the two message-delivery paths, the
// client's Terminal greying — reads it off the graph-level `cloudAttachSupported`
// field, i.e. consumes caller 2's published answer rather than forming its own.
// `cloud-attach.test.js` enforces that with an allowlist over the server/ and
// public/ trees, so a fourth importer fails the suite loudly rather than quietly
// growing a second answer.
export const CLOUD_ATTACH_UNSUPPORTED_MSG = "Attaching to a cloud session isn't enabled for this account yet — open it on claude.ai, or Teleport it to a local worktree.";

// In-process memo of a refusal observed by THIS server, so the gate is answered
// correctly for the rest of the process even if the config write lost a race or
// failed outright. Cleared by a successful attach, alongside the persisted flag.
let refusedInProcess = false;

// Precedence: an explicit `cloudAttach` boolean in config.json ALWAYS wins — that
// is the rollout lever, and it is also how a human settles a question the
// auto-detect is structurally bad at answering (the only positive evidence
// available is the *absence* of a refusal string, so detection can only ever prove
// the negative). Otherwise the sticky recorded refusal answers it. Otherwise
// unknown, which means unsupported: assuming supported would build
// `claude --cloud <id>` into a pane and leave the human staring at a dead card.
//
// The last two branches both return false today. They are kept distinct on purpose:
// "we have recorded evidence that attach is refused" and "we have no evidence
// either way" are different states, and the day attach ships generally it is only
// the final line that changes.
export function cloudAttachSupported(cfg = readConfig()) {
  if (typeof cfg?.cloudAttach === 'boolean') return cfg.cloudAttach;
  if (refusedInProcess) return false;
  if (cfg?.cloudAttachRefusedAt) return false;
  return false;
}

// Called ONLY from the launch-log parse, on the CLI's literal refusal line. Sticky
// and idempotent: once the timestamp is on disk it is not rewritten, so repeated
// refusals don't churn config.json. Deps are injectable because `node --test` runs
// files in parallel against the developer's REAL ~/.agent-wrangler — no test may
// write the shared config.json.
export function recordAttachRefusal({ read = readConfig, write = writeConfig, now = Date.now } = {}) {
  refusedInProcess = true;
  if (read()?.cloudAttachRefusedAt) return false;
  write({ cloudAttachRefusedAt: now() });
  return true;
}

// The counterpart: an attach that produced no refusal line is the only positive
// evidence there is, so clear the sticky flag (and the memo) rather than leaving a
// stale "refused" answer standing after the account gains the feature.
export function recordAttachSuccess({ read = readConfig, write = writeConfig } = {}) {
  refusedInProcess = false;
  if (!read()?.cloudAttachRefusedAt) return false;
  write({ cloudAttachRefusedAt: null });
  return true;
}
