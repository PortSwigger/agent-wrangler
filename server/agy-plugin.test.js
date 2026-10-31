import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { syncAgyPlugin, pluginFiles } from './agy-plugin.js';
import { agyHookResponse, acceptAgyHook } from './agy-hooks.js';

test('off and missing-binary startup have no provider-global effects; opt-in installs once and removes only owned plugin', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-plugin-'));
  let probes = 0;
  const available = async () => { probes++; return true; };
  const execImpl = async (_bin, args) => { if (args[1] === 'install') fs.cpSync(args[2], path.join(home, '.gemini/config/plugins/agent-wrangler'), { recursive: true }); return { stdout: 'fixture only' }; }; 
  try {
    assert.equal((await syncAgyPlugin({ enabled: false, home, available, execImpl })).ready, false);
    assert.equal(fs.existsSync(path.join(home, '.gemini')), false);
    assert.equal((await syncAgyPlugin({ enabled: true, home, available: async () => false })).ready, false);
    assert.equal(fs.existsSync(path.join(home, '.gemini')), false);
    assert.equal((await syncAgyPlugin({ enabled: true, home, available, execImpl })).ready, true);
    const plugin = path.join(home, '.gemini/config/plugins/agent-wrangler');
    const stamp = fs.statSync(path.join(plugin, '.aw-version')).mtimeMs;
    await syncAgyPlugin({ enabled: true, home, available, execImpl });
    assert.equal(fs.statSync(path.join(plugin, '.aw-version')).mtimeMs, stamp);
    const wrapper = path.join(plugin, 'bridge.sh');
    assert.equal(execFileSync('/bin/sh', [wrapper, 'hook'], { env: {}, encoding: 'utf8' }), '');
    assert.equal(execFileSync('/bin/sh', [wrapper, 'hook'], { env: { AW_SESSION_ID: 'card', AW_INSTALL_ROOT: '/missing', AW_NODE: process.execPath }, encoding: 'utf8' }), '');
    await syncAgyPlugin({ enabled: false, home, available, execImpl });
    assert.equal(fs.existsSync(plugin), false);
    assert.equal(probes, 2);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
test('plugin has no always-on rules or skills; approval requires card identity and exact registered server/tool name', () => {
  assert.ok(!Object.keys(pluginFiles()).some((f) => /rules|skills/.test(f)));
  const payload = { toolCall: { name: 'call_mcp_tool', args: { ServerName: 'agent-wrangler_agent-wrangler', ToolName: 'read_mail', Arguments: {} } } };
  assert.equal(agyHookResponse('PreToolUse', payload, { env: {}, tools: ['read_mail'] }), null);
  assert.deepEqual(agyHookResponse('PreToolUse', payload, { env: { AW_SESSION_ID: 'card' }, tools: ['read_mail'] }), { decision: 'auto_approve' });
  for (const toolCall of [{ name: 'run_command', input: JSON.stringify(payload) }, { name: 'mcp__other__read_mail' }, { name: 'mcp__agent-wrangler__read_mail_extra' }, { ...payload.toolCall, args: { ...payload.toolCall.args, ServerName: 'other' } }]) {
    assert.equal(agyHookResponse('PreToolUse', { toolCall }, { env: { AW_SESSION_ID: 'card' }, tools: ['read_mail'] }), null);
  }
});
test('hooks reject nested PID, pending summaries and owned roots; children never change root status', async () => {
  const entry = { agent: 'agy', liveSessionId: 'root', tmux: 'ag_fixture' };
  const map = new Map([['card', entry], ['other', { agent: 'agy', liveSessionId: 'owned' }]]);
  const deps = { map, rootPid: async () => 42, summaries: async () => [{ conversation_id: 'root', parent_conversation_id: '', nesting_depth: 0 }, { conversation_id: 'child', parent_conversation_id: 'root', nesting_depth: 1 }, { conversation_id: 'owned', parent_conversation_id: '', nesting_depth: 0 }], save: () => {} };
  const hook = { cardId: 'card', parentPid: 42, conversationId: 'root', event: 'PreInvocation', modelName: 'gemini-3.8-flash' };
  assert.equal(await acceptAgyHook({ ...hook, parentPid: 43 }, deps), false);
  assert.equal(await acceptAgyHook({ ...hook, conversationId: 'pending' }, deps), false);
  assert.equal(await acceptAgyHook({ ...hook, conversationId: 'owned' }, deps), false);
  assert.equal(await acceptAgyHook(hook, deps), true);
  assert.equal(entry.agyLive.status, 'working');
  assert.equal(await acceptAgyHook({ ...hook, conversationId: 'child', event: 'Stop', fullyIdle: true }, deps), true);
  assert.equal(entry.liveSessionId, 'root');
  assert.equal(entry.agyLive.status, 'working');
});

test('failed native validation is surfaced and never marks the opt-in plugin ready', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-plugin-failure-'));
  const calls = [];
  try {
    const result = await syncAgyPlugin({ enabled: true, home, available: async () => true, execImpl: async (_binary, args) => { calls.push(args); throw new Error('fixture validator failure'); } });
    assert.equal(result.ready, false); assert.match(result.error, /fixture validator failure/);
    assert.equal(calls.length, 1); assert.equal(calls[0][1], 'validate');
    assert.equal(fs.existsSync(path.join(home, '.gemini/config/plugins/agent-wrangler/.aw-version')), false);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('optional trust writer preserves user settings and refuses malformed data in an isolated home', async () => {
  const { ensureAgyTrust } = await import('./agy-trust.js');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-trust-'));
  const file = path.join(home, '.gemini/antigravity-cli/settings.json');
  try {
    assert.equal(ensureAgyTrust('/tmp/work', { home }), false);
    assert.equal(fs.existsSync(path.join(home, '.gemini')), false);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ trustedWorkspaces: ['/tmp/existing'], statusLine: 'user-owned', custom: { keep: true } }));
    assert.equal(ensureAgyTrust('/tmp/work', { home, enabled: true }), true);
    const after = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(after.trustedWorkspaces, ['/tmp/existing', '/tmp/work']); assert.equal(after.statusLine, 'user-owned'); assert.deepEqual(after.custom, { keep: true });
    fs.writeFileSync(file, '{incomplete');
    assert.equal(ensureAgyTrust('/tmp/other', { home, enabled: true }), false);
    assert.equal(fs.readFileSync(file, 'utf8'), '{incomplete');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
