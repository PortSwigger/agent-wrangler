import path from 'node:path';
import { getExtensions } from './extensions/index.js';
import { logError } from './log.js';

// The `session.launchContext` seam: what a session's launch needs from the
// extensions that are on. Each enabled extension's `hooks['session.launchContext']`
// is asked, per launch, and answers `{ env?, addDirs? }`:
//   env     — extra environment variables for the agent process (task-memory's
//             AW_TASK_MEMORY). Names must be UPPER_SNAKE (they are written into a
//             shell command line); values are strings and are quoted by the
//             adapter. Core's own variables are written AFTER these, so an
//             extension can never override AW_SESSION_ID and friends.
//   addDirs — extra directories the agent is granted (`--add-dir`), absolute.
// The hook may be async and may do work (task-memory binds the session's
// by-session symlink here), so callers AWAIT collectLaunchContext before they
// build the launch command. Reasons a launch asks:
//   dispatch | resume | fork | message | snooze-wake | spawn | assign | adopt
// `assign` and `adopt` are not launches (a running session was re-pointed, or
// the server adopted it at boot); the hook still runs so side effects land and
// the caller discards the result.
//
// A hook that throws, or answers something unusable, is logged and skipped:
// one broken extension must not keep a session from launching.
export const LAUNCH_REASONS = ['dispatch', 'resume', 'fork', 'message', 'snooze-wake', 'spawn', 'assign', 'adopt'];

export const EMPTY_LAUNCH_CONTEXT = Object.freeze({ env: Object.freeze({}), addDirs: Object.freeze([]) });

const ENV_NAME_RE = /^[A-Z][A-Z0-9_]*$/;

// sid -> the last context collected for it. Not for launches (those always
// re-collect) but for the few synchronous readers that need to know which
// directories the agent was granted — paste-store.js, which drops pasted images
// somewhere the agent can already read.
const lastBySession = new Map();

export function lastLaunchContext(sid) {
  return lastBySession.get(sid) || EMPTY_LAUNCH_CONTEXT;
}

export function _resetLaunchContextForTests() {
  lastBySession.clear();
}

export async function collectLaunchContext(
  { sid, task = null, agent = 'claude', runtime = 'local', reason = 'dispatch' } = {},
  { ext = getExtensions(), hostApiFor = () => undefined, onError = logError } = {},
) {
  const env = {};
  const envOwner = {};
  const addDirs = [];
  for (const { extId, fn } of ext.hooks?.['session.launchContext'] || []) {
    let out;
    try {
      out = await fn({ sid, task, agent, runtime, reason, host: hostApiFor(extId) });
    } catch (err) {
      onError(`[ext:${extId}] session.launchContext failed — skipped`, err);
      continue;
    }
    if (out == null) continue;
    if (typeof out !== 'object' || Array.isArray(out)) {
      onError(`[ext:${extId}] session.launchContext must return { env?, addDirs? } — ignored`);
      continue;
    }
    for (const [k, v] of Object.entries(out.env || {})) {
      if (!ENV_NAME_RE.test(k) || typeof v !== 'string') {
        onError(`[ext:${extId}] session.launchContext env ${JSON.stringify(k)} dropped (name must match ${ENV_NAME_RE}, value must be a string)`);
        continue;
      }
      if (Object.hasOwn(env, k)) onError(`[launch-context] env ${k} set by ${envOwner[k]} and ${extId}; ${extId} wins`);
      env[k] = v;
      envOwner[k] = extId;
    }
    for (const d of Array.isArray(out.addDirs) ? out.addDirs : []) {
      if (typeof d !== 'string' || !path.isAbsolute(d)) {
        onError(`[ext:${extId}] session.launchContext addDir ${JSON.stringify(d)} dropped (must be an absolute path)`);
        continue;
      }
      if (!addDirs.includes(d)) addDirs.push(d);
    }
  }
  const result = { env, addDirs };
  if (sid) lastBySession.set(sid, result);
  return result;
}

// The adapters' shared reading of a context: tolerant of a launch that passes
// none (a direct caller or a test), so every builder spells the default once.
export function launchEnvOf(launchContext) {
  return launchContext?.env && typeof launchContext.env === 'object' ? launchContext.env : {};
}

export function launchAddDirsOf(launchContext) {
  return Array.isArray(launchContext?.addDirs) ? launchContext.addDirs : [];
}

// `K='v' K2='v2' ` — the env assignments a launch command line is prefixed with
// (trailing space included, empty string when there are none). `quote` is the
// adapter's own shellQuote, passed in so this module does not import the agents.
export function launchEnvPrefix(launchContext, quote) {
  return Object.entries(launchEnvOf(launchContext)).map(([k, v]) => `${k}=${quote(v)} `).join('');
}

// `--add-dir <d>` pairs for each directory the extensions granted.
export function launchAddDirArgs(launchContext) {
  return launchAddDirsOf(launchContext).flatMap((d) => ['--add-dir', d]);
}
