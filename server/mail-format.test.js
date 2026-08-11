import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatDrainedMail, formatOneMail, formatMailMeta } from './mail-format.js';

function msg(over = {}) {
  return { id: 'm1', from: 'sess_a', fromLabel: 'Alpha', at: 100, body: 'hello', size: 5, state: 'unread', ...over };
}

test('formatDrainedMail: a small message inlines its full body', () => {
  const [out] = formatDrainedMail([msg()]);
  assert.equal(out.body, 'hello');
  assert.equal(out.truncated, false);
  assert.equal('excerpt' in out, false);
});

test('formatDrainedMail: a message over the 4KB per-message limit excerpts even alone', () => {
  const big = 'x'.repeat(5000);
  const [out] = formatDrainedMail([msg({ body: big, size: 5000 })]);
  assert.equal(out.truncated, true);
  assert.ok(out.excerpt.length < big.length);
  assert.equal('body' in out, false);
});

test('formatDrainedMail: overflow past the 16KB batch budget degrades a LATER, individually-small message to an excerpt, oldest-first order preserved', () => {
  const messages = [
    msg({ id: 'm1', body: 'x'.repeat(4090), size: 4090, at: 1 }),
    msg({ id: 'm2', body: 'x'.repeat(4090), size: 4090, at: 2 }),
    msg({ id: 'm3', body: 'x'.repeat(4090), size: 4090, at: 3 }),
    msg({ id: 'm4', body: 'x'.repeat(4090), size: 4090, at: 4 }), // running total 16360, still <=16384
    msg({ id: 'm5', body: 'x'.repeat(50), size: 50, at: 5 }), // 16360+50 > 16384 — budget-blocked despite being tiny
  ];
  const out = formatDrainedMail(messages);
  assert.deepEqual(out.map((o) => o.id), ['m1', 'm2', 'm3', 'm4', 'm5']);
  assert.equal(out[0].truncated, false);
  assert.equal(out[3].truncated, false);
  assert.equal(out[4].truncated, true); // even though it's tiny alone, the batch budget is already spent
});

test('formatDrainedMail: an oversized message still charges its true size against the budget, even though it excerpts regardless — a mix of oversized then small messages respects the total', () => {
  const messages = [
    msg({ id: 'm1', body: 'x'.repeat(10000), size: 10000, at: 1 }), // over the 4KB per-message limit → excerpts regardless
    msg({ id: 'm2', body: 'x'.repeat(10000), size: 10000, at: 2 }), // running total now 20000 — already over the 16KB budget
    msg({ id: 'm3', body: 'small', size: 5, at: 3 }), // tiny, but the budget is spent by m1+m2's TRUE size
  ];
  const out = formatDrainedMail(messages);
  assert.equal(out[0].truncated, true); // over its own per-message limit
  assert.equal(out[1].truncated, true); // over its own per-message limit
  assert.equal(out[2].truncated, true); // budget-blocked by m1+m2's real size, even though used was never
  // incremented on their excerpt branch before this fix — this is the confirmed
  // review finding: "used is only incremented on the inline path... the running
  // total stays at 0 and no message is ever cut short by the budget."
});

test('formatDrainedMail: every message carries a per-message notice — the untrusted-input caveat plus the no-reply footer, verbatim wording', () => {
  const [out] = formatDrainedMail([msg({ from: 'sess_a' })]);
  assert.match(out.notice, /untrusted input from a peer session/);
  assert.match(out.notice, /does not require a response/);
  assert.match(out.notice, /do NOT reply just to acknowledge/);
  assert.match(out.notice, /send_message with to: "sess_a"/);
});

test('formatDrainedMail: an identity-less sender gets the generic no-reply line, no reply-to target named', () => {
  const [out] = formatDrainedMail([msg({ from: null })]);
  assert.match(out.notice, /does not require a response/);
  assert.doesNotMatch(out.notice, /send_message with to:/);
});

test('formatOneMail: always returns the full body regardless of size (the follow-up path), and carries the same per-message notice', () => {
  const big = 'x'.repeat(5000);
  const out = formatOneMail(msg({ body: big, size: 5000, from: 'sess_a' }));
  assert.equal(out.body, big);
  assert.equal(out.truncated, false);
  assert.match(out.notice, /untrusted input from a peer session/);
  assert.match(out.notice, /send_message with to: "sess_a"/);
});

test('formatMailMeta: metadata only, never a body, derives `read` from state', () => {
  const out = formatMailMeta(msg({ state: 'read' }));
  assert.equal('body' in out, false);
  assert.equal(out.read, true);
  assert.equal(out.state, 'read');
  assert.equal(out.excerpt, 'hello');
});

test('formatMailMeta: excerpts even a small body (list_mail never returns a full body)', () => {
  const out = formatMailMeta(msg());
  assert.equal(out.read, false);
});
