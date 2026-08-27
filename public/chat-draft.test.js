import test from 'node:test';
import assert from 'node:assert/strict';

// The composer is ONE textarea shared by every session, so switching cards has to
// swap its value explicitly. Resetting the state variables around it is not
// enough, and the gap was a real leak: a prompt entered against one session was
// still in the box, with Send enabled, after opening a sibling session — so it
// could be delivered to the wrong agent.
//
// initChatView reaches for ~10 elements and a markdown renderer, which is far more
// DOM than this behaviour needs, so the save/load pair is exercised directly here
// against the same shape chat-view.js uses. Keeping this as its own file (rather
// than adding jsdom) matches how the rest of public/ tests stay DOM-free.
function createDraftStore(box) {
  const drafts = new Map();
  let attachments = [];
  return {
    drafts,
    get attachments() { return attachments; },
    set attachments(v) { attachments = v; },
    saveDraft(id) {
      if (!id) return;
      const text = box.value;
      if (text.trim() || attachments.length) drafts.set(id, { text, attachments: attachments.slice() });
      else drafts.delete(id);
    },
    loadDraft(id) {
      const d = (id && drafts.get(id)) || null;
      box.value = d?.text ?? '';
      attachments = d?.attachments ? d.attachments.slice() : [];
    },
    // mount()'s ordering: put the outgoing card's draft away, then bring the
    // incoming card's in.
    switchTo(leaving, id) { this.saveDraft(leaving); this.loadDraft(id); },
  };
}

test('a draft does NOT follow the reader to another session (the leak)', () => {
  const box = { value: '' };
  const s = createDraftStore(box);
  box.value = 'SESSION-ONE-SECRET-PROMPT';
  s.switchTo('sess-1', 'sess-2');
  assert.equal(box.value, '', 'the box opened for sess-2 must be empty, not holding sess-1 text');
});

test('switching back restores the draft rather than throwing the work away', () => {
  const box = { value: '' };
  const s = createDraftStore(box);
  box.value = 'half-written thought';
  s.switchTo('sess-1', 'sess-2');
  box.value = 'something else entirely';
  s.switchTo('sess-2', 'sess-1');
  assert.equal(box.value, 'half-written thought');
  // …and the other session's draft is still its own.
  s.switchTo('sess-1', 'sess-2');
  assert.equal(box.value, 'something else entirely');
});

test('attachments travel with the text, and never to a different session', () => {
  const box = { value: '' };
  const s = createDraftStore(box);
  box.value = 'what is in this screenshot?';
  s.attachments = [{ name: 'paste-1-aaaa.png' }];
  s.switchTo('sess-1', 'sess-2');
  // A paste filename only means anything inside the session whose pastes folder
  // holds it, so carrying it across would attach one person's screenshot to
  // someone else's conversation.
  assert.deepEqual(s.attachments, []);
  s.switchTo('sess-2', 'sess-1');
  assert.equal(box.value, 'what is in this screenshot?');
  assert.deepEqual(s.attachments, [{ name: 'paste-1-aaaa.png' }]);
});

test('unmount saves against the card being closed and leaves the shared box empty', () => {
  const box = { value: '' };
  const s = createDraftStore(box);
  box.value = 'unsent';
  // unmount(): saveDraft(leaving) then loadDraft(null)
  s.saveDraft('sess-1');
  s.loadDraft(null);
  assert.equal(box.value, '');
  s.loadDraft('sess-1');
  assert.equal(box.value, 'unsent');
});

test('an emptied draft is dropped rather than kept as a blank entry', () => {
  const box = { value: '' };
  const s = createDraftStore(box);
  box.value = 'typed then deleted';
  s.saveDraft('sess-1');
  box.value = '   ';
  s.saveDraft('sess-1');
  assert.equal(s.drafts.has('sess-1'), false, 'whitespace-only is not a draft, and must not resurrect the old one');
  s.loadDraft('sess-1');
  assert.equal(box.value, '');
});

test('a draft is stored as a COPY, so later edits cannot reach back into it', () => {
  const box = { value: '' };
  const s = createDraftStore(box);
  box.value = 'first';
  const att = [{ name: 'paste-1-aaaa.png' }];
  s.attachments = att;
  s.saveDraft('sess-1');
  // Mutating the live array must not rewrite what was filed away.
  att.push({ name: 'paste-2-bbbb.png' });
  s.loadDraft('sess-1');
  assert.deepEqual(s.attachments, [{ name: 'paste-1-aaaa.png' }]);
});

test('saveDraft with no session id is a no-op (nothing to file it under)', () => {
  const box = { value: 'orphan' };
  const s = createDraftStore(box);
  s.saveDraft(null);
  assert.equal(s.drafts.size, 0);
});
