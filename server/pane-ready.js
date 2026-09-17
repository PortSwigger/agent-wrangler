import { capturePaneStyled, classify, stripAnsi, sendKeys as defaultSendKeys } from './tmux-scraper.js';
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

// Confirm the send actually became a turn, and repair a dropped CR with a bare
// Enter — but ONLY while our own text is provably still sitting in the composer.
//
// That condition, not "we saw an empty composer before sending", is what makes
// the Enter safe, and the difference is not academic. An adversarial review
// caught the earlier `wasReady` reasoning being false across the observation
// window, and the repo's own code proves it: `paneComposerIsEmpty` deliberately
// strips FAINT runs, so a Claude composer holding nothing but a ghost suggestion
// reads as empty — while `parseGhostSuggestion`'s own note says "pressing Enter
// on it does submit it". So a turn that finished fast enough to leave a
// suggestion on screen would have had that suggestion submitted as an
// unsolicited prompt, in text neither the human nor this server wrote. (Claude
// reaches this path whenever the argv route is unavailable: a joined resume, or
// an owned one carrying images or clearComposer.) The "three bare Enters are a
// no-op" measurement behind the old comment was real but narrower than the claim
// — it was taken on a pane with no ghost suggestion.
//
// `composerHoldsText` closes that, and three other holes with it. A dialog
// (Codex's self-update menu, whose bare-Enter default is "Update now" and takes
// the session with it; or the `🔒 This conversation is open in another app`
// lock screen `classify` does not recognise) does not render our text in a
// composer, so it gets no Enter — and a `needs-you` classification stops the
// loop outright. A competing paste from another path (pane-deferral's drain, a
// mail announcement) leaves something that is not our text, so it gets no Enter
// either. And it no longer matters whether the readiness gate succeeded: if the
// text is demonstrably unsent we can repair it even when the composer marker
// itself has changed shape, which is exactly the case a styled-string readiness
// check is worst at.
//
// "Stranded" is only judged AFTER the full observation window, never on first
// sight — immediately post-`sendText` the text is legitimately in the composer
// with the original Enter still in flight, and pressing again there is how you
// would race the TUI into two turns of the same prompt.
//
// Returns true only on a CONFIRMED turn (classify()'s working marker, present on
// a real Codex pane as `• Working (3s • esc to interrupt)` — watch it live, the
// footer is redrawn in place so scrollback greps come back empty). An
// empty composer is deliberately NOT treated as proof of submission: pre-paste
// and post-submit look identical, so inferring success there would manufacture
// exactly the false "delivered" this whole change exists to remove. Everything
// else is false, and the caller reports that as an UNKNOWN outcome rather than
// success.
export async function ensureSubmitted(name, socket, {
  text = '',
  agent = 'claude',
  attempts = SUBMIT_ATTEMPTS,
  windowMs = SUBMIT_WINDOW_MS,
  pollMs = SUBMIT_POLL_MS,
  capture = capturePaneStyled,
  sendKeys = defaultSendKeys,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  if (!name) return false;
  for (let attempt = 0; ; attempt += 1) {
    const seen = await watchPane(name, socket, capture, windowMs, pollMs, sleep);
    if (seen === 'working') return true;
    if (seen === 'blocked' || attempt >= attempts) return false;
    if (!composerHoldsText(await capture(name, 8, socket), agent, text)) return false;
    await sendKeys(name, ['Enter'], socket);
  }
}

// 'working' (a turn is running), 'blocked' (a dialog is up — hands off), or
// 'idle' once the window closes with neither.
async function watchPane(name, socket, capture, windowMs, pollMs, sleep) {
  const deadline = Date.now() + windowMs;
  for (;;) {
    const { status } = classify(await capture(name, 60, socket));
    if (status === 'working') return 'working';
    if (status === 'needs-you') return 'blocked';
    if (Date.now() >= deadline) return 'idle';
    await sleep(pollMs);
  }
}

// Whether the composer still holds the text we pasted. Keyed on the agent's
// prompt MARK rather than the whole styled empty-composer string, because the
// mark is the stable part; and on the LAST marked line, because a submitted turn
// is echoed back into the scrollback with the same mark (measured — the echo is
// why "the text appears with a prompt mark" cannot be the test). A leading slice
// of the first line is the probe: the composer wraps a long prompt, so only its
// start is reliably on that line. Fails safe to false — a pane it cannot parse
// earns no keystrokes.
export function composerHoldsText(paneText, agent = 'claude', text = '') {
  if (typeof paneText !== 'string' || !paneText) return false;
  const probe = String(text).split('\n')[0].trim().slice(0, 40);
  if (!probe) return false;
  const mark = agent === 'codex' ? '\u203a' : '\u276f';
  const line = stripAnsi(paneText).split('\n').filter((l) => l.includes(mark)).pop();
  return Boolean(line) && line.includes(probe);
}
