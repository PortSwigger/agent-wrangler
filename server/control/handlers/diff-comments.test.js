import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { diffCommentsHandler, formatDiffComments } from './diff-comments.js';

// Snapshot strings below are shaped as rangeSnapshot (client-side) actually produces
// them: one `>`-marked row per commented line, plus unmarked context rows around it —
// formatDiffComments only indents this, it must NOT add its own quoting on top.
test('formatDiffComments: multiple comments across files → one grouped message', () => {
  const msg = formatDiffComments([
    { file: 'src/a.js', side: 'new', line: 88, snapshot: '  87: let x;\n> 88: const x = 1;\n  89: use(x);', body: 'rename x' },
    { file: 'src/b.js', side: 'old', line: 12, snapshot: '> 12: gone()', body: 'why removed?' },
    { file: 'src/a.js', side: 'new', line: 90, snapshot: '> 90: return x;', body: 'return y' },
  ]);
  assert.match(msg, /^Review comments on the working-tree diff \(3\):/);
  assert.match(msg, /src\/a\.js:88 \(new\)\n {6}87: let x;\n {4}> 88: const x = 1;\n {6}89: use\(x\);\n {4}rename x/);
  assert.match(msg, /src\/b\.js:12 \(old\)/);
  // same-file comments group together: both a.js lines precede the b.js line.
  assert.ok(msg.indexOf('src/a.js:88') < msg.indexOf('src/a.js:90'));
  assert.ok(msg.indexOf('src/a.js:90') < msg.indexOf('src/b.js:12'));
});

test('formatDiffComments: a mix of single-line and range comments → one message, spans + indented snapshot', () => {
  const msg = formatDiffComments([
    { file: 'src/a.js', side: 'new', startLine: 12, endLine: 14, snapshot: '> 12: a();\n> 13: b();\n> 14: c();', body: 'extract a helper' },
    { file: 'src/a.js', side: 'new', startLine: 20, endLine: 20, snapshot: '> 20: return x;', body: 'return y' },
  ]);
  assert.match(msg, /^Review comments on the working-tree diff \(2\):/);
  // A range: `start-end` and the snapshot's own per-line `>` markers, just indented.
  assert.match(msg, /src\/a\.js:12-14 \(new\)\n {4}> 12: a\(\);\n {4}> 13: b\(\);\n {4}> 14: c\(\);\n {4}extract a helper/);
  // A single line keeps the `line` form (start === end).
  assert.match(msg, /src\/a\.js:20 \(new\)\n {4}> 20: return x;\n {4}return y/);
});

test('formatDiffComments: a legacy single-line comment (line field) still renders the line form', () => {
  const msg = formatDiffComments([{ file: 'f.js', side: 'old', line: 7, snapshot: '> 7: gone()', body: 'why?' }]);
  assert.match(msg, /f\.js:7 \(old\)\n {4}> 7: gone\(\)\n {4}why\?/);
});

test('formatDiffComments: a legacy plain-text snapshot (pre-context, no marker) is just indented', () => {
  const msg = formatDiffComments([{ file: 'f.js', side: 'new', line: 3, snapshot: 'gone()', body: 'why?' }]);
  assert.match(msg, /f\.js:3 \(new\)\n {4}gone\(\)\n {4}why\?/);
});

