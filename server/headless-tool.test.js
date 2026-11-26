import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import os from 'node:os';
import {
  runHeadlessTool, probeClaudeInventory, oneToolArgs, serverForTool, HEADLESS_TOOL_SYSTEM_PROMPT, _resetInventoryCacheForTests,
} from './headless-tool.js';
import { headlessRunsInFlight } from './headless.js';

const TOOL = 'mcp__claude_ai_Slack__slack_send_message';
const INVENTORY = {
  tools: [TOOL, 'mcp__claude_ai_Slack__slack_read_channel', 'mcp__claude_ai_Gmail__send', 'mcp__plugin_x_x__go'],
  servers: [
    { name: 'claude.ai Slack', status: 'connected', source: 'claudeai' },
    { name: 'claude.ai Gmail', status: 'connected', source: 'claudeai' },
    { name: 'plugin:x:x', status: 'connected', source: 'plugin' },
  ],
};
const CLAUDE_BG = { agent: 'claude', model: 'haiku' };

function fakeSpawn(lines, { onSpawn } = {}) {
  const calls = [];
  const spawn = (file, args, opts) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.killed = false;
    child.kill = (sig) => { child.killed = sig || true; setImmediate(() => child.emit('close', null, sig)); return true; };
    calls.push({ file, args, opts, child });
    onSpawn?.(child);
    setImmediate(() => {
      for (const l of lines) child.stdout.write(`${JSON.stringify(l)}\n`);
      child.stdout.end();
      setImmediate(() => { if (!child.killed) child.emit('close', 0, null); });
    });
    return child;
  };
  return { spawn, calls };
}

const init = (tools, servers = INVENTORY.servers) => ({ type: 'system', subtype: 'init', tools, mcp_servers: servers });
const SENT = [
  init([TOOL]),
  { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu1', name: TOOL, input: { channel_id: 'C1', text: 'hi' } }] } },
  { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: [{ type: 'text', text: '{"ok":true,"ts":"1.2"}' }] }] } },
  { type: 'result', subtype: 'success', is_error: false, result: 'DONE', usage: { input_tokens: 4, output_tokens: 9 }, total_cost_usd: 0.001 },
];

const base = (over = {}) => ({
  tool: TOOL, source: 'claudeai', prompt: 'Send the JSON on stdin.', stdin: '{"channel_id":"C1","text":"hi"}', callerId: 'slack',
  background: CLAUDE_BG, policy: async () => null, inventory: async () => INVENTORY, version: async () => '2.1.332', ...over,
});

test('serverForTool maps a tool to the one server whose normalised name prefixes it', () => {
  assert.deepEqual(serverForTool(TOOL, INVENTORY.servers), INVENTORY.servers[0]);
  assert.deepEqual(serverForTool('mcp__plugin_x_x__go', INVENTORY.servers), INVENTORY.servers[2]);
  assert.equal(serverForTool('mcp__nobody__x', INVENTORY.servers), null);
});

test('oneToolArgs: only the named tool is allowed, every other tool is disallowed, a pin hook blocks the rest', () => {
  const args = oneToolArgs({ tool: TOOL, others: ['a', 'b'], model: 'haiku', effort: 'low', liveSessionId: 'L', prompt: 'P', maxTurns: 3, hooks: {} });
  const at = (flag) => args[args.indexOf(flag) + 1];
  assert.equal(at('--model'), 'haiku');
  assert.equal(at('--effort'), 'low');
  assert.equal(at('--tools'), '');
  assert.equal(at('--setting-sources'), 'user');
  assert.equal(at('--system-prompt'), HEADLESS_TOOL_SYSTEM_PROMPT);
  assert.equal(at('--permission-mode'), 'dontAsk');
  assert.equal(at('--allowedTools'), TOOL);
  assert.equal(at('--session-id'), 'L');
  assert.equal(at('--max-turns'), '3');
  assert.ok(args.includes('--disable-slash-commands'));
  assert.ok(!args.includes('--strict-mcp-config'), 'connectors need the user setting source and no strict MCP config');
  const d = args.indexOf('--disallowed-tools');
  assert.deepEqual(args.slice(d + 1, d + 3), ['a', 'b']);
  assert.deepEqual(args.slice(-2), ['--', 'P']);
  const settings = JSON.parse(at('--settings'));
  assert.equal(settings.disableAllHooks, false);
  const pin = settings.hooks.PreToolUse[0];
  assert.equal(pin.hooks[0].onFailure, 'block');
  const re = new RegExp(pin.matcher);
  assert.ok(re.test('mcp__claude_ai_Gmail__send'));
  assert.ok(!re.test(TOOL));
});

