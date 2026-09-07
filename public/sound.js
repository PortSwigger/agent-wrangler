// Audible cues for board events, synthesized with WebAudio rather than shipped
// as an audio file: a cue is three numbers per note here, versus a binary blob
// to vendor, fetch and cache-bust. Two cues, deliberately distinguishable
// without being told which is which — a rising two-note chime when a session
// FINISHES (working → idle) and a lower double-beep on one pitch when a session
// starts WAITING on you (needs-you).
//
// Opt-in and per-browser: the `soundOnFinish` setting gates both call sites in
// app.js, which is also where focus-mode suppression lives. This module never
// reads the setting — staying pure of settings/DOM is what makes it testable
// under `node --test`, where there is no WebAudio at all.
//
// Everything here fails SILENT and returns false. No WebAudio, an AudioContext
// the autoplay policy still has suspended, a constructor that throws: none of
// it may propagate into the render path that called us, and none of it deserves
// a toast — the user asked for a sound, not for an error about a sound.

// [pitch Hz, start offset s, duration s] per note. Pitches sit in the middle of
// the audible range: high enough to cut through, low enough not to pierce.
export const TONES = {
  finished: [[660, 0, 0.12], [988, 0.11, 0.20]],
  'needs-you': [[415, 0, 0.11], [415, 0.17, 0.11]],
};

// Quiet by design — this is a cue you hear while working, not an alarm.
const PEAK_GAIN = 0.18;
// A sine started/stopped at full amplitude clicks; ramp both edges.
const ATTACK_S = 0.015;
// Leave the node alive a hair past its envelope so the tail isn't clipped.
const RELEASE_PAD_S = 0.02;

export function toneSpec(kind) {
  return TONES[kind] || null;
}

// One context for the page's lifetime — browsers cap how many an origin may
// hold open (~6 in Chrome), so building one per cue would go silent after a
// handful of finishes.
let ctx = null;

function audioContext(Ctor) {
  if (ctx) return ctx;
  const C = Ctor || globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!C) return null;
  try { ctx = new C(); } catch { return null; }
  return ctx;
}

// Drops the cached context so the next call builds a fresh one. Tests use this
// to isolate; production has no reason to.
export function resetAudio() { ctx = null; }

// `Ctor` is the test seam (and the webkit fallback's entry point) — production
// callers pass nothing and get the global AudioContext.
export function playSound(kind, Ctor) {
  const notes = toneSpec(kind);
  if (!notes) return false;
  const ac = audioContext(Ctor);
  if (!ac) return false;
  try {
    // A context built before the page's first user gesture starts suspended.
    // resume() is async and may never settle (the tab was never clicked), so
    // fire it and schedule regardless rather than awaiting: this cue may be
    // lost, but the one after the next click won't be.
    if (ac.state === 'suspended') ac.resume?.();
    const now = ac.currentTime || 0;
    for (const [freq, at, dur] of notes) {
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, now + at);
      gain.gain.linearRampToValueAtTime(PEAK_GAIN, now + at + ATTACK_S);
      gain.gain.linearRampToValueAtTime(0, now + at + dur);
      osc.connect(gain);
      gain.connect(ac.destination);
      osc.start(now + at);
      osc.stop(now + at + dur + RELEASE_PAD_S);
    }
    return true;
  } catch {
    return false;
  }
}
