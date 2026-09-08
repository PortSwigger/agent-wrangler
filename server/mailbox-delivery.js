import fs from 'node:fs';
import os from 'node:os';
import { resolveResumeDir } from './transcript-reader.js';
import { sendText as defaultSendText, capturePane as defaultCapturePane, classify as defaultClassify } from './tmux-scraper.js';
import { mcpSeenAt as defaultMcpSeenAt } from './mcp-activity.js';

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
// Returns { mode: 'live' | 'dormant' | 'skip' } or { mode: 'error', error }.
// 'skip' = archived or gone (never resume it — resurrection-by-mail is the one
// outcome this must not produce). Only 'dormant' warrants the caller's
// rebuild(); 'error' means delivery failed and carries the failure message —
// Phase 1 has no deliveryFailed state to store it in (see mailbox-store's
// unreadInfo fallback + reopenSettle), but the caller (mail-runner.js) still
// needs the real message to log, not just "undefined".
export async function deliverMailNotification(to, text, deps) {
  const { tmuxFor, socketFor, sessionManager, memoryStore, taskStore } = deps;
  const sendText = deps.sendText ?? defaultSendText;
  const capturePane = deps.capturePane ?? defaultCapturePane;
  const classify = deps.classify ?? defaultClassify;
  const verifyDelayMs = deps.pasteVerifyDelayMs ?? PASTE_VERIFY_DELAY_MS;
  const verifyPollMs = deps.pasteVerifyPollMs ?? PASTE_VERIFY_POLL_MS;
  const mcpSeenAt = deps.mcpSeenAt ?? defaultMcpSeenAt;
  const mcpReadyTimeoutMs = deps.mcpReadyTimeoutMs ?? MCP_READY_TIMEOUT_MS;
  const mcpReadyPollMs = deps.mcpReadyPollMs ?? MCP_READY_POLL_MS;

  const target = tmuxFor(to);
  if (target) {
    // The spec requires the archivedAt re-check "immediately before waking OR
    // NOTIFYING" — this is the notifying half. `lastGraph` (tmuxFor's source)
    // rebuilds only every ~4s, slower than the mail sweep's 2s cadence, so a
    // card archived (and killed) inside that window can still resolve a tmux
    // target here without this check, pasting into a dead pane instead of
    // marking the mail undeliverable.
    const entry = sessionManager.entryFor(to);
    if (entry?.archivedAt) return { mode: 'skip' };
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

  // The relaunch boots IDLE — deliberately no `intent`, for either agent. Claude's
  // resumeCarriesIntent would put the notice in the launch argv (`claude --resume …
  // -- <notice>`), which is faster and lands unconditionally, and that is exactly
  // the bug: it auto-submits a turn at process BOOT, before the new process's MCP
  // client has connected. Claude Code fixes a turn's tool list at turn start and
  // hands a resumed process a deferred_tools_delta REMOVING every MCP tool, without
  // the "servers are still connecting, they'll appear shortly" system-reminder a
  // fresh start gets — so the session we woke SPECIFICALLY to read its mail cannot
  // call read_mail, and reasonably reports every MCP server as dropped. Measured on
  // a real transcript: two wakes, two wasted turns, two false "all MCP servers
  // dropped" alarms, servers healthy within ~3s both times. `resumeCarriesIntent`
  // is still a true statement about buildResume (a scheduled resume's prompt rides
  // it fine) — it's this notification-driven use of it that was wrong, so the
  // change is here and not on the adapter.
  //
  // `owned` is read SYNCHRONOUSLY right before resume() (the same trick
  // deliverPrNudge uses, and race-free for the same reason: resume() registers
  // its coalescing slot before its own first await). It decides whether the
  // MCP-readiness gate below applies at all: a JOINED resume was launched by
  // someone else, possibly seconds earlier, so its process may already have
  // connected BEFORE our `since` — the gate could then never open and would burn
  // its whole timeout inside a sweep that serializes every other dormant
  // recipient behind it. Joining already meant an immediate paste before the gate
  // existed, so skipping it there leaves that path exactly as it was.
  const owned = !sessionManager.isResuming(to);
  const since = Date.now();
  try {
    const res = await sessionManager.resume(to, dir);
    const tmux = res?.tmux ?? tmuxFor(to);
    const socket = sessionManager.entryFor(to)?.socket ?? '';
    if (!tmux) return { mode: 'error', error: 'resume produced no live pane to deliver the mail notification into' };
    // Then hold the paste until the woken process has connected its MCP client
    // back to us, so the turn the paste starts genuinely has read_mail in its
    // tool list. pasteAndVerify below is NOT a substitute for this gate: its
    // signal is classify()'s "working" marker, i.e. the turn has ALREADY
    // started, so it only moves turn start from process boot to TUI raw-mode
    // init — still pre-MCP.
    if (owned) await waitForMcpReady(to, since, mcpSeenAt, mcpReadyTimeoutMs, mcpReadyPollMs);
    // A freshly-resumed pane's TUI can take several seconds to actually become
    // interactive (loading MCP servers/skills/memory) — resume() only guarantees
    // the pty was spawned, not that its input loop is reading yet. Confirmed live
    // against Codex: a paste sent right after resume() is silently discarded (the
    // TUI flushes buffered stdin on its own raw-mode init), not merely delayed, so
    // waiting longer before ONE paste doesn't help — repaste-and-verify does.
    const landed = await pasteAndVerify(tmux, text, socket, sendText, capturePane, classify, verifyDelayMs, verifyPollMs);
    if (!landed) return { mode: 'error', error: 'notification paste did not land in the freshly-resumed pane (agent may still be starting up)' };
  } catch (err) {
    return { mode: 'error', error: err?.message || String(err) };
  }
  return { mode: 'dormant' };
}

// Today's only live transport: paste into the pane. The swap point for a live
// Claude session to instead use Claude Code's SendMessage socket (deferred past
// Phase 1 — see the spec's "Claude Code cross-session messaging" section).
function liveTransport(tmux, text, socket, sendText) {
  return sendText(tmux, text, socket);
}

const MCP_READY_TIMEOUT_MS = 15000;
const MCP_READY_POLL_MS = 250;

// Wait until this card's MCP client has spoken to /mcp AFTER `since` — i.e. the
// process we just launched has connected, not the dead one it replaced (a bare
// "has this card ever connected" would answer yes for any card that was live an
// hour ago). Bounded, and a timeout FALLS THROUGH to the paste: a session whose
// client never reports (an entry launched before this server learned to record
// it, a broken /mcp) must still get its mail — a late notification beats a lost
// one. The dormant path has no live pane and therefore no live process, so
// there's nothing still running that could stamp a false positive here.
async function waitForMcpReady(cardId, since, mcpSeenAt, timeoutMs, pollMs) {
  const deadline = Date.now() + timeoutMs;
  do {
    if (mcpSeenAt(cardId) > since) return true;
    await new Promise((r) => setTimeout(r, pollMs));
  } while (Date.now() < deadline);
  return false;
}

const PASTE_VERIFY_ATTEMPTS = 5;
const PASTE_VERIFY_DELAY_MS = 1500;
const PASTE_VERIFY_POLL_MS = 300;

// Paste, then confirm the agent actually READ it before trusting it — re-pasting
// (not just re-checking) on each attempt, since a not-yet-ready TUI DISCARDS the
// bytes rather than queuing them; a later attempt only succeeds because IT lands
// after the TUI is ready, not because an earlier one was replayed.
//
// The signal is `classify()`'s "esc to interrupt" working marker (the same one
// the board's own status polling uses), NOT a plain substring check on the pane —
// confirmed live against Codex that a substring check false-positives: a
// freshly-resumed pane is briefly in the terminal's default cooked/echo mode
// before the TUI grabs raw mode, so the pasted bytes appear on screen (as a plain
// terminal echo) well before anything has actually read them, then vanish
// un-actioned under the TUI's own redraw once it does boot. A transition into
// "working" can only happen if the TUI genuinely picked the input up as a turn.
// `delayMs`/`pollMs` are test seams (real callers get the module constants) — a
// "never lands" case would otherwise cost the real multi-second delay per attempt.
async function pasteAndVerify(tmux, text, socket, sendText, capturePane, classify, delayMs, pollMs) {
  for (let attempt = 0; attempt < PASTE_VERIFY_ATTEMPTS; attempt += 1) {
    await sendText(tmux, text, socket);
    if (await sawWorkingWithin(tmux, socket, capturePane, classify, delayMs, pollMs)) return true;
  }
  return false;
}

async function sawWorkingWithin(tmux, socket, capturePane, classify, delayMs, pollMs) {
  const deadline = Date.now() + delayMs;
  do {
    const pane = await capturePane(tmux, 60, socket);
    if (classify(pane).status === 'working') return true;
    await new Promise((r) => setTimeout(r, pollMs));
  } while (Date.now() < deadline);
  return false;
}
