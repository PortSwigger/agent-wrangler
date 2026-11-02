import { test } from 'node:test';
import assert from 'node:assert/strict';

const { TONES, toneSpec, playSound, resetAudio } = await import('./sound.js');

// A minimal WebAudio stand-in: records every oscillator/gain the scheduler
// builds so a test can assert on notes without a real audio device. Passed in
// as playSound's `Ctor` seam, so nothing here touches globals.
function fakeAudio({ state = 'running', throwOn = null } = {}) {
  const log = { oscillators: [], gains: [], resumed: 0, constructed: 0, stopped: [] };
  class Ctx {
    constructor() { log.constructed++; this.state = state; this.currentTime = 5; this.destination = { name: 'dest' }; }
    resume() { log.resumed++; }
    createOscillator() {
      if (throwOn === 'oscillator') throw new Error('nope');
      const osc = { type: '', frequency: { value: 0 }, connect() {}, start(t) { osc.startedAt = t; }, stop(t) { log.stopped.push(t); } };
      log.oscillators.push(osc);
      return osc;
    }
    createGain() {
      const ramps = [];
      const gain = { gain: { setValueAtTime: (v, t) => ramps.push(['set', v, t]), linearRampToValueAtTime: (v, t) => ramps.push(['ramp', v, t]) }, ramps, connect: (dest) => { gain.connectedTo = dest; } };
      log.gains.push(gain);
      return gain;
    }
  }
  return { Ctx, log };
}

test.beforeEach(() => resetAudio());

// ── toneSpec ─────────────────────────────────────────────────────────────────
test('toneSpec: both cues exist and are audibly distinct', () => {
  const finished = toneSpec('finished');
  const needsYou = toneSpec('needs-you');
  assert.ok(finished.length >= 2, 'finished is a multi-note cue');
  assert.ok(needsYou.length >= 2, 'needs-you is a multi-note cue');
  const freqs = (notes) => notes.map(([hz]) => hz);
  assert.notDeepEqual(freqs(finished), freqs(needsYou), 'the two cues must not share a pitch sequence');
});

test('toneSpec: finished rises, needs-you repeats one pitch', () => {
  const [[lo], [hi]] = toneSpec('finished');
  assert.ok(hi > lo, 'finished is a rising chime');
  const needsYou = toneSpec('needs-you');
  assert.equal(needsYou[0][0], needsYou[1][0], 'needs-you is a double-beep on one pitch');
});

test('toneSpec: unknown kind is null, not a silent default', () => {
  assert.equal(toneSpec('nope'), null);
  assert.equal(toneSpec(undefined), null);
});

test('TONES notes are [hz, offset, duration] triples with sane values', () => {
  for (const [kind, notes] of Object.entries(TONES)) {
    for (const note of notes) {
      assert.equal(note.length, 3, `${kind} note is a triple`);
      const [hz, at, dur] = note;
      assert.ok(hz > 100 && hz < 4000, `${kind} pitch ${hz} is in an audible, non-piercing range`);
      assert.ok(at >= 0 && dur > 0, `${kind} offset/duration are positive`);
    }
  }
});

// ── playSound ────────────────────────────────────────────────────────────────
test('playSound: schedules one oscillator per note at the right pitches', () => {
  const { Ctx, log } = fakeAudio();
  assert.equal(playSound('finished', Ctx), true);
  assert.deepEqual(log.oscillators.map((o) => o.frequency.value), toneSpec('finished').map(([hz]) => hz));
  assert.equal(log.gains.length, log.oscillators.length, 'every note gets its own gain envelope');
  assert.ok(log.gains.every((g) => g.connectedTo?.name === 'dest'), 'each gain reaches the destination');
});

test('playSound: offsets are relative to the context clock, not zero', () => {
  const { Ctx, log } = fakeAudio();
  playSound('finished', Ctx);
  const [, at] = toneSpec('finished')[1];
  assert.equal(log.oscillators[1].startedAt, 5 + at, 'second note starts at currentTime + its offset');
});

test('playSound: every note ramps in and out (a bare start/stop clicks)', () => {
  const { Ctx, log } = fakeAudio();
  playSound('needs-you', Ctx);
  for (const g of log.gains) {
    assert.ok(g.ramps.some(([k, v]) => k === 'ramp' && v > 0), 'ramps up to a peak');
    assert.ok(g.ramps.some(([k, v]) => k === 'ramp' && v === 0), 'ramps back to silence');
  }
});

test('playSound: stops every oscillator it starts (no leaked nodes)', () => {
  const { Ctx, log } = fakeAudio();
  playSound('finished', Ctx);
  assert.equal(log.stopped.length, log.oscillators.length);
});

test('playSound: reuses one AudioContext across calls', () => {
  const { Ctx, log } = fakeAudio();
  playSound('finished', Ctx);
  playSound('needs-you', Ctx);
  playSound('finished', Ctx);
  assert.equal(log.constructed, 1, 'browsers cap live AudioContexts — never one per cue');
});

test('playSound: resumes a context the autoplay policy left suspended', () => {
  const { Ctx, log } = fakeAudio({ state: 'suspended' });
  assert.equal(playSound('finished', Ctx), true, 'schedules anyway rather than awaiting resume');
  assert.equal(log.resumed, 1);
});

test('playSound: unknown kind plays nothing and never builds a context', () => {
  const { Ctx, log } = fakeAudio();
  assert.equal(playSound('nope', Ctx), false);
  assert.equal(log.constructed, 0);
  assert.equal(log.oscillators.length, 0);
});

test('playSound: no WebAudio in the environment is a silent no-op', () => {
  assert.equal(globalThis.AudioContext, undefined, 'node has none — the real fallback path');
  assert.equal(playSound('finished'), false);
});

test('playSound: a throwing constructor never propagates', () => {
  class Broken { constructor() { throw new Error('blocked'); } }
  assert.equal(playSound('finished', Broken), false);
});

test('playSound: a mid-schedule failure never propagates into the caller', () => {
  const { Ctx } = fakeAudio({ throwOn: 'oscillator' });
  assert.equal(playSound('finished', Ctx), false);
});
