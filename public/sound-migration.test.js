import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSoundMigration } from './sound-migration.js';

test('maps the old browser setting to shared extension enablement once', () => {
  for (const [raw, expected] of [['1', true], ['0', false], [null, null]]) {
    const frames = [];
    const migrate = createSoundMigration({ getItem: () => raw });
    const send = (frame) => { frames.push(frame); return true; };
    migrate(send); migrate(send);
    assert.deepEqual(frames, expected === null ? [] : [{ type: 'extension-enabled', id: 'sounds', enabled: expected, onlyIfUnset: true }]);
  }
});
