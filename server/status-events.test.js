import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { statusEventError, cardStatusOf, createStatusEventStore, STATUS_EVENT_MAX_BYTES } from './status-events.js';
import { claudeStatusHookGroups, codexStatusHooks, STATUS_HOOK_PATH, CLAUDE_STATUS_HOOKS, CODEX_STATUS_HOOKS } from './status-hooks.js';
import { codexHookOverrides, hookTrustHash, hookTrustKey } from './codex-hook-config.js';
import { launchSettings, statusEventEnv } from './agents/claude.js';
import { adapterFor } from './agents/index.js';
import { registerRuntime, unregisterRuntimesFor, takesStatusEvents, runtimeFor } from './runtimes/index.js';
import { SessionManager } from './session-manager.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aw-status-events-'));

test('a status event is exactly { state, at?, sessionId?, detail? }', () => {
  assert.equal(statusEventError({ state: 'working' }), null);
  assert.equal(statusEventError({ state: 'waiting-permission', at: 1781000000000, sessionId: 'a1-b2_c3', detail: 'Claude needs your permission to use Bash' }), null);
  assert.match(statusEventError(null), /JSON object/);
  assert.match(statusEventError([]), /JSON object/);
  assert.match(statusEventError({}), /state must be one of/);
  assert.match(statusEventError({ state: 'busy' }), /state must be one of/);
  assert.match(statusEventError({ state: 'idle', card: 'OTHER' }), /unknown field "card"/);
  assert.match(statusEventError({ state: 'idle', at: -1 }), /at must be/);
  assert.match(statusEventError({ state: 'idle', at: 1.5 }), /at must be/);
  assert.match(statusEventError({ state: 'idle', sessionId: '../x' }), /sessionId/);
  assert.match(statusEventError({ state: 'idle', detail: 'x'.repeat(201) }), /detail/);
  assert.equal(STATUS_EVENT_MAX_BYTES, 1024);
});

test('each state maps onto the board\'s status model', () => {
  assert.deepEqual(cardStatusOf({ state: 'working' }), { status: 'working', waitingFor: null, waitingReason: null });
  assert.deepEqual(cardStatusOf({ state: 'idle' }), { status: 'idle', waitingFor: null, waitingReason: null });
  assert.deepEqual(cardStatusOf({ state: 'waiting-permission', detail: 'Allow Bash?' }), { status: 'needs-you', waitingFor: 'Allow Bash?', waitingReason: 'permission' });
  assert.deepEqual(cardStatusOf({ state: 'waiting-permission' }), { status: 'needs-you', waitingFor: 'Waiting for permission', waitingReason: 'permission' });
  assert.deepEqual(cardStatusOf({ state: 'waiting-input' }), { status: 'needs-you', waitingFor: 'Waiting for your input', waitingReason: null });
  assert.equal(cardStatusOf(null).status, 'unknown');
});

test('the store keeps the newest event per card, drops a late older one, and survives a restart', () => {
  const file = path.join(tmp(), 'session-status.json');
  const store = createStatusEventStore({ file });
  assert.equal(store.record('A', { state: 'working', at: 100 }), true);
  assert.equal(store.record('A', { state: 'idle', at: 50 }), false, 'an older event that arrived late');
  assert.equal(store.get('A').state, 'working');
  assert.equal(store.record('A', { state: 'waiting-permission', at: 200, detail: 'Allow?' }), true);
  assert.deepEqual(createStatusEventStore({ file }).get('A'), { state: 'waiting-permission', at: 200, detail: 'Allow?' });
  store.forget('A');
  assert.equal(createStatusEventStore({ file }).get('A'), null);
});

test('Claude status hooks: every state the board distinguishes, all on the one script', () => {
  const groups = claudeStatusHookGroups('/x/status-event-hook.mjs');
  assert.deepEqual(Object.keys(groups).sort(), ['Notification', 'PermissionRequest', 'PostToolUse', 'PreToolUse', 'SessionStart', 'Stop', 'UserPromptSubmit']);
  assert.equal(groups.PermissionRequest[0].hooks[0].command, "'/x/status-event-hook.mjs' waiting-permission");
  assert.deepEqual(groups.Notification.map((g) => [g.matcher, g.hooks[0].command]), [
    ['permission_prompt', "'/x/status-event-hook.mjs' waiting-permission"],
    ['elicitation_dialog', "'/x/status-event-hook.mjs' waiting-input"],
  ]);
  assert.equal(groups.Stop[0].hooks[0].command, "'/x/status-event-hook.mjs' idle");
  assert.equal(groups.Stop[0].matcher, undefined);
  const states = new Set([...CLAUDE_STATUS_HOOKS, ...CODEX_STATUS_HOOKS].map(([, , s]) => s));
  assert.deepEqual([...states].sort(), ['idle', 'waiting-input', 'waiting-permission', 'working']);
});

