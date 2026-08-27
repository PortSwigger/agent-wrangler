import { test } from 'node:test';
import assert from 'node:assert/strict';
import { interruptHandler } from './interrupt.js';

// Written as an explicit escape rather than a literal byte: a raw 0x1b is easy
// to lose when a file is edited, and losing it makes every fixture silently wrong.
const ESC = '\x1b';
const W = 60;
// A `capture-pane -e` frame in the shape a real Claude pane produces.
const pane = (composer) => [
  `${ESC}[0m⏺ earlier output`,
  '─'.repeat(W),
  `${ESC}[39m❯ ${composer}`,
  '─'.repeat(W),
  `${ESC}[0m  ✦ Opus 5 (1M) | 📁 proj`,
].join('\n');
const EMPTY_PANE = pane('');

const userLine = (text) => JSON.stringify({
  type: 'user', timestamp: '2026-08-27T10:00:00.000Z', message: { role: 'user', content: text },
});

function ctx({ tmux = 'cc_abc', agent = 'claude', panes = [EMPTY_PANE], transcript = '/t.jsonl', tail = userLine('from the transcript') } = {}) {
  const calls = [];
  const replies = [];
  let capture = 0;
  return {
    calls,
    replies,
    captureCount: () => capture,
    sessionFromGraph: () => ({ liveSessionId: 'live-1', agent }),
    sessionManager: { entryFor: () => ({ liveSessionId: 'live-1', agent }) },
    tmuxFor: () => tmux,
    socketFor: () => 'sock',
    sendKeys: (name, keys, socket) => { calls.push({ verb: 'sendKeys', name, keys, socket }); },
    capturePaneStyled: async () => { const p = panes[Math.min(capture, panes.length - 1)]; capture += 1; return p; },
    findTranscript: async () => transcript,
    readTranscriptTail: async () => tail,
    reply: (o) => replies.push(o),
    // Real time is not worth spending in a unit test; the polling logic is what
    // matters, not the wall clock.
    sleep: async () => {},
    restoreSettleMs: 450,
    restorePollMs: 150,
  };
}

test('the interrupt goes first, and is a single Escape', async () => {
  const c = ctx();
  await interruptHandler.handler({ sessionId: 'card-1' }, c);
  assert.deepEqual(c.calls[0], { verb: 'sendKeys', name: 'cc_abc', keys: ['Escape'], socket: 'sock' });
  assert.equal(c.calls.filter((x) => x.verb === 'sendKeys').length, 1);
});

test('a draft in the pane wins — it is the only source that can show a pane edit', async () => {
  const c = ctx({ panes: [pane('the prompt as edited in the terminal')] });
  await interruptHandler.handler({ sessionId: 'card-1', token: 't1' }, c);
  assert.deepEqual(c.replies, [{
    type: 'interrupt-restore', sessionId: 'card-1', token: 't1',
    text: 'the prompt as edited in the terminal', source: 'pane',
  }]);
});

test('an empty pane falls back to a FRESH transcript read (the usual outcome)', async () => {
  // Measured against a live pane: the restore never happened for a multi-line
  // prompt and was not even repeatable for an identical single-line one, so this
  // path carries most real interrupts.
  const c = ctx({ panes: [EMPTY_PANE], tail: userLine('what was actually running') });
  await interruptHandler.handler({ sessionId: 'card-1', token: 't2' }, c);
  assert.deepEqual(c.replies[0].text, 'what was actually running');
  assert.equal(c.replies[0].source, 'transcript');
});

test('polling stops as soon as the restore appears, rather than waiting out the window', async () => {
  const c = ctx({ panes: [EMPTY_PANE, EMPTY_PANE, pane('appeared on the third look')] });
  await interruptHandler.handler({ sessionId: 'card-1', token: 't3' }, c);
  assert.equal(c.replies[0].source, 'pane');
  assert.equal(c.captureCount(), 3, 'no further captures once it is found');
});

test('the settle window is bounded — a pane that never restores does not hang the reply', async () => {
  const c = ctx({ panes: [EMPTY_PANE] });
  await interruptHandler.handler({ sessionId: 'card-1', token: 't4' }, c);
  // 450ms window at a 150ms poll: looks at 0, 150, 300, 450 and stops.
  assert.equal(c.captureCount(), 4);
  assert.equal(c.replies[0].source, 'transcript');
});

