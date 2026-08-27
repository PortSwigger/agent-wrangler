import test from 'node:test';
import assert from 'node:assert/strict';
import { lastUserPrompt, chooseRestore, TAIL_BYTES } from './restore-prompt.js';

const line = (o) => JSON.stringify(o);
const userLine = (text, ts = '2026-08-27T10:00:00.000Z') =>
  line({ type: 'user', timestamp: ts, message: { role: 'user', content: text } });
const asstLine = (text, ts = '2026-08-27T10:00:01.000Z') =>
  line({ type: 'assistant', timestamp: ts, message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text }] } });

const readerFor = (text) => async () => text;

test('lastUserPrompt returns the NEWEST user message, not the first', async () => {
  const text = [userLine('the older prompt'), asstLine('a reply'), userLine('the newest prompt')].join('\n');
  assert.equal(await lastUserPrompt('/t.jsonl', 'claude', { readFile: readerFor(text) }), 'the newest prompt');
});

test('lastUserPrompt reads FRESH, which is the whole point', async () => {
  // The client's own lastUserText was only refreshed when a 2s poll happened to
  // deliver a user event, so pressing Esc before the newest prompt had been read
  // back handed the PREVIOUS one to the composer. Reading at request time removes
  // the race rather than narrowing it.
  let current = [userLine('first')].join('\n');
  const readFile = async () => current;
  assert.equal(await lastUserPrompt('/t.jsonl', 'claude', { readFile }), 'first');
  current = [userLine('first'), userLine('second, sent moments ago')].join('\n');
  assert.equal(await lastUserPrompt('/t.jsonl', 'claude', { readFile }), 'second, sent moments ago');
});

test('lastUserPrompt keeps multi-line prompts exactly — no wrap guessing needed', async () => {
  // The transcript is the only source that has the original line structure; the
  // pane has already re-wrapped it.
  const prompt = "I'm seeing this error:\n\nERROR: NOT WORKING";
  const text = userLine(prompt);
  assert.equal(await lastUserPrompt('/t.jsonl', 'claude', { readFile: readerFor(text) }), prompt);
});

test('lastUserPrompt tolerates a truncated first line — only the tail is read', async () => {
  const text = ['{"type":"user","messa', userLine('the real prompt')].join('\n');
  assert.equal(await lastUserPrompt('/t.jsonl', 'claude', { readFile: readerFor(text) }), 'the real prompt');
});

test('lastUserPrompt skips a user turn that carried no prose', async () => {
  // An image-only paste produces a user event with empty text; restoring "" would
  // just blank the composer.
  const text = [userLine('the prompt with words'), line({
    type: 'user', timestamp: '2026-08-27T10:00:05.000Z',
    message: { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A' } }] },
  })].join('\n');
  assert.equal(await lastUserPrompt('/t.jsonl', 'claude', { readFile: readerFor(text) }), 'the prompt with words');
});

test('lastUserPrompt is null for no file, an unreadable file, and an empty one', async () => {
  assert.equal(await lastUserPrompt(null), null);
  assert.equal(await lastUserPrompt('/t.jsonl', 'claude', { readFile: async () => { throw new Error('EACCES'); } }), null);
  assert.equal(await lastUserPrompt('/t.jsonl', 'claude', { readFile: readerFor('') }), null);
});

test('lastUserPrompt asks for a bounded tail, never the whole transcript', async () => {
  let asked = null;
  await lastUserPrompt('/t.jsonl', 'claude', { readFile: async (f, bytes) => { asked = bytes; return userLine('x'); } });
  assert.equal(asked, TAIL_BYTES);
  assert.ok(TAIL_BYTES <= 1024 * 1024, 'a transcript can reach tens of MB; this stays a cheap read');
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
      await lastUserPrompt('/t.jsonl', 'claude', { readFile: readerFor(text) }),
      'the prompt the human actually wrote',
      `must skip ${marker}`,
    );
  }
});

test('a prompt that merely mentions an interruption marker is still restored', async () => {
  // The filter is anchored, so a human quoting the notice is not swallowed by it.
  const prompt = 'I saw [Request interrupted by user] in the log — why?';
  assert.equal(await lastUserPrompt('/t.jsonl', 'claude', { readFile: readerFor(userLine(prompt)) }), prompt);
});

test('a transcript of nothing but interruption notices restores nothing', async () => {
  const text = [userLine('[Request interrupted by user]'), userLine('[Request interrupted by user]')].join('\n');
  assert.equal(await lastUserPrompt('/t.jsonl', 'claude', { readFile: readerFor(text) }), null);
});
