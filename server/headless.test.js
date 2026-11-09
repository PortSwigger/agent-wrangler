import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runHeadless, resolveHeadlessTarget, backgroundModel, defaultBackgroundModel, headlessRunsInFlight, HEADLESS_MAX_TIMEOUT_MS } from './headless.js';
import { HEADLESS_DISALLOWED_TOOLS } from './agents/claude.js';
import { CODEX_HEADLESS_DISABLED_FEATURES } from './agents/codex.js';
import { adapterFor, registeredAgents } from './agents/index.js';

// The Claude half of these tests predates the generic runner: they pin the
// `claude -p` argv and env exactly as the archive review always ran it.
const HAIKU = { agent: 'claude', model: 'haiku' };
const runClaude = (prompt, stdin, { model, ...opts } = {}) => runHeadless({ prompt, stdin, agent: 'claude', model, background: HAIKU, ...opts });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// The fake stands in for child_process.execFile: record the call, hand back a
// child whose stdin captures what was written, and settle on the next tick so
// the callback fires after runHeadless has written the payload — the same
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
  await runClaude('THE PROMPT', 'the payload', { execFile: f.execFile, model: 'sonnet' });
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
  await runClaude('P', 'x', { execFile: f.execFile });
  assert.equal(f.calls[0].args[f.calls[0].args.indexOf('--model') + 1], 'haiku');
});

test('the payload goes on stdin, never in argv', async () => {
  const big = 'x'.repeat(300000);
  const f = fakeExecFile({ stdout: JSON.stringify({ result: 'ok' }) });
  await runClaude('P', big, { execFile: f.execFile });
  assert.equal(f.calls[0].stdin, big);
  assert.ok(!f.calls[0].args.includes(big));
});

test('the reported liveSessionId is the one passed to --session-id', async () => {
  const f = fakeExecFile({ stdout: JSON.stringify({ result: 'ok' }) });
  const out = await runClaude('P', 'x', { execFile: f.execFile });
  assert.equal(out.liveSessionId, f.calls[0].args[f.calls[0].args.indexOf('--session-id') + 1]);
});

test('the JSON result field is trimmed into text', async () => {
  const f = fakeExecFile({ stdout: JSON.stringify({ result: '  - a bullet\n\n' }) });
  const out = await runClaude('P', 'x', { execFile: f.execFile });
  assert.deepEqual({ text: out.text, error: out.error }, { text: '- a bullet', error: null });
});

test('a non-string result field yields null text rather than garbage', async () => {
  const f = fakeExecFile({ stdout: JSON.stringify({ is_error: true }) });
  const out = await runClaude('P', 'x', { execFile: f.execFile });
  assert.equal(out.text, null);
  assert.equal(out.error, null);
});

// Callers treat this as best-effort enrichment, so a broken run must come back
// as a value they can branch on — a rejection would become an unhandled
// rejection in the fire-and-forget callers.
test('non-JSON stdout resolves with the parse error, not a rejection', async () => {
  const f = fakeExecFile({ stdout: 'Usage: claude [options]' });
  const out = await runClaude('P', 'x', { execFile: f.execFile });
  assert.equal(out.text, null);
  assert.ok(out.error instanceof Error);
  assert.match(out.liveSessionId, UUID_RE);
});

test('an exec error (timeout, missing binary) resolves with that error', async () => {
  const err = Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' });
  const f = fakeExecFile({ err, stdout: '' });
  const out = await runClaude('P', 'x', { execFile: f.execFile });
  assert.deepEqual({ text: out.text, error: out.error }, { text: null, error: err });
});

test('each call gets its own fresh session id', async () => {
  const f = fakeExecFile({ stdout: JSON.stringify({ result: 'ok' }) });
  const a = await runClaude('P', 'x', { execFile: f.execFile });
  const b = await runClaude('P', 'x', { execFile: f.execFile });
  assert.notEqual(a.liveSessionId, b.liveSessionId);
});

