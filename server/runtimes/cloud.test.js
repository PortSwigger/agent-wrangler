import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cloud, CLOUD_TMUX_PREFIX, classifyEnvironmentId, buildCloudCreateCommand,
  buildCloudAttachCommand, buildTeleportCommand, assertNoPromptWithCloudDescription,
  parseCloudLaunchLog,
} from './cloud.js';

// `withCleanClaudeEnv`'s `env -u …` prefix is dynamic (it strips every inherited
// CLAUDE_CODE_* var, so its length depends on the ambient env). Assert the prefix
// separately and compare the `claude …` invocation byte-for-byte — the env vars are
// upper-case, so the first lower-case `claude ` is always the binary.
const invocation = (cmd) => cmd.slice(cmd.indexOf('claude '));
const assertCleanEnv = (cmd) => {
  assert.ok(cmd.startsWith('env -u '), `expected a withCleanClaudeEnv prefix, got: ${cmd}`);
  assert.match(cmd, /(?:^|\s)-u CLAUDECODE(?:\s|$)/);
};

test('cloud: tmux prefix is the cl_ one declared in the agent registry', () => {
  assert.equal(CLOUD_TMUX_PREFIX, 'cl_');
});

test('classifyEnvironmentId: env_ / ccpool_ / empty, and garbage throws', () => {
  assert.equal(classifyEnvironmentId('env_abc123'), 'anthropic');
  assert.equal(classifyEnvironmentId('ccpool_abc123'), 'self-hosted');
  assert.equal(classifyEnvironmentId(''), 'default');
  assert.equal(classifyEnvironmentId(null), 'default');
  assert.equal(classifyEnvironmentId(undefined), 'default');
  assert.equal(classifyEnvironmentId('   '), 'default');
  assert.throws(() => classifyEnvironmentId('env-abc'), /Unrecognised cloud environment id/);
  assert.throws(() => classifyEnvironmentId('pool_abc'), /Unrecognised cloud environment id/);
});

test('create: account default is the interactive --cloud form, no --settings, no -p', () => {
  const cmd = buildCloudCreateCommand({ intent: 'fix the flaky test' });
  assertCleanEnv(cmd);
  assert.equal(invocation(cmd), "claude --cloud 'fix the flaky test'");
});

test('create: an env_ id adds the inline remote.defaultEnvironmentId settings', () => {
  const cmd = buildCloudCreateCommand({ intent: 'fix the flaky test', environmentId: 'env_0123abc' });
  assertCleanEnv(cmd);
  assert.equal(
    invocation(cmd),
    `claude --cloud 'fix the flaky test' --settings '{"remote":{"defaultEnvironmentId":"env_0123abc"}}'`,
  );
});

test('create: a ccpool_ id is the -p/--environment/json form, with --ref when given', () => {
  const cmd = buildCloudCreateCommand({ intent: 'fix the flaky test', environmentId: 'ccpool_9z', ref: 'main' });
  assertCleanEnv(cmd);
  assert.equal(
    invocation(cmd),
    "claude -p 'fix the flaky test' --environment 'ccpool_9z' --ref 'main' --output-format json",
  );
});

test('create: self-hosted without a ref omits --ref entirely', () => {
  const cmd = buildCloudCreateCommand({ intent: 'go', environmentId: 'ccpool_9z' });
  assert.equal(invocation(cmd), "claude -p 'go' --environment 'ccpool_9z' --output-format json");
});

test('create: --ref is NEVER emitted on the anthropic/default form', () => {
  for (const environmentId of ['', 'env_0123abc']) {
    const cmd = buildCloudCreateCommand({ intent: 'go', environmentId, ref: 'some-branch' });
    assert.ok(!cmd.includes('--ref'), `--ref leaked into the anthropic form: ${cmd}`);
    assert.ok(!cmd.includes('some-branch'));
  }
});

test('create: an intent is required, and a malformed environment id refuses', () => {
  assert.throws(() => buildCloudCreateCommand({ intent: '   ' }), /needs an intent/);
  assert.throws(() => buildCloudCreateCommand({ intent: 'go', environmentId: 'nope_1' }), /Unrecognised cloud environment id/);
});

test('create: shell metacharacters in the intent are quoted, not interpreted', () => {
  const cmd = buildCloudCreateCommand({ intent: "don't; rm -rf $HOME" });
  assert.equal(invocation(cmd), `claude --cloud 'don'\\''t; rm -rf $HOME'`);
});

