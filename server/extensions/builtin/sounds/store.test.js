import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SoundStore } from './store.js';
import { getSoundsHandler, setSoundsHandler } from './handlers.js';

test('uploaded audio persists across instances and reset removes it', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-sounds-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'sounds.json');
  const sound = { name: 'cue.wav', data: 'data:audio/wav;base64,UklGRg==' };
  const store = new SoundStore(file);
  store.save({ finished: sound });
  assert.deepEqual(new SoundStore(file).read(), { finished: sound });
  assert.throws(() => store.save({ finished: { ...sound, data: 'javascript:alert(1)' } }), /audio/i);
  assert.deepEqual(store.read(), { finished: sound });
  store.save({});
  assert.deepEqual(new SoundStore(file).read(), {});
});

test('saving shared audio broadcasts the update and acknowledges failures', () => {
  let sounds = {};
  const messages = [];
  const host = { stores: { sounds: { read: () => sounds, save: (v) => { if (v === null) throw Error('invalid'); sounds = v; } } }, broadcast: (m) => messages.push(m) };
  setSoundsHandler.handler({ reqId: 'save', sounds: { finished: 'fixture' } }, host);
  assert.deepEqual(messages[0], { kind: 'sounds', reqId: 'save', sounds: { finished: 'fixture' } });
  getSoundsHandler.handler({ reqId: 'load' }, host, (msg) => messages.push(msg));
  assert.equal(messages[1].reqId, 'load');
  setSoundsHandler.handler({ reqId: 'bad', sounds: null }, host, (msg) => messages.push(msg));
  assert.deepEqual(messages[2], { kind: 'sounds-error', reqId: 'bad', error: 'invalid' });
});

test('reading audio replies only to its requester without broadcasting the payload', () => {
  const replies = [];
  const broadcasts = [];
  const host = { stores: { sounds: { read: () => ({ finished: { name: 'cue.wav', data: 'data:audio/wav;base64,UklGRg==' } }) } }, broadcast: (msg) => broadcasts.push(msg) };
  getSoundsHandler.handler({ reqId: 'one-tab' }, host, (msg) => replies.push(msg));
  assert.equal(broadcasts.length, 0);
  assert.equal(replies[0].reqId, 'one-tab');
  assert.equal(replies[0].sounds.finished.name, 'cue.wav');
});