test('the transcript is not read at all when the pane already answered', async () => {
  let read = false;
  const c = ctx({ panes: [pane('from the pane')] });
  c.findTranscript = async () => { read = true; return '/t.jsonl'; };
  await interruptHandler.handler({ sessionId: 'card-1', token: 't5' }, c);
  assert.equal(read, false, 'the tail read is the more expensive of the two');
});

test('codex is still interrupted, but its pane is never parsed', async () => {
  // The pane parser is built for Claude's TUI; guessing at Codex's is exactly the
  // wrong-text failure it exists to avoid.
  const c = ctx({ agent: 'codex', panes: [pane('this must not be read')] });
  await interruptHandler.handler({ sessionId: 'card-1', token: 't6' }, c);
  assert.equal(c.captureCount(), 0, 'no pane read for codex');
  assert.deepEqual(c.calls[0].keys, ['Escape'], 'but it is still interrupted');
});

test('codex gets no restored prompt, because findTranscript cannot see its rollout', async () => {
  // PRE-EXISTING gap, asserted here so it is visible rather than surprising: this
  // handler resolves the transcript the same way chat.js does, with findTranscript,
  // which searches ~/.claude/projects. Codex rollouts live under ~/.codex/sessions
  // and are found by codex-rollout.js's findRollout instead, so the chat view
  // already shows nothing for a Codex session. Wiring that up is its own change;
  // what matters here is that Codex degrades to "no restore" rather than to a
  // WRONG restore.
  const c = ctx({ agent: 'codex', transcript: null });
  await interruptHandler.handler({ sessionId: 'card-1', token: 't6b' }, c);
  assert.deepEqual(
    { text: c.replies[0].text, source: c.replies[0].source },
    { text: null, source: 'none' },
  );
});

test('a session with no live pane still gets a reply, so the client is never left waiting', async () => {
  const c = ctx({ tmux: null });
  await interruptHandler.handler({ sessionId: 'card-1', token: 't7' }, c);
  assert.deepEqual(c.calls, []);
  assert.deepEqual(c.replies, [{
    type: 'interrupt-restore', sessionId: 'card-1', token: 't7', text: null, source: 'none',
  }]);
});

test('every reply echoes the token, including the nothing-found case', async () => {
  // The control socket does not await its handlers, so a reply for a session the
  // view has since left must be droppable rather than typed into the wrong box.
  const cases = [
    ctx({ panes: [pane('a draft')] }),
    ctx({ panes: [EMPTY_PANE] }),
    ctx({ tmux: null }),
    ctx({ panes: [EMPTY_PANE], transcript: null, tail: '' }),
  ];
  for (const c of cases) {
    await interruptHandler.handler({ sessionId: 'card-1', token: 'tok' }, c);
    assert.equal(c.replies.length, 1);
    assert.equal(c.replies[0].token, 'tok');
  }
});

test('no token supplied echoes null rather than undefined', async () => {
  const c = ctx();
  await interruptHandler.handler({ sessionId: 'card-1' }, c);
  assert.equal(c.replies[0].token, null);
});

test('nothing in the pane and nothing in the transcript reports none', async () => {
  const c = ctx({ panes: [EMPTY_PANE], transcript: null });
  await interruptHandler.handler({ sessionId: 'card-1', token: 't8' }, c);
  assert.deepEqual(
    { text: c.replies[0].text, source: c.replies[0].source },
    { text: null, source: 'none' },
  );
});

test('a doubtful pane read falls back rather than returning a corrupted prompt', async () => {
  // A line filling the pane may have been hard-broken mid-token, which rejoining
  // would silently corrupt — paneComposerDraft refuses, and this must land on the
  // transcript instead of on nothing.
  const full = 'x'.repeat(W - 2);
  const c = ctx({ panes: [pane(full)], tail: userLine('the exact original') });
  await interruptHandler.handler({ sessionId: 'card-1', token: 't9' }, c);
  assert.deepEqual(
    { text: c.replies[0].text, source: c.replies[0].source },
    { text: 'the exact original', source: 'transcript' },
  );
});