test('guard: -p plus a --cloud DESCRIPTION throws (silent-local-run footgun)', () => {
  assert.throws(
    () => assertNoPromptWithCloudDescription("env -u CLAUDECODE claude -p 'do the thing' --cloud 'do the thing'"),
    /silently runs the prompt LOCALLY/,
  );
  assert.throws(
    () => assertNoPromptWithCloudDescription('claude --print --cloud make-me-a-sandwich'),
    /silently runs the prompt LOCALLY/,
  );
});

test('guard: the real forms and a steer by session id do NOT trip it', () => {
  // Anthropic create: --cloud with a description but no -p.
  assertNoPromptWithCloudDescription(buildCloudCreateCommand({ intent: 'do the thing' }));
  // Self-hosted create: -p but no --cloud at all.
  assertNoPromptWithCloudDescription(buildCloudCreateCommand({ intent: 'do the thing', environmentId: 'ccpool_1' }));
  // Steering an existing session is legitimately -p + --cloud <session_…>.
  assertNoPromptWithCloudDescription("claude -p 'nudge' --cloud 'session_01ABC' --output-format json");
});

test('guard: a flag-shaped intent inside quotes is not read as a -p flag', () => {
  const cmd = buildCloudCreateCommand({ intent: 'retry the build with -p set and --print too' });
  assert.equal(invocation(cmd), "claude --cloud 'retry the build with -p set and --print too'");
});

// shellQuote escapes an apostrophe as `'\''`, which closes one quoted span and
// opens another — so a flag-shaped word AFTER an apostrophe used to land outside
// every span and refuse a perfectly ordinary intent.
test('guard: an apostrophe in the intent does not expose a later -p to the flag scan', () => {
  const cmd = buildCloudCreateCommand({ intent: "don't run this with -p, or --print" });
  assert.equal(invocation(cmd), `claude --cloud 'don'\\''t run this with -p, or --print'`);
});

test('attach / teleport: byte-exact, and only for a session_ id', () => {
  const attach = buildCloudAttachCommand({ cloudSessionId: 'session_01ABCdef' });
  assertCleanEnv(attach);
  assert.equal(invocation(attach), "claude --cloud 'session_01ABCdef'");
  // Teleport PRESETS the local conversation id: a teleported session writes no
  // transcript until its first message, so discovering the id afterwards is
  // impossible and `--session-id` is the only way the card can know it.
  const teleport = buildTeleportCommand({ cloudSessionId: 'session_01ABCdef', liveSessionId: '9f1c0b6e-1111-4222-8333-444455556666' });
  assertCleanEnv(teleport);
  assert.equal(invocation(teleport), "claude --teleport 'session_01ABCdef' --session-id '9f1c0b6e-1111-4222-8333-444455556666'");
  // A card id or a liveSessionId uuid is a different namespace and must be refused.
  assert.throws(() => buildCloudAttachCommand({ cloudSessionId: 's-1770000000000-ab12' }), /without a session_… id/);
  assert.throws(() => buildTeleportCommand({ cloudSessionId: '9f1c0b6e-1111-4222-8333-444455556666', liveSessionId: '9f1c0b6e-1111-4222-8333-444455556666' }), /without a session_… id/);
  assert.throws(() => buildCloudAttachCommand({}), /without a session_… id/);
  // …and the reverse confusion: the uuid slot must not accept a card id or the
  // session_… id, both of which `claude` would reject outright and dead-pane.
  assert.throws(() => buildTeleportCommand({ cloudSessionId: 'session_01ABCdef' }), /without a uuid/);
  assert.throws(() => buildTeleportCommand({ cloudSessionId: 'session_01ABCdef', liveSessionId: 'session_01ABCdef' }), /without a uuid/);
  assert.throws(() => buildTeleportCommand({ cloudSessionId: 'session_01ABCdef', liveSessionId: 's-1770000000000-ab12' }), /without a uuid/);
});

const INTERACTIVE_LOG = [
  '',
  '  Created cloud session',
  '',
  '  View: https://claude.ai/code/session_01ABCdef',
  '  Resume with: claude --cloud session_01ABCdef',
  '',
].join('\n');

test('parseCloudLaunchLog: the interactive Created/View/Resume block', () => {
  const parsed = parseCloudLaunchLog(INTERACTIVE_LOG);
  assert.deepEqual(parsed, {
    cloudSessionId: 'session_01ABCdef',
    url: 'https://claude.ai/code/session_01ABCdef',
    attachRefused: false,
    sawCreated: true,
  });
});

