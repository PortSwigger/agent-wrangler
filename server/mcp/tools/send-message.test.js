import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sendMessageTool } from './send-message.js';

// A deps double with an injected sendText spy. tmuxFor/socketFor resolve only the
// "live" cards; everything else falls through to deliverMessage's dormant/archived
// handling, backed by a minimal sessionManager double (no entry ⇒ "gone").
function deps(sent) {
  const live = {
    CARD1: { tmux: 'cc_one', socket: '/sock/a', label: 'Alpha' },
    CARD2: { tmux: 'cc_two', socket: '/sock/b', label: 'Beta' },
  };
  return {
    graph: () => ({
      sessions: Object.entries(live).map(([sessionId, v]) => ({ sessionId, label: v.label })),
    }),
    tmuxFor: (id) => live[id]?.tmux ?? null,
    socketFor: (id) => live[id]?.socket ?? '',
    sendText: async (name, text, socket) => { sent.push({ name, text, socket }); },
    sessionManager: { entryFor: () => null, isResuming: () => false, resume: async () => ({}) },
    memoryStore: { bindSession: () => {} },
    taskStore: { taskFor: () => null },
    rebuild: async () => {},
  };
}

test('send_message delivers one wrapped prompt to the live target on its socket', async () => {
  const sent = [];
  const out = await sendMessageTool.handler({ deps: deps(sent), caller: 'CARD1' }, { to: 'CARD2', text: 'ping' });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].name, 'cc_two');
  assert.equal(sent[0].socket, '/sock/b');
  // Name-first: a human reading this pane later should see who sent it without
  // decoding a card id — the id trails in parens only as a lookup aid.
  assert.match(sent[0].text, /sender: Alpha \(CARD1\)/);
  assert.match(sent[0].text, /untrusted input from a peer session/);
  assert.match(sent[0].text, /ping/);
  assert.match(sent[0].text, /does not require a response/);
  assert.match(sent[0].text, /do NOT reply just to acknowledge/);
  assert.match(sent[0].text, /to: "CARD1"/);
  assert.deepEqual(out.structuredContent, { to: 'CARD2', label: 'Beta', delivered: true, woke: false });
});

test('send_message fences the body in matching BEGIN/END markers sharing a nonce', async () => {
  const sent = [];
  await sendMessageTool.handler({ deps: deps(sent), caller: 'CARD1' }, { to: 'CARD2', text: 'ping' });
  const m = sent[0].text.match(/--- BEGIN PEER MESSAGE ([0-9a-f]+) ---\nping\n--- END PEER MESSAGE ([0-9a-f]+) ---/);
  assert.ok(m, 'body is wrapped in BEGIN/END markers around the exact text');
  assert.equal(m[1], m[2], 'BEGIN and END share the same nonce');
});

test('the fence nonce is random per message, not derived from sender input', async () => {
  const sent = [];
  // A payload that tries to smuggle a fake END marker can never match the real
  // nonce, so it cannot break out of the fence.
  await sendMessageTool.handler({ deps: deps(sent), caller: 'CARD1' }, { to: 'CARD2', text: 'x' });
  await sendMessageTool.handler({ deps: deps(sent), caller: 'CARD1' }, { to: 'CARD2', text: 'x' });
  const nonceOf = (t) => t.match(/--- BEGIN PEER MESSAGE ([0-9a-f]+) ---/)[1];
  assert.notEqual(nonceOf(sent[0].text), nonceOf(sent[1].text), 'a fresh nonce each call');
});

test('send_message errors when the target is gone (no live tmux, no mapping entry)', async () => {
  const sent = [];
  const out = await sendMessageTool.handler({ deps: deps(sent), caller: 'CARD1' }, { to: 'GHOST', text: 'hi' });
  assert.equal(out.isError, true);
  assert.match(out.content[0].text, /not found/);
  assert.equal(sent.length, 0);
});

test('send_message wakes a dormant target: resumes with the wrapped message as the intent, and rebuilds the board', async () => {
  const sent = [];
  const d = deps(sent);
  const resumed = [];
  let rebuilt = 0;
  d.sessionManager = {
    entryFor: () => ({ cwd: '/x', agent: 'claude' }),
    isResuming: () => false,
    resume: async (id, dir, opts) => { resumed.push({ id, dir, opts }); return { tmux: 'cc_woken' }; },
  };
  d.rebuild = async () => { rebuilt += 1; };
  const out = await sendMessageTool.handler({ deps: d, caller: 'CARD1' }, { to: 'DORMANT1', text: 'wake up' });
  assert.equal(out.structuredContent.delivered, true);
  assert.equal(out.structuredContent.woke, true);
  assert.equal(resumed.length, 1);
  assert.match(resumed[0].opts.intent, /wake up/); // the wrapped message rides the resume intent
  assert.equal(sent.length, 0); // Claude + owned ⇒ delivered via intent, not a fallback paste
  assert.equal(rebuilt, 1);
});

