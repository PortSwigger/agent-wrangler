import test from 'node:test';
import assert from 'node:assert/strict';
import { agy } from './agents/agy.js';
import { createAgyMcpBridge } from './agy-mcp-entry.js';
import { agyHookResponse, readAgyLive } from './agy-hooks.js';
import { advanceAgyStartup } from './agy-lifecycle.js';
import { createAgyStartup, acceptAgyNative, agyNativeReady, AGY_STARTUP_PROBE } from './agy-startup.js';
import { INSTALL_ROOT } from './install-root.js';
import fs from 'node:fs';
const evidence = JSON.parse(fs.readFileSync(new URL('./fixtures/agy-1.4.10/startup.json', import.meta.url), 'utf8'));

const idle = '────────────────────────────\n> \n────────────────────────────\n? for shortcuts      auto   Gemini 3.8 Flash · medium';

test('launch holds task intent out of argv until native discovery', () => {
  const cmd = agy.buildLaunch({ sessionId: 'card', intent: 'PRIVATE TASK MUST WAIT', launchId: 'launch-one' });
  assert.doesNotMatch(cmd, /PRIVATE TASK MUST WAIT/);
  assert.match(cmd, /AW_AGY_LAUNCH_ID='launch-one'/);
});

test('delayed sign-in and lazy native discovery release one retained task only after the native read', async () => {
  const entry = { agyStartup: createAgyStartup(), agyPendingIntent: { text: 'one task', state: 'pending' }, liveSessionId: 'root' };
  let pane = idle + '\nYou are currently not signed in. Select login method', ready = false;
  const sent = [];
  const args = { entry, capture: async () => pane, keys: async () => assert.fail('unexpected key'), send: async (_t, text) => sent.push(text), confirm: async () => true, nativeReady: () => ready, timeoutMs: 1 };
  await advanceAgyStartup(args);
  assert.deepEqual(sent, []);
  pane = idle;
  await advanceAgyStartup(args);
  await advanceAgyStartup(args);
  assert.deepEqual(sent, [AGY_STARTUP_PROBE]);
  ready = true;
  await advanceAgyStartup(args);
  await advanceAgyStartup(args);
  assert.deepEqual(sent, [AGY_STARTUP_PROBE, 'one task']);
  assert.equal(entry.agyPendingIntent.state, 'submitted');
});

test('native readiness excludes stale launches, shell imports, unrelated traffic and old disconnects', async () => {
  const entry = { agent: 'agy', agyStartup: createAgyStartup() };
  const args = { map: new Map([['card', entry]]), rootPid: async () => 42,
    inspect: async () => ({ parentPid: 42, command: `${process.execPath} ${INSTALL_ROOT}/server/agy-mcp-entry.js` }) };
  const event = { cardId: 'card', launchId: entry.agyStartup.launchId, pid: process.pid, connectionId: 'native-one', state: 'ready' };
  assert.equal(agyNativeReady(entry), false);
  assert.equal(await acceptAgyNative({ ...event, launchId: 'old' }, args), false);
  assert.equal(await acceptAgyNative(event, { ...args, inspect: async () => ({ parentPid: 42, command: 'node -e shellBridge()' }) }), false);
  assert.equal(await acceptAgyNative(event, { ...args, inspect: async () => ({ parentPid: 90, command: `${process.execPath} ${INSTALL_ROOT}/server/agy-mcp-entry.js` }) }), false);
  assert.equal(await acceptAgyNative(event, args), true);
  assert.equal(agyNativeReady(entry), true);
  assert.equal(agyNativeReady(entry, () => false), false, 'a dead stdio process cannot retain readiness');
  assert.equal(await acceptAgyNative({ ...event, connectionId: 'native-two' }, args), true);
  assert.equal(await acceptAgyNative({ ...event, state: 'disconnected' }, args), false);
  assert.equal(agyNativeReady(entry), true);
  assert.equal(await acceptAgyNative({ ...event, connectionId: 'native-two', state: 'disconnected' }, args), true);
  assert.equal(agyNativeReady(entry), false);
});