test('parseCloudLaunchLog: ANSI escapes in the piped pane log do not hide the id or URL', () => {
  const noisy = '\x1B[2K\x1B[36m  Created cloud session\x1B[0m\r\n'
    + '\x1B[1m  View: https://claude.ai/code/session_01ABCdef\x1B[0m\r\n';
  const parsed = parseCloudLaunchLog(noisy);
  assert.equal(parsed.cloudSessionId, 'session_01ABCdef');
  assert.equal(parsed.url, 'https://claude.ai/code/session_01ABCdef');
  assert.equal(parsed.sawCreated, true);
});

test('parseCloudLaunchLog: the self-hosted single JSON line', () => {
  const parsed = parseCloudLaunchLog('{"type":"result","session_id":"session_ZZ99","url":"https://claude.ai/code/session_ZZ99"}\n');
  assert.equal(parsed.cloudSessionId, 'session_ZZ99');
  assert.equal(parsed.url, 'https://claude.ai/code/session_ZZ99');
  assert.equal(parsed.attachRefused, false);
  assert.equal(parsed.sawCreated, false);
});

test('parseCloudLaunchLog: a JSON line wins over a stray earlier session_ token', () => {
  const text = 'resuming session_OLD1 …\n{"session_id":"session_NEW2"}\n';
  assert.equal(parseCloudLaunchLog(text).cloudSessionId, 'session_NEW2');
});

test('parseCloudLaunchLog: the attach refusal line is detected verbatim', () => {
  const parsed = parseCloudLaunchLog('Error: Attaching to an existing cloud session is not enabled for your account.\n');
  assert.equal(parsed.attachRefused, true);
  assert.equal(parsed.sawCreated, false);
  assert.equal(parsed.cloudSessionId, null);
});

test('parseCloudLaunchLog: a log with none of the markers is all-null/false', () => {
  assert.deepEqual(parseCloudLaunchLog('$ \nsome unrelated pane noise\n'), {
    cloudSessionId: null, url: null, attachRefused: false, sawCreated: false,
  });
  assert.deepEqual(parseCloudLaunchLog(''), {
    cloudSessionId: null, url: null, attachRefused: false, sawCreated: false,
  });
});

test('parseCloudLaunchLog: a non-claude.ai (or non-https) View URL is dropped, not stored', () => {
  const evil = 'Created cloud session\nView: https://claude.ai.evil.example/code/session_01ABCdef\n';
  const parsed = parseCloudLaunchLog(evil);
  assert.equal(parsed.cloudSessionId, 'session_01ABCdef');
  assert.equal(parsed.url, null);
  assert.equal(parseCloudLaunchLog('View: http://claude.ai/code/session_01ABCdef\n').url, null);
  assert.equal(parseCloudLaunchLog('View: javascript:alert(1) session_01ABCdef\n').url, null);
});

test('cloud runtime: id, resume-guard skip, identity wrapLaunch, truthy empty analyze, no readLive', async () => {
  assert.equal(cloud.id, 'cloud');
  assert.equal(cloud.skipsHostResumeGuard, true);
  assert.equal(await cloud.wrapLaunch({ inner: 'claude --cloud x' }), 'claude --cloud x');
  // Truthy on purpose: state-reader's `runtime.analyze(...) || <host scan>` means a
  // falsey result silently re-enables the host-transcript scan cloud must never do.
  assert.deepEqual(await cloud.analyze({ entry: {}, liveSid: 'whatever' }),
    { usd: null, subAgentUsd: 0, advisorUsd: 0, tokens: null, subAgents: [] });
  assert.equal(cloud.readLive, undefined);
  assert.equal(typeof cloud.buildLaunch, 'function');
  assert.equal(typeof cloud.preflight, 'function');
});

test('cloud runtime: buildLaunch dispatch creates, resume attaches, anything else throws', () => {
  const dispatch = cloud.buildLaunch({
    mode: 'dispatch', intent: 'go', cloud: { environmentId: 'ccpool_1', ref: 'dev' },
  });
  assert.equal(invocation(dispatch), "claude -p 'go' --environment 'ccpool_1' --ref 'dev' --output-format json");
  const resume = cloud.buildLaunch({ mode: 'resume', entry: { cloud: { sessionId: 'session_01ABCdef' } } });
  assert.equal(invocation(resume), "claude --cloud 'session_01ABCdef'");
  // A fork (or any unknown mode) must never fall through to the create form and
  // silently start a brand-new paid cloud session.
  assert.throws(() => cloud.buildLaunch({ mode: 'fork', intent: 'go' }), /cannot build a "fork" launch/);
  assert.throws(() => cloud.buildLaunch({ intent: 'go' }), /cannot build a "undefined" launch/);
  // Resume with nothing to attach to refuses rather than building a nonsense command.
  assert.throws(() => cloud.buildLaunch({ mode: 'resume', entry: {} }), /without a session_… id/);
});