test('formatDiffComments: PR source names the pull request and repo', () => {
  const msg = formatDiffComments(COMMENTS, {
    mode: 'pr',
    prNumber: 42,
    prRepo: 'acme/widgets',
    prUrl: 'https://github.com/acme/widgets/pull/42',
  });
  assert.match(msg, /^Review comments on PR #42 \(acme\/widgets\) https:\/\/github\.com\/acme\/widgets\/pull\/42 \(1\):/);
  assert.match(msg, /Line numbers refer to the PR diff\./);
});

test('formatDiffComments: PR source without repo still names the pull request', () => {
  const msg = formatDiffComments(COMMENTS, { mode: 'pr', prNumber: 42 });
  assert.match(msg, /^Review comments on PR #42 \(1\):/);
});

test('formatDiffComments: branch source names the full branch diff', () => {
  const msg = formatDiffComments(COMMENTS, { mode: 'branch' });
  assert.match(msg, /^Review comments on the full branch diff \(1\):/);
});

// ctx double: tmuxFor reflects a `live` flag that resume() flips true; records
// sendText calls, resume calls, and replies. sendText is injected via ctx (test
// seam) so no real tmux is touched.
function makeCtx({ live, sessionLinks = [], taskLinks = [] }) {
  const calls = { sends: [], sent: [], resumed: 0, settled: 0, order: [] };
  let isLive = live;
  const ctx = {
    sessionManager: {
      entryFor: () => ({ cwd: os.tmpdir(), liveSessionId: 'L1' }),
      getLinks: () => sessionLinks,
      resume: async () => { calls.resumed += 1; calls.order.push('resume'); isLive = true; return { tmux: 'cc_1' }; },
    },
    memoryStore: { bindSession: () => {} },
    taskStore: { taskFor: () => ({ id: 'T1' }), getLinks: () => taskLinks },
    rebuild: async () => {},
    tmuxFor: () => (isLive ? 'cc_1' : null),
    socketFor: () => 'sockA',
    reply: (o) => calls.sent.push(o),
    // Readiness settle seam (F) — records that/when the resume-path settle ran, so a
    // test never touches a real tmux pane and the suite stays fast.
    waitForPaneReady: async () => { calls.settled += 1; calls.order.push('settle'); return true; },
    sendText: async (name, text, socket) => { calls.order.push('send'); calls.sends.push({ name, text, socket }); },
  };
  return { ctx, calls };
}

const COMMENTS = [{ file: 'f.js', side: 'new', line: 3, snapshot: 'foo()', body: 'add test' }];

test('diff-comments: a live session gets the formatted message via sendText, replies ok', async () => {
  const { ctx, calls } = makeCtx({ live: true });
  await diffCommentsHandler.handler({ type: 'diff-comments', sessionId: 'S1', comments: COMMENTS }, ctx);
  assert.equal(calls.resumed, 0, 'no resume for a live session');
  assert.equal(calls.settled, 0, 'no settle on the already-live path');
  assert.equal(calls.sends.length, 1);
  assert.equal(calls.sends[0].name, 'cc_1');
  assert.equal(calls.sends[0].socket, 'sockA');
  assert.equal(calls.sends[0].text, formatDiffComments(COMMENTS));
  assert.deepEqual(calls.sent, [{ type: 'diff-comments-result', sessionId: 'S1', ok: true }]);
});

test('diff-comments: passes PR source metadata into the delivered message', async () => {
  const { ctx, calls } = makeCtx({
    live: true,
    sessionLinks: [{ type: 'pr', url: 'https://github.com/acme/widgets/pull/42', repo: 'acme/widgets', number: 42 }],
  });
  await diffCommentsHandler.handler({
    type: 'diff-comments',
    sessionId: 'S1',
    comments: COMMENTS,
    mode: 'pr',
    prUrl: 'https://github.com/acme/widgets/pull/42',
    prNumber: 99,
    prRepo: 'forged/repo',
  }, ctx);
  assert.equal(calls.sends[0].text, formatDiffComments(COMMENTS, {
    mode: 'pr',
    prUrl: 'https://github.com/acme/widgets/pull/42',
    prNumber: 42,
    prRepo: 'acme/widgets',
  }));
});

test('diff-comments: accepts task-linked PR comments', async () => {
  const { ctx, calls } = makeCtx({
    live: true,
    taskLinks: [{ type: 'pr', url: 'https://github.com/acme/api/pull/7', repo: 'acme/api', number: 7 }],
  });
  await diffCommentsHandler.handler({
    type: 'diff-comments',
    sessionId: 'S1',
    comments: COMMENTS,
    mode: 'pr',
    prUrl: 'https://github.com/acme/api/pull/7',
  }, ctx);
  assert.equal(calls.sends.length, 1);
  assert.match(calls.sends[0].text, /PR #7 \(acme\/api\) https:\/\/github\.com\/acme\/api\/pull\/7/);
  assert.equal(calls.sent[0].ok, true);
});

test('diff-comments: rejects PR comments with no PR URL', async () => {
  const { ctx, calls } = makeCtx({
    live: true,
    sessionLinks: [{ type: 'pr', url: 'https://github.com/acme/widgets/pull/42', repo: 'acme/widgets', number: 42 }],
  });
  await diffCommentsHandler.handler({
    type: 'diff-comments',
    sessionId: 'S1',
    comments: COMMENTS,
    mode: 'pr',
  }, ctx);
  assert.equal(calls.sends.length, 0);
  assert.equal(calls.sent[0].ok, false);
  assert.match(calls.sent[0].error, /not linked/i);
});

test('diff-comments: rejects PR comments for an unlinked PR URL', async () => {
  const { ctx, calls } = makeCtx({
    live: true,
    sessionLinks: [{ type: 'pr', url: 'https://github.com/acme/widgets/pull/42', repo: 'acme/widgets', number: 42 }],
  });
  await diffCommentsHandler.handler({
    type: 'diff-comments',
    sessionId: 'S1',
    comments: COMMENTS,
    mode: 'pr',
    prUrl: 'https://github.com/acme/widgets/pull/99',
  }, ctx);
  assert.equal(calls.sends.length, 0);
  assert.equal(calls.sent[0].ok, false);
  assert.match(calls.sent[0].error, /not linked/i);
});

test('diff-comments: a dormant session is resumed BEFORE sendText', async () => {
  const { ctx, calls } = makeCtx({ live: false });
  await diffCommentsHandler.handler({ type: 'diff-comments', sessionId: 'S1', comments: COMMENTS }, ctx);
  assert.equal(calls.resumed, 1, 'dormant session resumed');
  assert.equal(calls.settled, 1, 'resume path settles before delivery');
  assert.deepEqual(calls.order, ['resume', 'settle', 'send'], 'resume, then settle, then delivery');
  assert.equal(calls.sends[0].text, formatDiffComments(COMMENTS));
  assert.deepEqual(calls.sent, [{ type: 'diff-comments-result', sessionId: 'S1', ok: true }]);
});

test('diff-comments: delivery failure replies ok:false so the client keeps drafts', async () => {
  const { ctx, calls } = makeCtx({ live: true });
  ctx.sendText = async () => { throw new Error('pane gone'); };
  await diffCommentsHandler.handler({ type: 'diff-comments', sessionId: 'S1', comments: COMMENTS }, ctx);
  assert.equal(calls.sent[0].type, 'diff-comments-result');
  assert.equal(calls.sent[0].ok, false);
  assert.match(calls.sent[0].error, /pane gone/);
});

test('diff-comments: no comments replies ok:false without touching the pane', async () => {
  const { ctx, calls } = makeCtx({ live: true });
  await diffCommentsHandler.handler({ type: 'diff-comments', sessionId: 'S1', comments: [] }, ctx);
  assert.equal(calls.sends.length, 0);
  assert.equal(calls.sent[0].ok, false);
});