test('drafts, permission prompts and uncertain submission never replay retained intent', async () => {
  const entry = { agyStartup: createAgyStartup(), agyPendingIntent: { text: 'task', state: 'pending' }, liveSessionId: 'root' };
  let pane = idle.replace('> ', '> human draft'), sends = 0;
  const args = { entry, capture: async () => pane, keys: async () => assert.fail('dialog key'), send: async () => sends++, confirm: async () => false, nativeReady: () => true, timeoutMs: 1 };
  await advanceAgyStartup(args);
  pane = idle + '\nAllow calling this tool?';
  await advanceAgyStartup(args);
  assert.equal(sends, 0);
  pane = idle;
  await advanceAgyStartup(args);
  await advanceAgyStartup(args);
  assert.equal(sends, 1);
  assert.equal(entry.agyPendingIntent.state, 'unknown');
});

test('unavailable native tools show needs-you with a clear startup failure and retain the task', async () => {
  const entry = { agyStartup: createAgyStartup(), agyPendingIntent: { text: 'retained task', state: 'pending' }, liveSessionId: 'root' };
  const sent = [];
  const args = { entry, capture: async () => idle, keys: async () => assert.fail('unexpected key'), send: async (_t, text) => sent.push(text), nativeReady: () => false, timeoutMs: 1 };
  await advanceAgyStartup(args);
  await advanceAgyStartup(args);
  const live = readAgyLive({ entry, pid: 42 });
  assert.equal(live.status, 'needs-you');
  assert.match(live.waitingFor, /native Wrangler tools are unavailable/);
  assert.match(live.waitingFor, /Task and mail are retained/);
  assert.deepEqual(entry.agyPendingIntent, { text: 'retained task', state: 'pending' });
  assert.deepEqual(sent, [AGY_STARTUP_PROBE]);
});

test('failed discovery remains an error and a later native request reconnects', async () => {
  let attempts = 0;
  const bridge = await createAgyMcpBridge({ env: { AW_SESSION_ID: 'card' }, connect: async () => {
    if (++attempts === 1) throw new Error('delayed plugin');
    return { listTools: async () => ({ tools: [{ name: 'get_session_info' }] }), close() {} };
  } });
  await assert.rejects(bridge.listTools(), /delayed plugin/);
  assert.equal((await bridge.listTools()).tools[0].name, 'get_session_info');
  assert.equal(attempts, 2);
});

test('captured call_mcp_tool envelope approves only the exact Wrangler server and registered tool', () => {
  const env = { AW_SESSION_ID: 'card' }, tools = ['get_session_info', 'read_mail', 'extension_tool'];
  const call = { ...evidence.nativeHook.toolCall, args: { ...evidence.nativeHook.toolCall.args, ServerName: evidence.nativePluginNamespace.expected, ToolName: 'read_mail' } };
  assert.deepEqual(agyHookResponse('PreToolUse', { toolCall: call }, { env, tools }), { decision: 'auto_approve' });
  for (const toolCall of [
    { ...call, args: { ...call.args, ServerName: 'other' } },
    { ...call, args: { ...call.args, ToolName: 'read_mail_extra' } },
    { name: 'run_command', args: { CommandLine: JSON.stringify(call) } },
    { name: 'mcp__agent-wrangler__read_mail' },
  ]) assert.equal(agyHookResponse('PreToolUse', { toolCall }, { env, tools }), null);
});

test('transport recovery never replays a write and requires a fresh native read', async () => {
  let connects = 0, writes = 0;
  const reports = [];
  const env = { AW_SESSION_ID: 'card' };
  const connect = async () => {
    connects++;
    return {
      listTools: async () => ({ tools: ['get_session_info', 'read_mail', 'rename_session'].map((name) => ({ name })) }),
      callTool: async ({ name }) => {
        if (name === 'rename_session') { writes++; throw new Error('response lost after write'); }
        return { structuredContent: { sessionId: 'card' }, content: [] };
      }, close() {},
    };
  };
  const bridge = await createAgyMcpBridge({ env, connect, report: async (event) => { reports.push(event.state); return true; } });
  assert.equal((await bridge.callTool({ name: 'rename_session' })).isError, true);
  assert.equal(writes, 0);
  await bridge.callTool({ name: 'get_session_info', arguments: {} });
  const lost = await bridge.callTool({ name: 'rename_session', arguments: {} });
  assert.equal(lost.isError, true);
  assert.match(lost.content[0].text, /not retried/);
  assert.equal(writes, 1);
  assert.equal((await bridge.callTool({ name: 'rename_session', arguments: {} })).isError, true);
  assert.equal(writes, 1);
  await bridge.callTool({ name: 'get_session_info', arguments: {} });
  assert.equal(connects, 2);
  assert.deepEqual(reports, ['ready', 'disconnected', 'ready']);
  await bridge.close();
});

