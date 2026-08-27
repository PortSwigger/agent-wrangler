import test from 'node:test';
import assert from 'node:assert/strict';

// The chat stream is append-only (chat-view.js: APPEND, NEVER RE-RENDER), so a
// rewind in the pane — which retroactively turns turns already drawn into a dead
// branch — cannot be expressed as more events. The server moves a per-conversation
// `epoch` instead and the view rebuilds from a fresh window read.
//
// initChatView reaches for ~10 DOM elements and a markdown renderer, far more than
// this decision needs, so the reply-handling shape is mirrored here the way
// chat-draft.test.js mirrors the composer's draft store — keeping public/ tests
// DOM-free rather than adding jsdom.
function createView() {
  const v = {
    epoch: null,
    generation: 0,
    pasteEra: 0,
    offset: 10,
    stream: ['drawn'],
    rebuilds: 0,
    appended: [],
    inFlightPastes: new Set(),
  };
  v.rebuildStream = () => {
    v.rebuilds += 1;
    v.generation += 1;
    v.offset = null;
    v.stream = [];
  };
  // The three lines of onChatReply this file exists to pin, in their real order:
  // the token era gate, then the epoch gate, then the append.
  v.onReply = (msg) => {
    if (msg.token !== v.generation) return;
    const replyEpoch = msg.epoch ?? 0;
    if (v.epoch != null && replyEpoch !== v.epoch) {
      v.epoch = replyEpoch;
      v.rebuildStream();
      return;
    }
    v.epoch = replyEpoch;
    v.appended.push(...(msg.events || []));
  };
  v.mount = () => {
    v.epoch = null;
    v.generation += 1;
    v.pasteEra += 1;
  };
  return v;
}

test('the first reply adopts the epoch it is given rather than reading it as a change', () => {
  const v = createView();
  v.onReply({ token: 0, epoch: 7, events: ['a'] });
  assert.equal(v.rebuilds, 0, 'a session whose counter has already moved must not rebuild on open');
  assert.deepEqual(v.appended, ['a']);
  assert.equal(v.epoch, 7);
});

test('a moved epoch rebuilds the stream once, and drops that reply\'s own events', () => {
  const v = createView();
  v.onReply({ token: 0, epoch: 0, events: ['a'] });
  v.onReply({ token: 0, epoch: 1, events: ['dead'] });
  assert.equal(v.rebuilds, 1);
  assert.deepEqual(v.stream, [], 'what was drawn included the branch the pane abandoned');
  assert.ok(!v.appended.includes('dead'), 'the rebuild read is what carries the pruned conversation');
  // The rebuild's own reply comes back at the new epoch and must settle, not loop.
  v.onReply({ token: v.generation, epoch: 1, events: ['live'] });
  assert.equal(v.rebuilds, 1);
  assert.deepEqual(v.appended, ['a', 'live']);
});

test('a reply already in flight when the rebuild happened cannot re-append the dead branch', () => {
  const v = createView();
  v.onReply({ token: 0, epoch: 0, events: ['a'] });
  const staleToken = v.generation;
  v.onReply({ token: 0, epoch: 1, events: [] }); // triggers the rebuild, bumping generation
  v.onReply({ token: staleToken, epoch: 1, events: ['dead'] });
  assert.deepEqual(v.appended, ['a'], 'offset is back to null, so only the token gate can reject this');
});

test('a reply with no epoch field at all reads as 0 and does not flap', () => {
  const v = createView();
  v.onReply({ token: 0, events: ['a'] });
  v.onReply({ token: 0, events: ['b'] });
  assert.equal(v.rebuilds, 0);
  assert.deepEqual(v.appended, ['a', 'b']);
});

test('a rebuild leaves the paste era alone, so an image upload in flight still lands', () => {
  // pasteEra is deliberately NOT the poll generation: the rebuild answers a change
  // in the conversation, and the composer — including an image the reader pasted a
  // moment ago — is not part of that.
  const v = createView();
  v.onReply({ token: 0, epoch: 0, events: [] });
  const token = `${v.pasteEra}#1`;
  v.onReply({ token: 0, epoch: 1, events: [] });
  assert.equal(v.rebuilds, 1);
  assert.ok(token.startsWith(`${v.pasteEra}#`), 'the upload still belongs to the era on screen');
  // Moving to another session is the one thing that DOES orphan it.
  v.mount();
  assert.ok(!token.startsWith(`${v.pasteEra}#`));
});