test('runHeadlessTool runs on the Background model and returns the tool calls, usage and cost', async () => {
  _resetInventoryCacheForTests();
  const { spawn, calls } = fakeSpawn(SENT);
  const before = headlessRunsInFlight();
  const out = await runHeadlessTool(base({ spawn }));
  assert.equal(headlessRunsInFlight(), before);
  assert.equal(out.error, null);
  assert.equal(out.text, 'DONE');
  assert.equal(out.agent, 'claude');
  assert.equal(out.model, 'haiku');
  assert.match(out.liveSessionId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(out.toolCalls, [{ input: { channel_id: 'C1', text: 'hi' }, output: [{ type: 'text', text: '{"ok":true,"ts":"1.2"}' }], isError: false }]);
  assert.deepEqual(out.usage, { input_tokens: 4, output_tokens: 9 });
  assert.equal(out.costUsd, 0.001);
  const [{ args, opts, child }] = calls;
  const d = args.indexOf('--disallowed-tools');
  assert.deepEqual(args.slice(d + 1, args.indexOf('--')), INVENTORY.tools.filter((t) => t !== TOOL));
  assert.equal(opts.cwd, os.tmpdir());
  assert.equal(opts.env.CLAUDECODE, undefined);
  assert.equal(child.stdin.read().toString(), '{"channel_id":"C1","text":"hi"}');
});

test('a run whose init shows any other tool is killed before it can act', async () => {
  const { spawn, calls } = fakeSpawn([init([TOOL, 'mcp__claude_ai_Gmail__send']), ...SENT.slice(1)]);
  const out = await runHeadlessTool(base({ spawn }));
  assert.match(out.error, /expected exactly \["mcp__claude_ai_Slack__slack_send_message"\], saw 2 tools/);
  assert.deepEqual(out.toolCalls, []);
  assert.equal(calls[0].child.killed, 'SIGKILL');
});

test('a run that never reports its init is refused', async () => {
  const { spawn } = fakeSpawn(SENT.slice(1));
  const out = await runHeadlessTool(base({ spawn }));
  assert.match(out.error, /never reported its tools/);
});

test('a non-Claude Background model is refused with a clear error, before anything runs', async () => {
  const { spawn, calls } = fakeSpawn(SENT);
  await assert.rejects(runHeadlessTool(base({ spawn, background: { agent: 'codex', model: 'gpt-5.5' } })), /Background model is codex gpt-5\.5.*needs a Claude Background model.*Settings › Automation/);
  assert.equal(calls.length, 0);
});

test('the tool must come from one connected server with the declared source', async () => {
  const { spawn, calls } = fakeSpawn(SENT);
  await assert.rejects(runHeadlessTool(base({ spawn, source: 'plugin' })), /claude\.ai Slack.*source "claudeai", not "plugin"/);
  await assert.rejects(runHeadlessTool(base({ spawn, inventory: async () => ({ ...INVENTORY, tools: INVENTORY.tools.filter((t) => t !== TOOL) }) })), /is not available/);
  await assert.rejects(runHeadlessTool(base({ spawn, inventory: async () => ({ ...INVENTORY, servers: [{ ...INVENTORY.servers[0], status: 'needs-auth' }] }) })), /needs-auth/);
  assert.equal(calls.length, 0);
});

test('another extension\'s tool policy, or one that cannot be collected, refuses the run', async () => {
  const { spawn, calls } = fakeSpawn(SENT);
  const policy = async () => ({ sources: ['guard'], fingerprint: 'f', rules: [{ extId: 'guard', kind: 'pattern', value: 'mcp__claude_ai_Slack__.*', agents: null, reason: 'x' }] });
  await assert.rejects(runHeadlessTool(base({ spawn, policy })), /guard's tool policy blocks/);
  const own = async () => ({ sources: ['slack'], fingerprint: 'f', rules: [{ extId: 'slack', kind: 'tool', value: TOOL, agents: null, reason: 'x' }] });
  await runHeadlessTool(base({ spawn, policy: own }));
  await assert.rejects(runHeadlessTool(base({ spawn, policy: async () => { throw new Error('guard is quarantined'); } })), /guard is quarantined/);
  assert.equal(calls.length, 1);
});

test('an old Claude CLI is refused', async () => {
  const { spawn } = fakeSpawn(SENT);
  await assert.rejects(runHeadlessTool(base({ spawn, version: async () => '2.1.100' })), /older than 2\.1\.332/);
});

test('a profile names an isolated config dir and adds the caller\'s own hooks after the pin', async () => {
  const { spawn, calls } = fakeSpawn(SENT);
  const dir = os.tmpdir();
  const hook = { matcher: TOOL, hooks: [{ type: 'command', command: '/bin/check', timeout: 5, onFailure: 'block' }] };
  let probedWith;
  await runHeadlessTool(base({ spawn, inventory: async (o) => { probedWith = o; return INVENTORY; }, profile: { configDir: dir, hooks: { PreToolUse: [hook], PostToolUse: [hook] } } }));
  assert.equal(calls[0].opts.env.CLAUDE_CONFIG_DIR, dir);
  assert.equal(probedWith.env.CLAUDE_CONFIG_DIR, dir);
  const settings = JSON.parse(calls[0].args[calls[0].args.indexOf('--settings') + 1]);
  assert.equal(settings.hooks.PreToolUse.length, 2);
  assert.deepEqual(settings.hooks.PreToolUse[1], hook);
  assert.deepEqual(settings.hooks.PostToolUse, [hook]);
  await assert.rejects(runHeadlessTool(base({ spawn, profile: { configDir: 'relative' } })), /configDir must be an absolute path to a directory/);
  await assert.rejects(runHeadlessTool(base({ spawn, profile: { hooks: { Stop: [] } } })), /hooks\.Stop/);
  await assert.rejects(runHeadlessTool(base({ spawn, profile: { other: 1 } })), /unknown profile key "other"/);
  await assert.rejects(runHeadlessTool(base({ spawn, profile: { hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'x', onFailure: 'allow' }] }] } } })), /onFailure/);
});