test('an asynchronous transport error invalidates readiness before another native request', async () => {
  const events = [];
  const clients = [];
  const bridge = await createAgyMcpBridge({ env: { AW_SESSION_ID: 'card' }, report: async (event) => { events.push(event); return true; }, connect: async () => {
    const client = { listTools: async () => ({ tools: ['get_session_info', 'read_mail', 'rename_session'].map((name) => ({ name })) }), callTool: async () => ({ content: [], structuredContent: { sessionId: 'card' } }), close() {} };
    clients.push(client); return client;
  } });
  await bridge.callTool({ name: 'get_session_info', arguments: {} });
  clients[0].onerror(new Error('native upstream closed'));
  assert.equal((await bridge.callTool({ name: 'rename_session' })).isError, true);
  await bridge.callTool({ name: 'get_session_info', arguments: {} });
  assert.deepEqual(events.map((e) => e.state), ['ready', 'disconnected', 'ready']);
  assert.notEqual(events[0].connectionId, events[2].connectionId);
  await bridge.close();
});

test('missing discovery, wrong identity and shell bridge self-tests never produce native readiness', async () => {
  for (const variant of ['missing', 'identity', 'shell']) {
    let native = false;
    const bridge = await createAgyMcpBridge({ env: { AW_SESSION_ID: 'card' },
      connect: async () => ({
        listTools: async () => ({ tools: (variant === 'missing' ? ['get_session_info'] : ['get_session_info', 'read_mail', 'rename_session']).map((name) => ({ name })) }),
        callTool: async () => ({ content: [], structuredContent: { sessionId: variant === 'identity' ? 'other-card' : 'card' } }), close() {},
      }),
      ...(variant === 'shell' ? {} : { report: async ({ state }) => { native = state === 'ready'; return native; } }),
    });
    await bridge.listTools();
    await bridge.callTool({ name: 'get_session_info', arguments: {} });
    assert.equal(native, false, variant);
    assert.equal((await bridge.callTool({ name: 'rename_session' })).isError, true);
    await bridge.close();
  }
});

test('startup blocks configuration searches and shell repair while allowing only the captured native read', () => {
  const options = { env: { AW_SESSION_ID: 'card' }, tools: ['get_session_info', 'read_mail'], startupPending: true };
  for (const CommandLine of ['find ~/.gemini -name "*mcp*.json"', 'env | grep AW_', 'node -e createAgyMcpBridge()', 'curl http://127.0.0.1:7777/mcp']) {
    assert.equal(agyHookResponse('PreToolUse', { toolCall: { name: 'run_command', args: { CommandLine } } }, options).decision, 'deny');
  }
  assert.equal(agyHookResponse('PreToolUse', evidence.startupTrace[1], options).decision, 'deny');
  assert.match(evidence.startupTrace[0].message, /Not reloading plugin MCP servers/);
  const toolCall = { name: 'call_mcp_tool', args: { ServerName: 'agent-wrangler_agent-wrangler', ToolName: 'get_session_info', Arguments: {} } };
  assert.equal(agyHookResponse('PreToolUse', { toolCall }, options).decision, 'auto_approve');
  assert.equal(agyHookResponse('PreToolUse', { toolCall: { ...toolCall, args: { ...toolCall.args, ToolName: 'read_mail' } } }, options).decision, 'deny');
});

test('mode cycling remains bounded across recovery sweeps and never enters a permission choice', async () => {
  const entry = { agyStartup: createAgyStartup() };
  let count = 0;
  const args = { entry, capture: async () => idle.replace('auto', 'default'), keys: async (_t, keys) => { assert.deepEqual(keys, ['BTab']); count++; }, send: async () => assert.fail('no probe without auto'), timeoutMs: 1 };
  for (let n = 0; n < 5; n++) await advanceAgyStartup(args);
  assert.equal(count, 3);
  assert.match(entry.agyLaunchWarning, /auto mode could not be verified/);
});
