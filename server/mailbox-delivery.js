import fs from 'node:fs';
import os from 'node:os';
import { resolveResumeDir } from './transcript-reader.js';
import { sendText as defaultSendText } from './tmux-scraper.js';
import { adapterFor } from './agents/index.js';

// Settle-close delivery leg for the mailbox — paste a server-authored
// notification into the recipient's pane, waking it first if dormant.
//
// This DELIBERATELY reimplements message-delivery.js's dormant-wake guard rather
// than calling deliverMessage: peer mail no longer flows through it, so nothing
// carries the guarantees over for free (CLAUDE.md — the mail runner must
// reimplement the archive-race guard, not inherit it). Every piece below mirrors
// deliverMessage/deliverPrNudge line for line:
//   - resolveResumeDir by the LIVE id (a modern transcript is bucketed under
//     entry.liveSessionId, never the card id);
//   - memory bind before the relaunch;
//   - a SYNCHRONOUS commit block — no await between the fresh archivedAt
//     re-check and resume() — so the awaits above can never straddle a
//     concurrent archive and resurrect a session that left the board.
//
// The seam the spec asks for: which leg handles a LIVE recipient is chosen by
// agent below (`liveTransport`), so a future per-agent transport swap (Claude's
// tmux paste -> the SendMessage socket) touches only that one branch — today
// both live Claude and live Codex use the same tmux paste, so the branch is a
// no-op until that swap lands.
// Returns { mode: 'live' | 'dormant' | 'skip' | 'error' }. 'skip' = archived or
// gone (never resume it — resurrection-by-mail is the one outcome this must not
// produce). Only 'dormant' warrants the caller's rebuild(); 'error' means the
// resume failed and no notification could be delivered (Phase 1 has no
// deliveryFailed tracking — see mailbox-store's unreadInfo fallback).
export async function deliverMailNotification(to, text, deps) {
  const { tmuxFor, socketFor, sessionManager, memoryStore, taskStore } = deps;
  const sendText = deps.sendText ?? defaultSendText;

  const target = tmuxFor(to);
  if (target) {
    await liveTransport(target, text, socketFor(to), sendText);
    return { mode: 'live' };
  }

  const entry = sessionManager.entryFor(to);
  if (!entry || entry.archivedAt) return { mode: 'skip' };

  let dir = await resolveResumeDir(entry.liveSessionId || to, { entryCwd: entry.cwd });
  if (!dir || !fs.existsSync(dir)) {
    try { fs.mkdirSync(dir, { recursive: true }); } catch { dir = os.homedir(); }
  }
  memoryStore.bindSession(to, taskStore.taskFor(to)?.id || null);

  // ---- SYNCHRONOUS COMMIT BLOCK: no await between this re-check and resume(). ----
  const fresh = sessionManager.entryFor(to);
  if (!fresh || fresh.archivedAt) return { mode: 'skip' };

  const owned = !sessionManager.isResuming(to);
  const intentCarriesNotification = owned && adapterFor(fresh.agent).resumeCarriesIntent;
  try {
    const res = await sessionManager.resume(to, dir, { intent: text });
    if (!intentCarriesNotification) {
      const tmux = res?.tmux ?? tmuxFor(to);
      const socket = sessionManager.entryFor(to)?.socket ?? '';
      if (tmux) await liveTransport(tmux, text, socket, sendText);
      else return { mode: 'error' };
    }
  } catch {
    return { mode: 'error' };
  }
  return { mode: 'dormant' };
}

// Today's only live transport: paste into the pane. The swap point for a live
// Claude session to instead use Claude Code's SendMessage socket (deferred past
// Phase 1 — see the spec's "Claude Code cross-session messaging" section).
function liveTransport(tmux, text, socket, sendText) {
  return sendText(tmux, text, socket);
}
