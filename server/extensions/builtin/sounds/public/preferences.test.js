import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readAudioFile, playCue } from './preferences.js';

test('uploaded files must be nonempty, no larger than 1 MB and decodable audio', async () => {
  let decoded = 0;
  class Context {
    async decodeAudioData(bytes) { decoded++; assert.equal(bytes.byteLength, 4); }
    async close() {}
  }
  const file = { name: 'cue.wav', size: 4, arrayBuffer: async () => new Uint8Array([82, 73, 70, 70]).buffer };
  assert.deepEqual(await readAudioFile(file, Context), { name: 'cue.wav', data: 'data:audio/wav;base64,UklGRg==' });
  assert.equal(decoded, 1);
  await assert.rejects(readAudioFile({ ...file, size: 0 }, Context), /empty/i);
  await assert.rejects(readAudioFile({ ...file, size: 1024 * 1024 + 1 }, Context), /1 MB/);
  class Invalid extends Context { async decodeAudioData() { throw Error('bad'); } }
  await assert.rejects(readAudioFile(file, Invalid), /audio/i);
});

test('custom playback needs no separate opt-in and failures stay silent', async () => {
  const played = [];
  class Audio {
    constructor(src) { this.src = src; }
    async play() { played.push(this.src); }
  }
  const sounds = { finished: { data: 'data:audio/wav;base64,AAAA', name: 'cue.wav' } };
  assert.equal(await playCue('finished', sounds, { Audio }), true);
  assert.deepEqual(played, ['data:audio/wav;base64,AAAA']);
  class Blocked extends Audio { async play() { throw Error('blocked'); } }
  assert.equal(await playCue('finished', sounds, { Audio: Blocked }), false);
  assert.equal(await playCue('unknown', sounds, { Audio }), false);
});
