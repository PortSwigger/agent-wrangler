import test from 'node:test';
import assert from 'node:assert/strict';
import { lastUserPrompt, chooseRestore, FIRST_ATTEMPT_BYTES, MAX_READ_BYTES } from './restore-prompt.js';

const line = (o) => JSON.stringify(o);
const userLine = (text, ts = '2026-08-27T10:00:00.000Z') =>
  line({ type: 'user', timestamp: ts, message: { role: 'user', content: text } });
const asstLine = (text, ts = '2026-08-27T10:00:01.000Z') =>
  line({ type: 'assistant', timestamp: ts, message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text }] } });

// atStart:true means "this is the whole file", which is what a small fixture is.
const readerFor = (text) => async () => ({ text, atStart: true });

test('lastUserPrompt returns the NEWEST user message, not the first', async () => {
  const text = [userLine('the older prompt'), asstLine('a reply'), userLine('the newest prompt')].join('\n');
  assert.equal(await lastUserPrompt('/t.jsonl', 'claude', { readTail: readerFor(text) }), 'the newest prompt');
});

test('lastUserPrompt reads FRESH, which is the whole point', async () => {
  // The client's own lastUserText was only refreshed when a 2s poll happened to
  // deliver a user event, so pressing Esc before the newest prompt had been read
  // back handed the PREVIOUS one to the composer. Reading at request time removes
  // the race rather than narrowing it.
  let current = [userLine('first')].join('\n');
  const readTail = async () => ({ text: current, atStart: true });
  assert.equal(await lastUserPrompt('/t.jsonl', 'claude', { readTail }), 'first');
  current = [userLine('first'), userLine('second, sent moments ago')].join('\n');
  assert.equal(await lastUserPrompt('/t.jsonl', 'claude', { readTail }), 'second, sent moments ago');
});

test('lastUserPrompt keeps multi-line prompts exactly — no wrap guessing needed', async () => {
  // The transcript is the only source that has the original line structure; the
  // pane has already re-wrapped it.
  const prompt = "I'm seeing this error:\n\nERROR: NOT WORKING";
  const text = userLine(prompt);
  assert.equal(await lastUserPrompt('/t.jsonl', 'claude', { readTail: readerFor(text) }), prompt);
});

test('lastUserPrompt tolerates a truncated first line — only the tail is read', async () => {
  const text = ['{"type":"user","messa', userLine('the real prompt')].join('\n');
  assert.equal(await lastUserPrompt('/t.jsonl', 'claude', { readTail: readerFor(text) }), 'the real prompt');
});

