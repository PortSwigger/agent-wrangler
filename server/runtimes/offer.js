import { deckRuntimes } from '../config-store.js';
import { knownRuntimes } from './index.js';

// Which runtimes this deck offers, and why one it has is unavailable. A runtime
// whose sessions run at a location is offered only when every runtime the deck
// offers is one, so a deck that runs location sessions starts nothing on its own
// machine. Settings › Sessions › "Runtimes this deck offers" (`deckRuntimes`)
// picks the runtimes; unset, the deck offers every runtime it has.

export const OFFER_SETTING = 'Settings → Sessions → Runtimes this deck offers';

let pickedSource = () => deckRuntimes();

// Test seam: the picked runtime ids without touching config.json. Null restores it.
export function setPickedRuntimesForTest(fn) {
  pickedSource = fn || (() => deckRuntimes());
}

function labelOf(r) {
  return r.label || r.id;
}

// Every runtime the deck has, `[{ id, label, agents, extId?, location, unavailable? }]`,
// in knownRuntimes' order. `unavailable` is the reason a launch on it is refused.
export function runtimeOffer({ picked = pickedSource(), known = knownRuntimes() } = {}) {
  const chosen = picked ? known.filter((r) => picked.includes(r.id)) : known;
  const here = chosen.filter((r) => !r.location);
  return known.map((r) => {
    let unavailable;
    if (!chosen.includes(r)) {
      unavailable = `This deck doesn't offer the "${labelOf(r)}" runtime (${OFFER_SETTING}).`;
    } else if (r.location && here.length) {
      unavailable = `"${labelOf(r)}" runs sessions at a location, which a deck offers only when every runtime it offers does; this one also offers ${here.map((h) => `"${labelOf(h)}"`).join(', ')}, which run on this machine. Choose its runtimes in ${OFFER_SETTING}.`;
    }
    return unavailable ? { ...r, unavailable } : { ...r };
  });
}

// True when no runtime the deck offers runs on this machine: a deck of location
// runtimes, or one whose only picked runtimes are switched off.
export function runsNothingHere(opts) {
  return !runtimeOffer(opts).some((r) => !r.location && !r.unavailable);
}

// Null when a session may launch (dispatch, resume, fork) on runtime `id`, else
// why not. An id the deck has never heard of is runtimeFor's to refuse.
export function launchRefusal(id, opts) {
  const want = id || 'local';
  return runtimeOffer(opts).find((r) => r.id === want)?.unavailable || null;
}

// Null when this deck may start a process on its own machine outside a session
// launch (a plain terminal), else why not.
export function localProcessRefusal(opts) {
  return runsNothingHere(opts)
    ? `This deck runs its sessions at a location and starts nothing on its own machine (${OFFER_SETTING}).`
    : null;
}
