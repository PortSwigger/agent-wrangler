import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { capturePane } from './tmux-scraper.js';
import { parseCloudLaunchLog } from './runtimes/cloud.js';
import { recordAttachRefusal, recordAttachSuccess } from './cloud-attach.js';

// Post-launch scrape of a cloud pane's output, so a card can learn its
// `session_…` id and claude.ai URL — the CLI prints them and nothing else tells
// us. Deliberately fire-and-forget: `dispatch` must return as fast as any other
// dispatch, so this is started and NOT awaited, and every failure is swallowed
// and logged. A failed scrape leaves a cloud card with a null `cloud.sessionId`
// (no steering, no link chip) — annoying, but it must never fail a launch that
// really did create a cloud session.
//
// TWO SOURCES, on purpose:
//   - `pipe-pane` gives RAW bytes, so a `View:` URL that a narrow pane wrapped
//     across two rows arrives intact. `capture-pane` would hand back the wrapped,
//     re-rendered text and corrupt exactly the one string we need as an href.
//   - but `pipe-pane` is issued a beat AFTER `new-session` starts the command, so
//     in principle the first bytes could land before the pipe exists. A cloud
//     create takes seconds to print anything, so in practice the pipe wins; the
//     `capture-pane` fallback covers the pathological fast case, and it is viable
//     at all only because `_newSession` already sets `remain-on-exit` (the exited
//     create pane, and its scrollback, are still there to capture).

const POLL_MS = 500;
const DEADLINE_MS = 120_000;

// Read the pipe-pane log if it exists. Missing/unreadable is normal (the pane may
// not have written a byte yet) and reads as empty, so the caller just polls again.
async function readLogFile(logPath) {
  try {
    return await fsp.readFile(logPath, 'utf8');
  } catch {
    return '';
  }
}

// Keep DATA_DIR/cloud-launch-logs from growing without bound: on each write drop
// logs older than a week. Same prune-on-write shape as launch-script.js's
// pruneStale — no timer, no separate sweeper, and a dir that was never used costs
// nothing. Best-effort: a prune failure must not stop a launch.
export function pruneCloudLaunchLogs(dir, { maxAgeMs = 7 * 24 * 60 * 60 * 1000, now = Date.now() } = {}) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    const p = path.join(dir, name);
    try {
      if (now - fs.statSync(p).mtimeMs > maxAgeMs) {
        fs.rmSync(p, { force: true });
        removed += 1;
      }
    } catch {
      /* raced with another prune, or not ours to delete */
    }
  }
  return removed;
}

// Poll until the launch log yields a cloud session id (or the refusal line, or the
// deadline). Resolves with what it found so a test can assert it; production
// ignores the value. `sessionManager` is passed in rather than imported — this
// module is reached through the `this._cloudLaunch` instance seam, so it must not
// import back into the manager.
// `mode` picks which question this watch is answering:
//   'create' — scrape the new session's id/URL (dispatch).
//   'attach' — there is nothing to scrape (the card already knows its id); the
//     watch exists purely to read the attach gate's answer off the pane. It cannot
//     return early on a session id (the attach echoes one), because the refusal
//     line may come after it — and the ONLY positive evidence attach works is the
//     ABSENCE of that line, so a clean run to the deadline is what clears the flag.
export async function watchCloudLaunch({
  sessionManager, sessionId, tmux, socket = '', logPath, mode = 'create',
  capture = capturePane, readLog = readLogFile,
  onAttachRefusal = recordAttachRefusal, onAttachSuccess = recordAttachSuccess,
  pollMs = POLL_MS, deadlineMs = DEADLINE_MS, now = Date.now,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  const started = now();
  let sawCreated = false;
  while (now() - started < deadlineMs) {
    let text = logPath ? await readLog(logPath) : '';
    // Only fall back when the pipe has nothing yet — a live pipe is strictly the
    // better source, and capture-pane's re-rendered text could otherwise clobber
    // an intact URL the pipe already has.
    if (!text && tmux) text = await capture(tmux, 400, socket).catch(() => '');
    const parsed = parseCloudLaunchLog(text);
    sawCreated = sawCreated || parsed.sawCreated;
    // The ONE producer of the attach-gate signal. A create never prints this line;
    // only an attach attempt does, which is why seeing it is worth persisting.
    if (parsed.attachRefused) {
      try {
        onAttachRefusal();
      } catch (e) {
        console.error('[cloud] recording the attach refusal failed:', e?.message || e);
      }
      return { ...parsed, sawCreated };
    }
    if (parsed.cloudSessionId && mode === 'create') {
      try {
        sessionManager?.noteCloudSession?.(sessionId, {
          cloudSessionId: parsed.cloudSessionId,
          url: parsed.url,
        });
      } catch (e) {
        console.error('[cloud] recording the cloud session id failed:', e?.message || e);
      }
      return { ...parsed, sawCreated };
    }
    // The CLI printed its own reason the create failed outright (e.g. no
    // parseable git source on a BYOC pool) and exited — nothing more will ever
    // appear in this pane, so stop polling now rather than riding out the
    // deadline. Persisting it is what lets the card surface WHY instead of
    // sitting forever with a null sessionId and a silent "☁ starting…" chip.
    if (parsed.createError && mode === 'create') {
      try {
        sessionManager?.noteCloudCreateError?.(sessionId, parsed.createError);
      } catch (e) {
        console.error('[cloud] recording the cloud create error failed:', e?.message || e);
      }
      return { ...parsed, sawCreated };
    }
    await sleep(pollMs);
  }
  // An attach that ran the whole window without the refusal line is the only
  // positive evidence the gate can ever get, so clear the sticky flag. Deliberately
  // dumb rather than clever (the detection is evidence-poor by nature — see
  // cloud-attach.js); the config override is how a human settles it.
  if (mode === 'attach') {
    try {
      onAttachSuccess();
    } catch (e) {
      console.error('[cloud] clearing the attach refusal failed:', e?.message || e);
    }
    return { cloudSessionId: null, url: null, attachRefused: false, sawCreated };
  }
  // Timed out. `sawCreated` separates "the session exists but its id never made it
  // into the log" (worth logging loudly — the human can still find it on
  // claude.ai) from "nothing happened", which is the ordinary failed-launch case
  // the dead pane already shows.
  if (sawCreated) {
    console.error(`[cloud] created a cloud session for ${sessionId} but never scraped its session_… id from ${tmux}`);
  }
  return { cloudSessionId: null, url: null, attachRefused: false, sawCreated };
}