test('bad calls reject before anything runs', async () => {
  const { spawn, calls } = fakeSpawn(SENT);
  await assert.rejects(runHeadlessTool(base({ spawn, prompt: '' })), /prompt must be a non-empty string/);
  await assert.rejects(runHeadlessTool(base({ spawn, maxTurns: 0 })), /maxTurns/);
  await assert.rejects(runHeadlessTool(base({ spawn, stdin: 5 })), /stdin must be a string/);
  assert.equal(calls.length, 0);
});

test('probeClaudeInventory reads init with the API unreachable, then kills the probe', async () => {
  _resetInventoryCacheForTests();
  const { spawn, calls } = fakeSpawn([init(INVENTORY.tools), { type: 'assistant', message: { content: [] } }]);
  const inv = await probeClaudeInventory({ env: { PATH: '/bin' }, spawn });
  assert.deepEqual(inv, INVENTORY);
  assert.match(calls[0].opts.env.ANTHROPIC_BASE_URL, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(calls[0].child.killed, 'SIGKILL');
  assert.ok(calls[0].args.includes('--no-session-persistence'));
  await probeClaudeInventory({ env: { PATH: '/bin' }, spawn });
  assert.equal(calls.length, 1, 'cached for the same profile');
  await probeClaudeInventory({ env: { PATH: '/bin', CLAUDE_CONFIG_DIR: '/p' }, spawn });
  assert.equal(calls.length, 2, 'another profile probes again');
});