test('send_message errors when the target is archived, without resuming it', async () => {
  const sent = [];
  const d = deps(sent);
  const resumed = [];
  d.sessionManager = {
    entryFor: () => ({ cwd: '/x', archivedAt: Date.now() }),
    isResuming: () => false,
    resume: async (id, dir, opts) => { resumed.push({ id, dir, opts }); return {}; },
  };
  const out = await sendMessageTool.handler({ deps: d, caller: 'CARD1' }, { to: 'ARCHIVED1', text: 'hi' });
  assert.equal(out.isError, true);
  assert.match(out.content[0].text, /archived/);
  assert.equal(resumed.length, 0);
  assert.equal(sent.length, 0);
});

test('send_message rejects a self-message', async () => {
  const sent = [];
  const out = await sendMessageTool.handler({ deps: deps(sent), caller: 'CARD2' }, { to: 'CARD2', text: 'hi' });
  assert.equal(out.isError, true);
  assert.match(out.content[0].text, /yourself/);
  assert.equal(sent.length, 0);
});

test('send_message uses generic attribution and omits the reply hint for a null caller', async () => {
  const sent = [];
  const out = await sendMessageTool.handler({ deps: deps(sent), caller: null }, { to: 'CARD1', text: 'ping' });
  assert.equal(out.structuredContent.delivered, true);
  assert.doesNotMatch(sent[0].text, /sender:/);
  assert.doesNotMatch(sent[0].text, /send_message with to:/);
  assert.match(sent[0].text, /^\[Inter-session message\]/);
  assert.match(sent[0].text, /does not require a response/);
  assert.match(sent[0].text, /--- BEGIN PEER MESSAGE [0-9a-f]+ ---/);
});

test('send_message returns the throttle error and does not deliver when gated', async () => {
  const sent = [];
  const d = deps(sent);
  d.messageThrottle = { check: () => ({ ok: false, error: 'Rate limited: slow down.' }) };
  const out = await sendMessageTool.handler({ deps: d, caller: 'CARD1' }, { to: 'CARD2', text: 'ping' });
  assert.equal(out.isError, true);
  assert.match(out.content[0].text, /Rate limited/);
  assert.equal(sent.length, 0);
});

test('send_message commits to the throttle only after a successful delivery', async () => {
  const sent = [];
  const calls = [];
  const d = deps(sent);
  d.messageThrottle = { check: (from, to) => { calls.push([from, to]); return { ok: true, commit: () => calls.push('commit') }; } };
  await sendMessageTool.handler({ deps: d, caller: 'CARD1' }, { to: 'CARD2', text: 'ping' });
  assert.deepEqual(calls, [['CARD1', 'CARD2'], 'commit']);
});

test('send_message: rejects an oversized body at send time, blaming the payload not the recipient — checked before mailCapable/mailbox-append even runs', async () => {
  const sent = [];
  const d = mailDeps(sent); // mailCapable recipient — would otherwise hit mailStore.append
  const out = await sendMessageTool.handler({ deps: d, caller: 'CARD1' }, { to: 'MAILBOX1', text: 'x'.repeat(33 * 1024) });
  assert.equal(out.isError, true);
  assert.match(out.content[0].text, /33KB.*over the 32KB limit/);
  assert.doesNotMatch(out.content[0].text, /backed up/); // never the box-cap wording
  assert.equal(d.appended.length, 0); // never reached the mailbox
});

test('send_message: a body right at the 32KB boundary is accepted', async () => {
  const sent = [];
  const d = mailDeps(sent);
  const out = await sendMessageTool.handler({ deps: d, caller: 'CARD1' }, { to: 'MAILBOX1', text: 'x'.repeat(32 * 1024) });
  assert.equal(out.isError, undefined);
});

test('send_message validates required args', async () => {
  const sent = [];
  const blankTo = await sendMessageTool.handler({ deps: deps(sent), caller: 'CARD1' }, { to: '  ', text: 'hi' });
  assert.equal(blankTo.isError, true);
  const blankText = await sendMessageTool.handler({ deps: deps(sent), caller: 'CARD1' }, { to: 'CARD2', text: '  ' });
  assert.equal(blankText.isError, true);
  assert.equal(sent.length, 0);
});