test('lastUserPrompt skips a user turn that carried no prose', async () => {
  // An image-only paste produces a user event with empty text; restoring "" would
  // just blank the composer.
  const text = [userLine('the prompt with words'), line({
    type: 'user', timestamp: '2026-08-27T10:00:05.000Z',
    message: { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A' } }] },
  })].join('\n');
  assert.equal(await lastUserPrompt('/t.jsonl', 'claude', { readTail: readerFor(text) }), 'the prompt with words');
});

test('lastUserPrompt is null for no file, an unreadable file, and an empty one', async () => {
  assert.equal(await lastUserPrompt(null), null);
  assert.equal(await lastUserPrompt('/t.jsonl', 'claude', { readTail: async () => { throw new Error('EACCES'); } }), null);
  assert.equal(await lastUserPrompt('/t.jsonl', 'claude', { readTail: readerFor('') }), null);
});

test('the read starts small and WIDENS until a prompt is found', async () => {
  // Transcript bytes are mostly tool output, not turns, so a fixed window is no
  // guarantee of holding a single prompt — and too small a window can make
  // selectLive prune away every prompt it does hold. Measured over 19 real
  // transcripts bigger than the first attempt, a flat tail returned NULL on one
  // where reading further back found the prompt.
  const asked = [];
  const got = await lastUserPrompt('/t.jsonl', 'claude', {
    readTail: async (f, bytes) => {
      asked.push(bytes);
      // Only the third, widest attempt reaches far enough back to include one.
      return { text: asked.length < 3 ? '' : userLine('the prompt'), atStart: false };
    },
  });
  assert.equal(got, 'the prompt');
  assert.deepEqual(asked, [FIRST_ATTEMPT_BYTES, FIRST_ATTEMPT_BYTES * 2, FIRST_ATTEMPT_BYTES * 4]);
});

test('widening stops at the start of the file', async () => {
  let calls = 0;
  const got = await lastUserPrompt('/t.jsonl', 'claude', {
    readTail: async () => { calls += 1; return { text: asstLine('no prompts here'), atStart: true }; },
  });
  assert.equal(got, null);
  assert.equal(calls, 1, 'nothing above this window, so no point asking for more');
});

test('widening is bounded, so a huge transcript cannot be read forever', async () => {
  const asked = [];
  await lastUserPrompt('/t.jsonl', 'claude', {
    readTail: async (f, bytes) => { asked.push(bytes); return { text: asstLine('x'), atStart: false }; },
  });
  assert.ok(asked.at(-1) >= MAX_READ_BYTES, 'it stops at the ceiling');
  assert.ok(asked.length < 20, 'and it terminates');
});

test('a window that starts mid-file drops its partial first line', async () => {
  // lineUuids reads the parent/child pair straight off the raw line, so a
  // truncated one contributes a bogus link to the tree selectLive prunes against.
  const truncated = '{"type":"user","messa';
  const got = await lastUserPrompt('/t.jsonl', 'claude', {
    readTail: async () => ({ text: [truncated, userLine('the real prompt')].join('\n'), atStart: false }),
  });
  assert.equal(got, 'the real prompt');
});

test('chooseRestore: the pane wins when it has a draft', async () => {
  // The pane is the only source that can reflect an edit made in the terminal.
  assert.deepEqual(
    chooseRestore({ paneDraft: 'edited in the pane', transcriptPrompt: 'as originally sent' }),
    { text: 'edited in the pane', source: 'pane' },
  );
});

test('chooseRestore: falls back to the transcript, which is the usual outcome', () => {
  // The restore is unreliable — never for multi-line prompts, and not even
  // repeatable for an identical single-line one — so this is the common path.
  assert.deepEqual(
    chooseRestore({ paneDraft: null, transcriptPrompt: 'as originally sent' }),
    { text: 'as originally sent', source: 'transcript' },
  );
});

test('chooseRestore: a blank pane draft does not beat a real transcript prompt', () => {
  assert.equal(chooseRestore({ paneDraft: '   ', transcriptPrompt: 'real' }).source, 'transcript');
});

test('chooseRestore: nothing anywhere reports none rather than an empty string', () => {
  assert.deepEqual(chooseRestore({ paneDraft: null, transcriptPrompt: null }), { text: null, source: 'none' });
  assert.deepEqual(chooseRestore({}), { text: null, source: 'none' });
});

test("Claude Code's own interruption notice is never restored as a prompt", async () => {
  // It is recorded as a plain `user` message with no isMeta flag, and it is the
  // NEWEST user entry at exactly the moment this is called — right after an
  // interrupt. Caught end-to-end: the first version of this returned
  // '[Request interrupted by user]' instead of the real 212-character prompt.
  for (const marker of ['[Request interrupted by user]', '[Request interrupted by user for tool use]']) {
    const text = [userLine('the prompt the human actually wrote'), userLine(marker)].join('\n');
    assert.equal(
      await lastUserPrompt('/t.jsonl', 'claude', { readTail: readerFor(text) }),
      'the prompt the human actually wrote',
      `must skip ${marker}`,
    );
  }
});

test('a prompt that merely mentions an interruption marker is still restored', async () => {
  // The filter is anchored, so a human quoting the notice is not swallowed by it.
  const prompt = 'I saw [Request interrupted by user] in the log — why?';
  assert.equal(await lastUserPrompt('/t.jsonl', 'claude', { readTail: readerFor(userLine(prompt)) }), prompt);
});

test('a transcript of nothing but interruption notices restores nothing', async () => {
  const text = [userLine('[Request interrupted by user]'), userLine('[Request interrupted by user]')].join('\n');
  assert.equal(await lastUserPrompt('/t.jsonl', 'claude', { readTail: readerFor(text) }), null);
});
