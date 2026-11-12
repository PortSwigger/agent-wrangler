import crypto from 'node:crypto';
import { stripPastedContentWrapper } from './pasted-content.js';

// Where each prompt the wrangler itself put in front of an agent came from, so
// core telemetry can tell a transcript's user turn the wrangler sent (a chat
// composer send, a dispatch, mail, an extension's delivery) from one a human
// typed straight into the terminal. Every send notes the text's hash and its
// source here; when the transcript later shows a user turn, `take` returns the
// source of a matching send, and no match means the terminal.
//
// Holds a hash of the normalised text, never the text, in memory only, for
// TTL_MS. A LEAF (only pasted-content.js), so tmux-scraper can note its sends.

export const TTL_MS = 10 * 60 * 1000;
const MAX = 500;
// A fallback note (a raw pane paste) is skipped when a caller named the same
// text's source this recently: deliverMessage notes `composer`, then pastes.
const FALLBACK_SHADOW_MS = 30 * 1000;

const entries = [];

// What the transcript will show for this text: the pasted-content wrapper
// stripped (the chat scanner strips it too), whitespace collapsed, capped.
function keyOf(text) {
  if (typeof text !== 'string') return null;
  const norm = stripPastedContentWrapper(text).replace(/\s+/g, ' ').trim().slice(0, 2000);
  return norm ? crypto.createHash('sha256').update(norm).digest('hex') : null;
}

function prune(now) {
  while (entries.length && (now - entries[0].at > TTL_MS || entries.length > MAX)) entries.shift();
}

// `fallback`: only note when no caller noted this text recently (see above).
export function notePrompt(text, source, { now = Date.now(), fallback = false } = {}) {
  const hash = keyOf(text);
  if (!hash || typeof source !== 'string') return;
  prune(now);
  if (fallback && entries.some((e) => e.hash === hash && now - e.at <= FALLBACK_SHADOW_MS)) return;
  entries.push({ hash, source, fallback, pasted: typeof text === 'string' && text.includes('<pasted_content id="'), at: now });
}

// The source of the oldest unclaimed send of this text, consumed so the same
// text sent twice matches twice. Null when the wrangler did not send it.
export function takePrompt(text, { now = Date.now() } = {}) {
  const hash = keyOf(text);
  if (!hash) return null;
  prune(now);
  // A named note beats a fallback one for the same send (a fallback noted
  // first, then the caller's own).
  let i = entries.findIndex((e) => e.hash === hash && !e.fallback);
  if (i < 0) i = entries.findIndex((e) => e.hash === hash);
  if (i < 0) return null;
  const [hit] = entries.splice(i, 1);
  // The fallback notes of that same send.
  for (let j = entries.length - 1; j >= 0; j -= 1) {
    if (entries[j].hash === hash && entries[j].fallback && Math.abs(entries[j].at - hit.at) <= FALLBACK_SHADOW_MS) entries.splice(j, 1);
  }
  return { source: hit.source, pasted: hit.pasted };
}

// A delivery's `reason` (deliverMessage, resume) to a prompt source: a human
// pressing send is `composer`, an extension's delivery `extension`, a schedule
// `schedule`, and every other wrangler notice (mail, status notices, PR nudges)
// `mail`.
export function promptSourceForReason(reason) {
  if (reason === 'message') return 'composer';
  if (reason === 'schedule') return 'schedule';
  if (typeof reason === 'string' && reason.startsWith('ext:')) return 'extension';
  if (reason === 'extension') return 'extension';
  return 'mail';
}

export function _resetPromptLedgerForTest() {
  entries.length = 0;
}
