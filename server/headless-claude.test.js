import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runHeadlessClaude, HEADLESS_DISALLOWED_TOOLS } from './headless-claude.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// The fake stands in for child_process.execFile: record the call, hand back a
// child whose stdin captures what was written, and settle on the next tick so
// the callback fires after runHeadlessClaude has written the payload — the same
// ordering the real binary gives.
function fakeExecFile(result) {
  const calls = [];
  const execFile = (file, args, opts, cb) => {
    const call = { file, args, opts, stdin: '' };
    calls.push(call);
    setImmediate(() => cb(result.err || null, result.stdout ?? ''));
    return { stdin: { end: (payload) => { call.stdin = payload; } } };
  };
  return { calls, execFile };
}

test('argv shape: model flag, joined disallowed tools, a uuid session id, prompt last', async () => {
  const f = fakeExecFile({ stdout: JSON.stringify({ result: 'ok' }) });
  await runHeadlessClaude('THE PROMPT', 'the payload', { execFile: f.execFile, model: 'sonnet' });
  const { file, args } = f.calls[0];
  assert.equal(file, 'claude');
  assert.equal(args[args.length - 1], 'THE PROMPT');
  assert.deepEqual(args.slice(0, 3), ['-p', '--model', 'sonnet']);
  assert.equal(args[args.indexOf('--disallowed-tools') + 1], HEADLESS_DISALLOWED_TOOLS.join(' '));
  assert.match(args[args.indexOf('--session-id') + 1], UUID_RE);
  // Tool-less and host-config-free, so a developer's own settings/MCP servers
  // can never leak into a classification call.
  assert.ok(args.includes('--strict-mcp-config'));
  assert.equal(args[args.indexOf('--setting-sources') + 1], '');
});

test('the model defaults to haiku', async () => {
  const f = fakeExecFile({ stdout: JSON.stringify({ result: 'ok' }) });
  await runHeadlessClaude('P', 'x', { execFile: f.execFile });
  assert.equal(f.calls[0].args[f.calls[0].args.indexOf('--model') + 1], 'haiku');
});

test('the payload goes on stdin, never in argv', async () => {
  const big = 'x'.repeat(300000);
  const f = fakeExecFile({ stdout: JSON.stringify({ result: 'ok' }) });
  await runHeadlessClaude('P', big, { execFile: f.execFile });
  assert.equal(f.calls[0].stdin, big);
  assert.ok(!f.calls[0].args.includes(big));
});

test('the reported liveSessionId is the one passed to --session-id', async () => {
  const f = fakeExecFile({ stdout: JSON.stringify({ result: 'ok' }) });
  const out = await runHeadlessClaude('P', 'x', { execFile: f.execFile });
  assert.equal(out.liveSessionId, f.calls[0].args[f.calls[0].args.indexOf('--session-id') + 1]);
});

test('the JSON result field is trimmed into text', async () => {
  const f = fakeExecFile({ stdout: JSON.stringify({ result: '  - a bullet\n\n' }) });
  const out = await runHeadlessClaude('P', 'x', { execFile: f.execFile });
  assert.deepEqual({ text: out.text, error: out.error }, { text: '- a bullet', error: null });
});

test('a non-string result field yields null text rather than garbage', async () => {
  const f = fakeExecFile({ stdout: JSON.stringify({ is_error: true }) });
  const out = await runHeadlessClaude('P', 'x', { execFile: f.execFile });
  assert.equal(out.text, null);
  assert.equal(out.error, null);
});

// Callers treat this as best-effort enrichment, so a broken run must come back
// as a value they can branch on — a rejection would become an unhandled
// rejection in the fire-and-forget callers.
test('non-JSON stdout resolves with the parse error, not a rejection', async () => {
  const f = fakeExecFile({ stdout: 'Usage: claude [options]' });
  const out = await runHeadlessClaude('P', 'x', { execFile: f.execFile });
  assert.equal(out.text, null);
  assert.ok(out.error instanceof Error);
  assert.match(out.liveSessionId, UUID_RE);
});

test('an exec error (timeout, missing binary) resolves with that error', async () => {
  const err = Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' });
  const f = fakeExecFile({ err, stdout: '' });
  const out = await runHeadlessClaude('P', 'x', { execFile: f.execFile });
  assert.deepEqual({ text: out.text, error: out.error }, { text: null, error: err });
});

test('each call gets its own fresh session id', async () => {
  const f = fakeExecFile({ stdout: JSON.stringify({ result: 'ok' }) });
  const a = await runHeadlessClaude('P', 'x', { execFile: f.execFile });
  const b = await runHeadlessClaude('P', 'x', { execFile: f.execFile });
  assert.notEqual(a.liveSessionId, b.liveSessionId);
});

test('the timeout is passed through and the env is stripped of nested-claude vars', async () => {
  const f = fakeExecFile({ stdout: JSON.stringify({ result: 'ok' }) });
  process.env.CLAUDE_CODE_TEST_LEAK = '1';
  try {
    await runHeadlessClaude('P', 'x', { execFile: f.execFile, timeoutMs: 5000 });
  } finally {
    delete process.env.CLAUDE_CODE_TEST_LEAK;
  }
  assert.equal(f.calls[0].opts.timeout, 5000);
  assert.equal(f.calls[0].opts.env.CLAUDE_CODE_TEST_LEAK, undefined);
});

test('env option is merged over the clean environment after nested-Claude variables are removed', async () => {
  const f = fakeExecFile({ stdout: JSON.stringify({ result: 'ok' }) });
  const previous = process.env.CLAUDECODE;
  process.env.CLAUDECODE = 'nested';
  try {
    await runHeadlessClaude('P', 'x', { execFile: f.execFile, env: { CLAUDE_CODE_OAUTH_TOKEN: 'fixture-token', AW_CONTEXT: 'secondary' } });
    const env = f.calls[0].opts.env;
    assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, 'fixture-token');
    assert.equal(env.AW_CONTEXT, 'secondary');
    assert.equal(env.CLAUDECODE, undefined);
    assert.equal(env.PATH, process.env.PATH);
  } finally {
    if (previous === undefined) delete process.env.CLAUDECODE;
    else process.env.CLAUDECODE = previous;
  }
});

test('hook env cannot restore nested Claude markers but keeps the explicit OAuth login', async () => {
  const f = fakeExecFile({ stdout: JSON.stringify({ result: 'ok' }) });
  await runHeadlessClaude('P', 'x', { execFile: f.execFile, env: {
    CLAUDECODE: '1',
    CLAUDE_CODE_ENTRYPOINT: 'nested',
    CLAUDE_CODE_SESSION_ID: 'nested-session',
    CLAUDE_CODE_EXECPATH: '/nested',
    CLAUDE_CODE_TMPDIR: '/nested-tmp',
    CLAUDE_JOB_DIR: '/nested-job',
    CLAUDE_CODE_CHILD_SESSION: '1',
    CLAUDE_CODE_OAUTH_TOKEN: 'fixture-token',
    AW_CONTEXT: 'secondary',
  } });
  const env = f.calls[0].opts.env;
  for (const key of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_EXECPATH', 'CLAUDE_CODE_TMPDIR', 'CLAUDE_JOB_DIR', 'CLAUDE_CODE_CHILD_SESSION']) {
    assert.equal(env[key], undefined, key);
  }
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, 'fixture-token');
  assert.equal(env.AW_CONTEXT, 'secondary');
  assert.equal(env.PATH, process.env.PATH);
});
