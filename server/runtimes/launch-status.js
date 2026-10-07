import { findRuntime } from './index.js';

// Reading a runtime's optional `launchStatus` (contract in ./index.js). A
// runtime whose launch is a hand-off to a remote service learns whether the
// hand-off worked only after dispatch has returned, so without this a caller of
// spawn_session is told a broken card is fine.

export const LAUNCH_STATES = new Set(['pending', 'ok', 'failed', 'unknown']);
export const LAUNCH_WAIT_MS = 15_000;
const POLL_MS = 250;

// What a runtime returned, reduced to the fields a tool result may carry. An
// extension wrote it, so anything off-shape is dropped rather than echoed, and a
// throw reads as "no answer" — one broken runtime must not fail a spawn that
// already happened, or take list_sessions down for every row.
export async function readLaunchStatus(entry, { find = findRuntime } = {}) {
  if (!entry) return null;
  const runtime = find(entry.runtime);
  if (typeof runtime?.launchStatus !== 'function') return null;
  let raw;
  try {
    raw = await runtime.launchStatus({ entry });
  } catch {
    return null;
  }
  if (!raw || !LAUNCH_STATES.has(raw.state)) return null;
  const out = { state: raw.state };
  if (raw.state === 'failed') out.error = typeof raw.error === 'string' && raw.error.trim() ? raw.error.trim() : 'The launch failed.';
  if (typeof raw.url === 'string' && raw.url) out.url = raw.url;
  return out;
}

// Poll until the launch settles or `budgetMs` runs out. Null when the runtime
// has no `launchStatus` (nothing to wait for); a still-pending outcome when the
// budget ran out, so the caller can say it hasn't been decided yet.
export async function awaitLaunchStatus(entry, {
  budgetMs = LAUNCH_WAIT_MS,
  intervalMs = POLL_MS,
  now = Date.now,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  find = findRuntime,
} = {}) {
  const deadline = now() + budgetMs;
  for (;;) {
    const status = await readLaunchStatus(entry, { find });
    if (!status || status.state !== 'pending') return status;
    if (now() >= deadline) return status;
    await sleep(intervalMs);
  }
}
