import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { shellQuote, withCleanClaudeEnv } from './agents/claude.js';

const execFileAsync = promisify(execFile);

// The ONLY module in the codebase that shells out to steer a cloud session. A
// cloud card has no local pane to paste into (and while attach is off, the pane
// it does have is the already-exiting create pane), so a message has to be
// handed to the cloud session through the CLI instead.
//
// Both delivery paths call in here — message-delivery.js (a human typing into a
// card, and send_message's legacy direct push) and mailbox-delivery.js (peer
// mail). That is a shared shell-out leaf, NOT a unification of the two delivery
// paths: they keep their own routing, guards and return shapes, exactly as
// CLAUDE.md requires (mailbox vs direct-push are meant to diverge).

// Steer an existing cloud session: `claude -p <text> --cloud <session_…>
// --output-format json`. `-p` next to `--cloud` is only a footgun when --cloud
// carries a *description* (it then silently runs LOCALLY — see
// assertNoPromptWithCloudDescription in runtimes/cloud.js); with a `session_…`
// id it is the documented steer form.
// -> { ok: true } | { ok: false, archived, error }
export async function sendCloudMessage({ cloudSessionId, text, run = execFileAsync }) {
  if (!cloudSessionId) {
    // The id is scraped from the create pane's log a few seconds after dispatch,
    // so a message aimed at a brand-new card can genuinely arrive before it.
    return failure('This cloud session has no session id captured yet — try again once the card shows its cloud link.');
  }
  const cmd = withCleanClaudeEnv(
    `claude -p ${shellQuote(text)} --cloud ${shellQuote(cloudSessionId)} --output-format json`,
  );

  let stdout = '';
  try {
    // withCleanClaudeEnv returns a shell STRING (`env -u CLAUDECODE … claude …`),
    // so it has to run through a shell — `run` is a promisified execFile and
    // would otherwise try to exec a binary literally named "env -u …".
    const res = await run('sh', ['-lc', cmd]);
    stdout = String(res?.stdout ?? '');
  } catch (err) {
    // execFile rejects on a non-zero exit but still carries the captured
    // streams, and the CLI's refusal text (archived session, bad id, auth) is in
    // them — read those before falling back to the bare spawn error.
    const captured = [String(err?.stderr ?? ''), String(err?.stdout ?? '')].join('\n').trim();
    return failure(captured || err?.message || String(err));
  }

  const errText = errorTextFrom(stdout);
  if (errText) return failure(errText);
  // Exit 0 with unparseable stdout still means the CLI accepted the steer; the
  // message is in the cloud session's queue either way, so don't invent a
  // failure the human would have to guess at.
  return { ok: true };
}

// `archived` is a best-effort match on CLI text this change never probed (plan
// §17 open question 4): the exact wording for steering an archived cloud session
// is unknown, so match generously and case-insensitively. Failure mode of a miss
// is small and visible — the human gets a plain error toast instead of the card
// being marked archived — never a wrong delivery.
function failure(error) {
  return { ok: false, archived: /archiv/i.test(error), error };
}

// `--output-format json` prints one result object; treat an explicit error shape
// as a failure and everything else as accepted.
function errorTextFrom(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) return '';
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return '';
  }
  if (!parsed || typeof parsed !== 'object') return '';
  const errored = parsed.is_error === true
    || Boolean(parsed.error)
    || (typeof parsed.subtype === 'string' && parsed.subtype !== 'success' && parsed.is_error !== false);
  if (!errored) return '';
  return String(parsed.error || parsed.result || parsed.message || parsed.subtype || 'cloud steer failed');
}

// Does a message to this card go to the cloud rather than into a pane? Pure so
// both delivery paths can be tested without a tmux or a CLI.
//
// ORDERING IS THE POINT: a naive "live pane first" route would paste into the
// cloud CREATE pane, which is alive for the first seconds of the card's life and
// then exits — the message would land in a dying pane and be lost. So a cloud
// card only loses the steer route once there is a pane we could actually attach
// to, i.e. the attach gate is on AND a pane exists (from then on the card
// behaves like any other live card).
export function cloudSteerWins({ entry, tmux, attachSupported }) {
  if (entry?.runtime !== 'cloud') return false;
  return !(tmux && attachSupported);
}