test('the timeout is passed through and the env is stripped of nested-claude vars', async () => {
  const f = fakeExecFile({ stdout: JSON.stringify({ result: 'ok' }) });
  process.env.CLAUDE_CODE_TEST_LEAK = '1';
  try {
    await runClaude('P', 'x', { execFile: f.execFile, timeoutMs: 5000 });
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
    await runClaude('P', 'x', { execFile: f.execFile, env: { CLAUDE_CODE_OAUTH_TOKEN: 'fixture-token', AW_CONTEXT: 'secondary' } });
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
  await runClaude('P', 'x', { execFile: f.execFile, env: {
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

test('a Claude effort rides --effort, and the result names the agent and model it ran', async () => {
  const f = fakeExecFile({ stdout: JSON.stringify({ result: 'ok' }) });
  const out = await runClaude('P', 'x', { execFile: f.execFile, model: 'sonnet', effort: 'low' });
  assert.equal(f.calls[0].args[f.calls[0].args.indexOf('--effort') + 1], 'low');
  assert.equal(out.agent, 'claude');
  assert.equal(out.model, 'sonnet');
});

// ---- Codex ---------------------------------------------------------------
const CODEX_EVENTS = [
  { type: 'thread.started', thread_id: '01a1bfa1-0000-7000-8000-000000000001' },
  { type: 'item.completed', item: { id: 'item_0', type: 'error', message: 'Codex is ignoring 1 unrecognized configuration setting.' } },
  { type: 'turn.started' },
  { type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: '  - a fact\n' } },
  { type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 2 } },
].map((e) => JSON.stringify(e)).join('\n');

const codexModel = () => adapterFor('codex').models[0].value;

test('codex: `codex exec --json`, read-only, user config and tools off, payload on stdin', async () => {
  const f = fakeExecFile({ stdout: CODEX_EVENTS });
  const model = codexModel();
  await runHeadless({ prompt: 'THE PROMPT', stdin: 'the payload', agent: 'codex', model, effort: 'low', execFile: f.execFile });
  const { file, args, stdin, opts } = f.calls[0];
  assert.equal(file, 'codex');
  assert.deepEqual(args.slice(0, 2), ['exec', '--json']);
  for (const flag of ['--skip-git-repo-check', '--ignore-user-config', '--ignore-rules']) assert.ok(args.includes(flag), flag);
  assert.equal(args[args.indexOf('--sandbox') + 1], 'read-only');
  assert.equal(args[args.indexOf('-m') + 1], model);
  assert.equal(args[args.indexOf('-C') + 1], opts.cwd);
  assert.ok(args.includes('model_reasoning_effort=low'));
  assert.ok(args.includes('web_search="disabled"'));
  const disabled = args.flatMap((a, i) => (a === '--disable' ? [args[i + 1]] : []));
  assert.deepEqual(disabled, CODEX_HEADLESS_DISABLED_FEATURES);
  assert.equal(args.at(-1), 'THE PROMPT');
  assert.equal(stdin, 'the payload');
});

test('codex: the answer is the last agent_message, the id is thread.started, warning items are ignored', async () => {
  const f = fakeExecFile({ stdout: CODEX_EVENTS });
  const out = await runHeadless({ prompt: 'P', agent: 'codex', model: codexModel(), execFile: f.execFile });
  assert.deepEqual(out, { text: '- a fact', liveSessionId: '01a1bfa1-0000-7000-8000-000000000001', agent: 'codex', model: codexModel(), error: null });
});

test('codex: a failed turn is an error, and the conversation it started is still reported for billing', async () => {
  const stdout = [
    JSON.stringify({ type: 'thread.started', thread_id: 'T-1' }),
    JSON.stringify({ type: 'turn.failed', error: { message: 'model not available' } }),
  ].join('\n');
  const f = fakeExecFile({ err: new Error('exit 1'), stdout });
  const out = await runHeadless({ prompt: 'P', agent: 'codex', model: codexModel(), execFile: f.execFile });
  assert.equal(out.text, null);
  assert.equal(out.liveSessionId, 'T-1');
  assert.match(out.error.message, /exit 1/);
  const g = fakeExecFile({ stdout });
  const zero = await runHeadless({ prompt: 'P', agent: 'codex', model: codexModel(), execFile: g.execFile });
  assert.equal(zero.error.message, 'model not available', 'a failed turn is an error even on exit 0');
});

// ---- Resolution ----------------------------------------------------------
test('with nothing named a run uses the Background model', async () => {
  const f = fakeExecFile({ stdout: CODEX_EVENTS });
  const out = await runHeadless({ prompt: 'P', execFile: f.execFile, background: { agent: 'codex', model: codexModel() } });
  assert.equal(f.calls[0].file, 'codex');
  assert.equal(out.model, codexModel());
});

test('an agent alone runs the Background model when it is that agent, else its own headless default', () => {
  const background = { agent: 'claude', model: 'sonnet' };
  assert.equal(resolveHeadlessTarget({ agent: 'claude' }, { background }).model, 'sonnet');
  assert.equal(resolveHeadlessTarget({ agent: 'codex' }, { background }).model, adapterFor('codex').headless.defaultModel());
  assert.equal(resolveHeadlessTarget({ model: 'haiku' }, { background }).agent, 'claude', 'a model alone belongs to the Background agent');
});

test('a bad call rejects rather than running something else', async () => {
  const background = HAIKU;
  assert.throws(() => resolveHeadlessTarget({ agent: 'nope' }, { background }), /Unknown agent "nope"/);
  assert.throws(() => resolveHeadlessTarget({ agent: 'claude', model: 'gpt-x' }, { background }), /Unknown model "gpt-x" for agent "claude"/);
  assert.throws(() => resolveHeadlessTarget({ agent: 'claude', effort: 'ultra' }, { background }), /Unknown effort "ultra"/);
  const toolless = { id: 'plain', models: [{ value: 'm' }] };
  assert.throws(() => resolveHeadlessTarget({ agent: 'plain' }, { background, resolve: () => toolless }), /has no headless mode/);
  const f = fakeExecFile({ stdout: '{}' });
  await assert.rejects(runHeadless({ prompt: '', execFile: f.execFile, background }), /prompt must be a non-empty string/);
  await assert.rejects(runHeadless({ prompt: 'P', stdin: 5, execFile: f.execFile, background }), /stdin must be a string/);
  await assert.rejects(runHeadless({ prompt: 'P', timeoutMs: -1, execFile: f.execFile, background }), /timeoutMs/);
  assert.equal(f.calls.length, 0);
});

test('timeoutMs is capped and the in-flight count settles back to zero', async () => {
  const f = fakeExecFile({ stdout: JSON.stringify({ result: 'ok' }) });
  const pending = runClaude('P', 'x', { execFile: f.execFile, timeoutMs: HEADLESS_MAX_TIMEOUT_MS * 10 });
  assert.equal(headlessRunsInFlight(), 1);
  await pending;
  assert.equal(f.calls[0].opts.timeout, HEADLESS_MAX_TIMEOUT_MS);
  assert.equal(headlessRunsInFlight(), 0);
});

test('the Background model defaults to Claude Haiku and falls back when the stored one cannot run', () => {
  assert.deepEqual(defaultBackgroundModel(), HAIKU);
  assert.deepEqual(backgroundModel({ cfg: {} }), HAIKU);
  const codex = codexModel();
  assert.deepEqual(backgroundModel({ cfg: { backgroundModel: { agent: 'codex', model: codex } } }), { agent: 'codex', model: codex });
  assert.deepEqual(backgroundModel({ cfg: { backgroundModel: { agent: 'codex', model: 'retired-model' } } }), HAIKU);
  assert.deepEqual(backgroundModel({ cfg: { backgroundModel: { agent: 'gone', model: 'x' } } }), HAIKU);
  assert.deepEqual(backgroundModel({ cfg: { backgroundModel: 'claude:haiku' } }), HAIKU);
  // The default is read off the registry's adapters, not an id: the first that can run headless.
  const fixture = [{ id: 'plain', models: [] }, { id: 'oneshot', models: [{ value: 'small' }], headless: { defaultModel: () => 'small' } }];
  assert.deepEqual(defaultBackgroundModel(fixture), { agent: 'oneshot', model: 'small' });
  assert.ok(registeredAgents().every((a) => a.headless), 'every built-in adapter can run headless');
});