// --- mailbox path (recipient stamped mailCapable) ---

function mailDeps(sent, { archivedAt, appendError } = {}) {
  const d = deps(sent);
  const appended = [];
  d.sessionManager = {
    entryFor: (id) => (id === 'MAILBOX1' ? { mailCapable: true, archivedAt } : null),
    isResuming: () => false,
    resume: async () => ({}),
  };
  d.mailStore = {
    append: (to, msg) => {
      if (appendError) throw new Error(appendError);
      appended.push({ to, msg });
      return { id: 'mail_1' };
    },
  };
  d.appended = appended;
  return d;
}

test('send_message: a mailCapable recipient gets queued into the mailbox, not paste-pushed', async () => {
  const sent = [];
  const d = mailDeps(sent);
  const out = await sendMessageTool.handler({ deps: d, caller: 'CARD1' }, { to: 'MAILBOX1', text: 'hi' });
  assert.equal(sent.length, 0); // no pane paste at send time
  assert.deepEqual(out.structuredContent, { to: 'MAILBOX1', label: null, queued: true, id: 'mail_1' });
  assert.equal(d.appended.length, 1);
  assert.equal(d.appended[0].to, 'MAILBOX1');
  assert.equal(d.appended[0].msg.from, 'CARD1');
  assert.equal(d.appended[0].msg.body, 'hi');
});

test('send_message: `queued`, not `delivered`, and no `woke` field, for a mailCapable recipient', async () => {
  const sent = [];
  const d = mailDeps(sent);
  const out = await sendMessageTool.handler({ deps: d, caller: 'CARD1' }, { to: 'MAILBOX1', text: 'hi' });
  assert.equal('delivered' in out.structuredContent, false);
  assert.equal('woke' in out.structuredContent, false);
  assert.equal(out.structuredContent.queued, true);
});

test('send_message: a mailCapable but ARCHIVED recipient is refused, never boxed', async () => {
  const sent = [];
  const d = mailDeps(sent, { archivedAt: Date.now() });
  const out = await sendMessageTool.handler({ deps: d, caller: 'CARD1' }, { to: 'MAILBOX1', text: 'hi' });
  assert.equal(out.isError, true);
  assert.match(out.content[0].text, /archived/);
  assert.equal(d.appended.length, 0); // never written to the mailbox
});

test('send_message: a box-cap breach on append surfaces the store\'s error to the sender', async () => {
  const sent = [];
  const d = mailDeps(sent, { appendError: 'Recipient MAILBOX1 has too much unread mail' });
  const out = await sendMessageTool.handler({ deps: d, caller: 'CARD1' }, { to: 'MAILBOX1', text: 'hi' });
  assert.equal(out.isError, true);
  assert.match(out.content[0].text, /too much unread mail/);
});

test('send_message: mailbox path still honours the rate-limit gate before appending', async () => {
  const sent = [];
  const d = mailDeps(sent);
  d.messageThrottle = { check: () => ({ ok: false, error: 'Rate limited: slow down.' }) };
  const out = await sendMessageTool.handler({ deps: d, caller: 'CARD1' }, { to: 'MAILBOX1', text: 'hi' });
  assert.equal(out.isError, true);
  assert.match(out.content[0].text, /Rate limited/);
  assert.equal(d.appended.length, 0);
});

test('send_message: mailbox path commits the throttle only after a successful append', async () => {
  const sent = [];
  const d = mailDeps(sent);
  const calls = [];
  d.messageThrottle = { check: (from, to) => { calls.push([from, to]); return { ok: true, commit: () => calls.push('commit') }; } };
  await sendMessageTool.handler({ deps: d, caller: 'CARD1' }, { to: 'MAILBOX1', text: 'hi' });
  assert.deepEqual(calls, [['CARD1', 'MAILBOX1'], 'commit']);
});

test('send_message: a recipient with no mapping entry at all falls back to the legacy push (not an "unknown recipient" refusal)', async () => {
  // Mirrors buildGraph's "forkOwner" case: a live tmux with no mapping entry.
  // entryFor(to) === null ⇒ not mailCapable ⇒ today's push, unchanged.
  const sent = [];
  const out = await sendMessageTool.handler({ deps: deps(sent), caller: 'CARD1' }, { to: 'CARD2', text: 'ping' });
  assert.equal(out.structuredContent.delivered, true);
  assert.equal(sent.length, 1);
});
