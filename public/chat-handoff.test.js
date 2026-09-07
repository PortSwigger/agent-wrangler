import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldReturnToChat } from './chat-handoff.js';

const base = { armedFor: 'card-1', selected: 'card-1', status: 'working', view: 'terminal' };

test('returns once the session has left needs-you', () => {
  assert.equal(shouldReturnToChat(base), true);
  assert.equal(shouldReturnToChat({ ...base, status: 'idle' }), true);
});

test('holds while the session is still blocked on the prompt', () => {
  assert.equal(shouldReturnToChat({ ...base, status: 'needs-you' }), false);
});

test('does nothing when no handoff is armed', () => {
  assert.equal(shouldReturnToChat({ ...base, armedFor: null }), false);
});

// Arming belongs to one card: the user may have moved on while the prompt sat there.
test('does not fire for a card whose panel is no longer open', () => {
  assert.equal(shouldReturnToChat({ ...base, selected: 'card-2' }), false);
});

// Guards the re-fire case: without this the switch would run on every ~4s rebuild.
test('does nothing when chat is already showing', () => {
  assert.equal(shouldReturnToChat({ ...base, view: 'chat' }), false);
});

test('an unknown status is not treated as the prompt being answered', () => {
  assert.equal(shouldReturnToChat({ ...base, status: null }), false);
  assert.equal(shouldReturnToChat({ ...base, status: '' }), false);
  assert.equal(shouldReturnToChat({ ...base, status: undefined }), false);
});