test('a Claude launch carries the status hooks and URL only when the launch takes status events', () => {
  const plain = JSON.parse(launchSettings({}));
  assert.deepEqual(Object.keys(plain.hooks), ['PostToolUse']);
  assert.equal(statusEventEnv({}), '');
  const events = JSON.parse(launchSettings({ statusEvents: true }));
  assert.equal(events.hooks.PostToolUse.length, 2, 'the PR hook stays first, the status hook follows');
  assert.equal(events.hooks.PostToolUse[0].matcher, 'Bash');
  assert.ok(events.hooks.Stop[0].hooks[0].command.includes(STATUS_HOOK_PATH));
  assert.match(statusEventEnv({ statusEvents: true }), /^AW_STATUS_EVENT_URL='http:\/\/127\.0\.0\.1:\d+\/status-event' $/);

  const inner = adapterFor('claude').buildLaunch({ sessionId: 'C1', liveSessionId: 'L1', cwd: '/tmp', intent: '', launchContext: { statusEvents: true } });
  assert.match(inner, /AW_STATUS_EVENT_URL=/);
  assert.match(inner, /status-event-hook\.mjs/);
  const without = adapterFor('claude').buildLaunch({ sessionId: 'C1', liveSessionId: 'L1', cwd: '/tmp', intent: '', launchContext: {} });
  assert.doesNotMatch(without, /status-event-hook|AW_STATUS_EVENT_URL/);
});

test('a Codex launch adds the status hooks beside the PR footer\'s, trusted in one hooks.state', () => {
  const hooks = [{ event: 'PostToolUse', matcher: 'Bash', command: 'footer' }, ...codexStatusHooks('/n/node', '/x/hook.mjs')];
  const overrides = codexHookOverrides(hooks);
  assert.equal(overrides.filter((o) => o.startsWith('hooks.state=')).length, 1);
  const state = overrides.find((o) => o.startsWith('hooks.state='));
  for (const [event, group, h] of [['PostToolUse', 0, hooks[0]], ['PostToolUse', 1, hooks.find((x) => x.event === 'PostToolUse' && x.command !== 'footer')], ['Stop', 0, hooks.find((x) => x.event === 'Stop')]]) {
    assert.ok(state.includes(`"${hookTrustKey(event, group)}"={trusted_hash="${hookTrustHash(h.command, { event, matcher: h.matcher })}"}`), `${event}:${group}`);
  }
  assert.ok(overrides.includes(`hooks.Stop=[{hooks=[{type="command",command="'/n/node' '/x/hook.mjs' idle",timeout=10,async=true}]}]`));
  // Pinned against codex-cli 0.169.0 (a throwaway CODEX_HOME, "Trust all", and
  // the hash Codex wrote): a hook with no matcher hashes with the key left out.
  assert.equal(hookTrustHash("'/n/node' '/x/hook.mjs' idle", { event: 'Stop' }), hookTrustHash("'/n/node' '/x/hook.mjs' idle", { event: 'Stop', matcher: undefined }));
  assert.notEqual(hookTrustHash('c', { event: 'Stop' }), hookTrustHash('c', { event: 'Stop', matcher: 'Bash' }));

  const inner = adapterFor('codex').buildLaunch({ sessionId: 'C1', cwd: '/tmp', intent: '', launchContext: { statusEvents: true } });
  assert.match(inner, /AW_STATUS_EVENT_URL=/);
  assert.match(inner, /hooks\.PermissionRequest=/);
  assert.doesNotMatch(adapterFor('codex').buildLaunch({ sessionId: 'C1', cwd: '/tmp', intent: '', launchContext: {} }), /status-event-hook|AW_STATUS_EVENT_URL/);
});

test('takesStatusEvents: an opted-in runtime with an agent that has status hooks', () => {
  registerRuntime({ id: 'ev-rt', label: 'Events', statusEvents: true, wrapLaunch: async ({ inner }) => inner }, 'ev-ext');
  registerRuntime({ id: 'ev-build', label: 'Built', statusEvents: true, resumable: false, buildLaunch: async () => 'x' }, 'ev-ext');
  try {
    assert.equal(takesStatusEvents(runtimeFor('ev-rt'), 'claude'), true);
    assert.equal(takesStatusEvents(runtimeFor('ev-rt'), 'codex'), true);
    assert.equal(takesStatusEvents(runtimeFor('ev-rt'), 'gemini'), false, 'no status hooks for Gemini');
    assert.equal(takesStatusEvents(runtimeFor('ev-build'), 'claude'), false, 'a buildLaunch runtime runs none of our commands');
    assert.equal(takesStatusEvents(runtimeFor('local'), 'claude'), false);
    assert.equal(takesStatusEvents(runtimeFor('devcontainer'), 'claude'), false);
  } finally {
    unregisterRuntimesFor('ev-ext');
  }
});

test('a launch on an opted-in runtime is marked statusEvents and hands wrapLaunch the hook script; others are not', () => {
  const sm = new SessionManager();
  sm._issueSessionToken = (id) => `awt_${id}`;
  const rt = { id: 'ev', statusEvents: true, wrapLaunch: async () => '' };
  const ctx = sm._withSessionToken(rt, 'C1', { env: {} }, 'claude');
  assert.equal(ctx.statusEvents, true);
  assert.deepEqual(sm._statusHookFor(ctx), { statusHook: { script: STATUS_HOOK_PATH } });
  assert.equal(sm._withSessionToken(rt, 'C1', { env: {} }, 'gemini').statusEvents, undefined);
  assert.equal(sm._withSessionToken({ secretEnv: true }, 'C1', { env: {}, statusEvents: true }, 'claude').statusEvents, undefined, 'an extension cannot claim it');
  assert.deepEqual(sm._statusHookFor({}), {});
});
