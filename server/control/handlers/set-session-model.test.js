import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setSessionModelHandler } from './set-session-model.js';

const E = '\x1b';
const EMPTY_COMPOSER = `${E}[39m❯ `;
const TYPED_COMPOSER = `${E}[39m❯ half a prompt`;

function ctx({ node = { agent: 'claude', status: 'idle' }, pane = EMPTY_COMPOSER, tmux = 'cc_a' } = {}) {
  const c = {
    sent: [], texts: [],
    reply: (o) => c.sent.push(o),
    sessionFromGraph: () => node,
    tmuxFor: () => tmux,
    socketFor: () => 'sock',
    capturePaneStyled: async () => pane,
    sendText: async (...args) => { c.texts.push(args); },
  };
  return c;
}

const run = (c, model = 'sonnet') =>
  setSessionModelHandler.handler({ type: 'set-session-model', sessionId: 'card-1', model }, c);

test('sends /model <name> to the pane and reports success', async () => {
  const c = ctx();
  await run(c);
  assert.deepEqual(c.texts, [['cc_a', '/model sonnet', 'sock']]);
  assert.deepEqual(c.sent, [{ type: 'model-set', sessionId: 'card-1', ok: true, model: 'sonnet' }]);
});

// The pane must only ever receive a model name this codebase already offers.
test('an unknown model never reaches the pane', async () => {
  const c = ctx();
  await run(c, 'gpt-4');
  assert.deepEqual(c.texts, []);
  assert.equal(c.sent[0].ok, false);
});

test('a shell-ish model string never reaches the pane', async () => {
  const c = ctx();
  await run(c, 'sonnet; rm -rf /');
  assert.deepEqual(c.texts, []);
  assert.equal(c.sent[0].ok, false);
});

test('every value the Claude adapter offers is accepted', async () => {
  for (const model of ['fable', 'opus', 'opusplan', 'sonnet', 'sonnet[1m]', 'haiku']) {
    const c = ctx();
    await run(c, model);
    assert.equal(c.sent[0].ok, true, `${model} should be accepted`);
    assert.deepEqual(c.texts[0][1], `/model ${model}`);
  }
});

// Mid-turn, composer input is queued as the next PROMPT, so the session would
// answer the command as a question instead of switching.
test('refuses while the session is working', async () => {
  const c = ctx({ node: { agent: 'claude', status: 'working' } });
  await run(c);
  assert.deepEqual(c.texts, []);
  assert.match(c.sent[0].reason, /idle/);
});

test('refuses while the session needs you', async () => {
  const c = ctx({ node: { agent: 'claude', status: 'needs-you' } });
  await run(c);
  assert.deepEqual(c.texts, []);
});

// The paste lands at the cursor, so a draft already there would fuse with the
// command and be submitted as one mangled prompt.
test('refuses when something is typed in the pane composer', async () => {
  const c = ctx({ pane: TYPED_COMPOSER });
  await run(c);
  assert.deepEqual(c.texts, []);
  assert.match(c.sent[0].reason, /typed/);
});

// A pane holding only a suggestion has nothing of the human's in it.
test('proceeds when the composer holds only a ghost suggestion', async () => {
  const c = ctx({ pane: `${E}[39m❯ ${E}[2mpoint 5${E}[0m` });
  await run(c);
  assert.equal(c.sent[0].ok, true);
});

// Fail-safe: an unreadable capture must not be treated as an empty composer.
test('refuses when the pane cannot be read', async () => {
  const c = ctx({ pane: '' });
  await run(c);
  assert.deepEqual(c.texts, []);
  assert.equal(c.sent[0].ok, false);
});

test('refuses a session with no live terminal', async () => {
  const c = ctx({ tmux: null });
  await run(c);
  assert.deepEqual(c.texts, []);
  assert.match(c.sent[0].reason, /resume/i);
});

// Codex's model is a launch choice and its TUI is a different program; a Claude
// slash command would just be typed at it as text.
test('refuses codex outright, without reading its pane', async () => {
  const c = ctx({ node: { agent: 'codex', status: 'idle' } });
  await run(c);
  assert.deepEqual(c.texts, []);
  assert.match(c.sent[0].reason, /Claude-only/);
});
