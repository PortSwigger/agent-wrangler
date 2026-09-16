import { capturePane, capturePaneStyled, classify, sendKeys as defaultSendKeys } from './tmux-scraper.js';
import { paneComposerIsEmpty } from './ghost-suggestion.js';

const READY_TIMEOUT_MS = 20000;
const READY_POLL_MS = 250;
const SUBMIT_ATTEMPTS = 3;
const SUBMIT_WINDOW_MS = 2000;
const SUBMIT_POLL_MS = 300;

// Hold a paste until the freshly-relaunched agent's TUI has actually painted its
// composer — the fix for a silent, measured message loss.
//
// `resume()` only guarantees the pty was spawned, and for a short window after
// that the TUI has not taken raw mode. What happens then is specific and nasty:
// the bracketed paste IS buffered and applied to the composer, but the CR that
// `sendText` sends 120ms behind it is DROPPED, so the text sits in the composer
// unsubmitted and the agent never sees it. Measured against a real Codex pane
// (`tmux new-session` → sleep D → `paste-buffer -p` → 120ms → `send-keys Enter`):
// D=0 stranded 3/3, D=100ms stranded, D=150ms stranded 1 of 2, D=400ms submitted.
// Caught live end-to-end too: a message sent from the chat view to a dormant Codex
// card left `› PROBED-QQQQ …` sitting in the composer with the session idle, while
// the UI had already replied `ok:true, outcome:"submitted"` — and one manual Enter
// then submitted it instantly.
//
// Why Codex feels this and Claude does not: Claude's `resumeCarriesIntent` puts the
// text in the resume argv, so nothing is pasted at all. Codex's resume takes no
// prompt, so EVERY dormant Codex send goes through this paste.
//
// `paneComposerIsEmpty` is the readiness signal rather than a title/marker probe
// because it answers both questions that matter in one read — the TUI is up AND
// the composer is clear — and it is already agent-aware (it knows Codex's
// `› Ask Codex to do anything` from Claude's `❯`). `waitForPaneReady`
// (control/handlers/resume.js) cannot be reused here: it keys on Claude's OSC
// title, which Codex never sets, so it would burn its whole timeout on exactly
// the agent this exists for. Reading it needs `capture-pane -e` (capturePaneStyled)
// — the faint-text handling is the whole basis of the Claude branch.
//
// A timeout FALLS THROUGH (returns false, never throws): a late message beats a
// lost one, and a pane this cannot parse must still be deliverable. It reports
// which happened because `ensureSubmitted` below is only safe on a confirmed pane.
// Note it also reads false for a composer with text already in it; on a pane this
// process relaunched seconds ago there is nobody who could have typed there, and
// the fall-through means the worst case is the old behaviour.
export async function waitForComposerReady(name, socket, agent, {
  timeoutMs = READY_TIMEOUT_MS,
  pollMs = READY_POLL_MS,
  capture = capturePaneStyled,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  if (!name) return false;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (paneComposerIsEmpty(await capture(name, 6, socket), agent)) return true;
    if (Date.now() >= deadline) return false;
    await sleep(pollMs);
  }
}

// Confirm the send actually became a turn, and repair it with a bare Enter if not.
//
// The repair is Enter-only and must stay that way. The failure this covers leaves
// the text ALREADY in the composer, so re-pasting (what mailbox-delivery's
// pasteAndVerify does, for a different failure where the bytes were discarded
// outright) would fuse two copies into one mangled prompt. A bare Enter is a
// no-op against a composer that has emptied because the text did submit, so the
// retry cannot double-deliver either way — measured, not assumed, because the
// alternative would be burning a real turn on an empty prompt: three bare Enters
// into an idle, empty composer changed nothing at all on a live pane of EITHER
// agent (Codex `› Ask Codex to do anything` and Claude `❯ ` both unmoved, no
// turn started).
//
// `wasReady` is load-bearing: the ONLY thing making a second Enter safe is having
// seen a well-formed empty composer moments earlier, which rules out a dialog
// being on screen. Codex's self-update banner is a numbered menu that defaults to
// "Update now" on a bare Enter and takes the session down with it (see classify),
// so on a pane that was never confirmed this sends nothing at all and leaves the
// caller with exactly its previous behaviour.
//
// The signal is classify()'s working marker — the same one the board's own status
// polling uses, and confirmed present on a real Codex pane as
// `• Working (3s • esc to interrupt)`. Watch it live: that footer is redrawn in
// place, so grepping capture-pane SCROLLBACK for it is a false negative.
export async function ensureSubmitted(name, socket, {
  attempts = SUBMIT_ATTEMPTS,
  windowMs = SUBMIT_WINDOW_MS,
  pollMs = SUBMIT_POLL_MS,
  capture = capturePane,
  sendKeys = defaultSendKeys,
  wasReady = false,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  if (!name || !wasReady) return false;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await sawWorkingWithin(name, socket, capture, windowMs, pollMs, sleep)) return true;
    await sendKeys(name, ['Enter'], socket);
  }
  return sawWorkingWithin(name, socket, capture, windowMs, pollMs, sleep);
}

async function sawWorkingWithin(name, socket, capture, windowMs, pollMs, sleep) {
  const deadline = Date.now() + windowMs;
  for (;;) {
    if (classify(await capture(name, 60, socket)).status === 'working') return true;
    if (Date.now() >= deadline) return false;
    await sleep(pollMs);
  }
}
