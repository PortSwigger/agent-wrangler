import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adoptConversation, ADOPT_UNKNOWN_MSG, ADOPT_NO_CODEX_MSG } from './adopt.js';
import { SessionManager } from '../../session-manager.js';

const CLAUDE_DOC = { id: 'conv-claude', agent: 'claude', cwd: '/repos/site', title: 'Fix the login redirect' };
const CODEX_DOC = { id: 'conv-codex', agent: 'codex', cwd: '/repos/api', title: '' };

// A real SessionManager (adopt/cardForLive/forget are the units under test here)
// with its persistence and its on-disk mappings taken away, so a developer's real
// board can't decide the outcome of a test.
function harness({ docs = [CLAUDE_DOC, CODEX_DOC], transcript = '/p/conv-claude.jsonl', codex = true, resumeThrows = null } = {}) {
  const sm = new SessionManager();
  sm.map.clear();
  sm._save = () => {};
  const replies = [];
  const calls = { resume: [], rebuild: 0, forgot: [] };
  const ctx = {
    sessionManager: sm,
    memoryStore: { forget: (id) => calls.forgot.push(id) },
    reply: (m) => replies.push(m),
    rebuild: async () => { calls.rebuild += 1; },
  };
  const deps = {
    docs: () => docs,
    transcriptFor: async () => transcript,
    codexAvailable: async () => codex,
    resume: async (sid) => {
      calls.resume.push(sid);
      if (resumeThrows) throw new Error(resumeThrows);
    },
  };
  return { sm, ctx, deps, replies, calls };
}

const cards = (sm) => [...sm.map.entries()];

test('adopt mints a NEW card id for an unmapped conversation — the conversation id goes in liveSessionId, never the key', async () => {
  const h = harness();
  await adoptConversation({ sessionId: 'conv-claude' }, h.ctx, h.deps);

  assert.equal(cards(h.sm).length, 1);
  const [cardId, entry] = cards(h.sm)[0];
  assert.notEqual(cardId, 'conv-claude'); // the card id is never a conversation id
  assert.equal(entry.liveSessionId, 'conv-claude');
  assert.equal(entry.agent, 'claude');
  assert.equal(entry.cwd, '/repos/site');
  assert.equal(entry.intent, 'Fix the login redirect');
  assert.equal(entry.tmux, null); // adopt() itself launches nothing
  // Resumed by CARD id (what every per-session field is keyed on), then acked with
  // it so the client can jump to the card once the graph carries it.
  assert.deepEqual(h.calls.resume, [cardId]);
  assert.deepEqual(h.replies, [{ type: 'adopted', sessionId: cardId, liveSessionId: 'conv-claude' }]);
});

// The card-id split is what makes a Codex rollout adoptable: _doResume reads
// prev.liveSessionId for a discover agent, so keying the card on the rollout id
// would look like "no cached id" and re-discover the most recent rollout instead.
test('adopt tags a Codex conversation as codex and keeps its rollout id distinct from the card id', async () => {
  const h = harness();
  await adoptConversation({ sessionId: 'conv-codex' }, h.ctx, h.deps);
  const [cardId, entry] = cards(h.sm)[0];
  assert.equal(entry.agent, 'codex');
  assert.equal(entry.liveSessionId, 'conv-codex');
  assert.notEqual(cardId, 'conv-codex');
  assert.equal(entry.cwd, '/repos/api'); // a Codex resume isn't cwd-bucketed, so the doc's cwd IS the launch dir
});

test('adopt refuses a Codex conversation when the codex binary is missing — no card, no resume', async () => {
  const h = harness({ codex: false });
  await adoptConversation({ sessionId: 'conv-codex' }, h.ctx, h.deps);
  assert.equal(cards(h.sm).length, 0);
  assert.deepEqual(h.calls.resume, []);
  assert.deepEqual(h.replies, [{ type: 'adopt-failed', sessionId: 'conv-codex', message: ADOPT_NO_CODEX_MSG }]);
});

test('adopt refuses an id the index does not know, and one that is dead (tombstoned)', async () => {
  const h = harness({ docs: [{ ...CLAUDE_DOC, dead: true }] });
  await adoptConversation({ sessionId: 'conv-claude' }, h.ctx, h.deps);
  await adoptConversation({ sessionId: 'never-indexed' }, h.ctx, h.deps);
  assert.equal(cards(h.sm).length, 0);
  assert.deepEqual(h.replies.map((r) => r.type), ['adopt-failed', 'adopt-failed']);
  assert.equal(h.replies[0].message, ADOPT_UNKNOWN_MSG);
});

// Claude's --resume fails OPEN into a blank session, so the transcript must exist.
// _doResume guards that too, but only AFTER the entry exists — a refusal there
// would strand a card for a conversation that can never be resumed.
test('adopt refuses a Claude conversation whose transcript is gone BEFORE minting the card', async () => {
  const h = harness({ transcript: null });
  await adoptConversation({ sessionId: 'conv-claude' }, h.ctx, h.deps);
  assert.equal(cards(h.sm).length, 0);
  assert.deepEqual(h.calls.resume, []);
  assert.equal(h.replies[0].type, 'adopt-failed');
});

test('adopt rejects an id that could not have come from a transcript filename', async () => {
  const h = harness();
  await adoptConversation({ sessionId: '../../etc/passwd' }, h.ctx, h.deps);
  await adoptConversation({ sessionId: 'x; rm -rf /' }, h.ctx, h.deps);
  assert.equal(cards(h.sm).length, 0);
  assert.deepEqual(h.replies.map((r) => r.message), [ADOPT_UNKNOWN_MSG, ADOPT_UNKNOWN_MSG]);
});

test('adopt of a conversation that already has a LIVE card points at it and leaves the running pane alone', async () => {
  const h = harness();
  h.sm.map.set('card-1', { tmux: 'cc_live', liveSessionId: 'conv-claude', agent: 'claude' });
  h.sm.alive.add('cc_live');
  await adoptConversation({ sessionId: 'conv-claude' }, h.ctx, h.deps);
  assert.equal(cards(h.sm).length, 1); // no second card
  assert.deepEqual(h.calls.resume, []); // resuming would kill the live pane
  assert.deepEqual(h.replies, [{ type: 'adopted', sessionId: 'card-1', liveSessionId: 'conv-claude', alreadyMapped: true }]);
});

// A legacy pre-split entry has no liveSessionId — its card id IS the conversation
// id. Miss that and adopt mints a second card for a conversation that already has one.
test('adopt of a dormant legacy card (card id == conversation id) resumes that card instead of minting another', async () => {
  const h = harness();
  h.sm.map.set('conv-claude', { tmux: null, agent: 'claude' });
  await adoptConversation({ sessionId: 'conv-claude' }, h.ctx, h.deps);
  assert.equal(cards(h.sm).length, 1);
  assert.deepEqual(h.calls.resume, ['conv-claude']);
  assert.equal(h.replies[0].alreadyMapped, true);
});

test('a resume that refuses rolls the freshly-minted card back, so a failed adopt leaves no phantom', async () => {
  const h = harness({ resumeThrows: 'nope' });
  await adoptConversation({ sessionId: 'conv-claude' }, h.ctx, h.deps);
  assert.equal(cards(h.sm).length, 0);
  assert.equal(h.calls.forgot.length, 1); // the memory binding resume made goes too
  assert.deepEqual(h.replies, [{ type: 'adopt-failed', sessionId: 'conv-claude', message: 'nope' }]);
  assert.equal(h.calls.rebuild, 1); // the board must not keep showing the rolled-back card
});
