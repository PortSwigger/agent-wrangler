import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { agy, agyClassify, agyComposer, agyFooterModel, agyLaunchSecretEnv, agyModeArgs, agyModelArgs, agySessionSettings } from './agy.js';
import { collectLaunchContext } from '../launch-context.js';
import { runtimeFor } from '../runtimes/index.js';
import { adapterFor, effortError, launchTargetError, modelPillFor, providerMetadata, supportsRemoteControl } from './index.js';
import { decode, encode, msgAt, strAt, timestamp } from './agy-proto.js';
import { BOARD_ROOT, conversationCwd, discoverAgyLiveId, readConversation, syncMirror } from './agy-db.js';
import { DATA_DIR } from '../data-dir.js';
import { createAgyChatScanner, extractAgyLine } from './agy-transcript.js';
import { analyzeAgy, listResumableAgy } from './agy-usage.js';
import { ensureAgyRoot, pluginFiles } from './agy-config.js';
import { sessionStart } from './agy-hook.js';
import { messagesOf } from './agy-mcp-bridge.js';
import { resolveHeadlessTarget } from '../headless.js';
import { agyCostUsd } from '../pricing.js';
import { dispatchModels } from './listing.js';

const ID = '0c0cd5a7-f7aa-4713-9aca-ff89cba0cfb5';
const T0 = Date.UTC(2026, 10, 20, 10, 0, 0);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aw-agy-'));

// A conversation database shaped like agy 1.5.13's (agy-db.js has the field map).
function step(type, { at, status = 3, user, reply, call, output, error, usage, model = 7 } = {}) {
  const meta = { 1: timestamp(at), 11: model };
  if (usage) meta[9] = { 1: model, 2: usage.input, 3: usage.output, 5: usage.cacheRead, 9: usage.thinking };
  if (call) meta[4] = { 1: call.id, 2: call.name, 3: JSON.stringify(call.args) };
  const body = { 1: type, 4: status, 5: meta };
  if (user != null) body[19] = { 2: user, 3: { 1: user } };
  if (reply) body[20] = { 1: reply.text || '', 3: reply.thinking, 7: (reply.calls || []).map((c) => ({ 1: c.id, 2: c.name, 3: JSON.stringify(c.args) })) };
  if (output != null) body[140] = { 2: { 1: output } };
  if (error) body[24] = { 3: { 1: 'Agent execution terminated due to error.', 2: error } };
  return encode(body);
}

function makeDb(dir, id, steps, { workspaces = ['/work/repo'], createdAt = T0 } = {}) {
  const file = path.join(dir, 'conversations', `${id}.db`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('create table if not exists steps (idx integer primary key, step_type integer, status integer, step_payload blob)');
  db.exec('create table if not exists gen_metadata (idx integer primary key, data blob, size integer)');
  db.exec("create table if not exists trajectory_metadata_blob (id text primary key default 'main', data blob)");
  db.prepare('insert or replace into gen_metadata (idx, data, size) values (0, ?, 0)').run(encode({ 1: { 3: 7, 19: 'gemini-4-neon' } }));
  db.prepare("insert or replace into trajectory_metadata_blob (id, data) values ('main', ?)").run(encode({
    1: workspaces.map((w) => ({ 1: pathToFileURL(w).href })), 2: timestamp(createdAt), 6: id,
  }));
  db.exec('delete from steps');
  const ins = db.prepare('insert into steps (idx, step_type, status, step_payload) values (?, ?, ?, ?)');
  steps.forEach((s, i) => ins.run(i, decode(s)[1][0], decode(s)[4][0], s));
  db.close();
  return file;
}

const CONVERSATION = [
  step(14, { at: T0 + 1000, user: 'List the files' }),
  step(101, { at: T0 + 1100 }),
  step(15, { at: T0 + 2000, reply: { thinking: '**Planning**', calls: [{ id: 'c1', name: 'run_command', args: { CommandLine: 'ls' } }] }, usage: { input: 9000, output: 40, cacheRead: 0, thinking: 20 } }),
  step(132, { at: T0 + 3000, call: { id: 'c1', name: 'run_command', args: { CommandLine: 'ls' } }, output: 'a.txt\nb.txt' }),
  step(15, { at: T0 + 4000, reply: { text: 'Two files: a.txt and b.txt.' }, usage: { input: 300, output: 60, cacheRead: 9000, thinking: 10 } }),
];

test('protobuf round trip reads nested fields by number', () => {
  const buf = encode({ 1: 14, 5: { 1: timestamp(T0 + 1234) }, 19: { 2: 'hé llo' } });
  const msg = decode(buf);
  assert.equal(msg[1][0], 14);
  assert.equal(strAt(msg, 19, 2), 'hé llo');
  assert.equal(msgAt(msg, 5, 1)[1][0], Math.floor((T0 + 1234) / 1000));
  assert.equal(decode(Buffer.from([0x0a, 0x09])), null);
});

test('launch passes model and effort separately, the board root, trust and MCP grants', () => {
  const cmd = agy.buildLaunch({ sessionId: 'card-1', cwd: '/work/repo', intent: '-fix it', model: 'gemini-4-neon', effort: 'high' });
  assert.match(cmd, / agy '--mode' 'auto' '--model' 'gemini-4-neon' '--effort' 'high' '--add-dir' '[^']*agy\/root'/);
  assert.match(cmd, /'--prompt-interactive=-fix it'/);
  assert.match(cmd, /AW_AGY_MCP_URL='http:\/\/127\.0\.0\.1:\d+\/mcp'/);
  assert.match(cmd, /AW_AGY_CONTEXT='Your working directory is \/work\/repo/);
  assert.match(cmd, /AW_AGY_CWD='\/work\/repo'/);
  assert.doesNotMatch(cmd, /GEMINI_API_KEY/);
  const settings = JSON.parse(/'--settings' '(\{[^']*\})'/.exec(cmd)[1]);
  assert.ok(settings.trustedWorkspaces.includes('/work/repo'));
  assert.ok(settings.permissions.allow.includes('mcp(agent-wrangler/rename_session)'));
  const resume = agy.buildResume({ sessionId: 'card-1', cwd: '/work/repo', resumeId: ID, model: 'gemini-4-carbon', effort: 'xhigh' });
  assert.match(resume, /'--model' 'gemini-4-carbon' '--add-dir'/);
  assert.match(resume, new RegExp(`'--conversation' '${ID}'$`));
  assert.doesNotMatch(resume, /--effort/, 'carbon has no xhigh, so the effort is dropped rather than refused by agy');
});

test('session settings keep the user\'s own trust and permission entries', () => {
  const s = agySessionSettings({ cwd: '/b', user: { trustedWorkspaces: ['/a'], permissions: { allow: ['command(git status)'], deny: ['command(rm)'] } } });
  assert.deepEqual(s.trustedWorkspaces, ['/a', '/b']);
  assert.deepEqual(s.permissions.deny, ['command(rm)']);
  assert.equal(s.permissions.allow[0], 'command(git status)');
});

test('permission modes and models map to agy flags', () => {
  assert.deepEqual(agyModeArgs('acceptEdits'), ['--mode', 'accept-edits']);
  assert.deepEqual(agyModeArgs('manual'), []);
  assert.deepEqual(agyModeArgs('bypassPermissions'), ['--dangerously-skip-permissions']);
  assert.throws(() => agyModeArgs('dontAsk'), /not supported for agy/);
  assert.deepEqual(agyModelArgs('default', 'high'), []);
  assert.deepEqual(agyModelArgs('gemini-3.1-pro', 'medium'), ['--model', 'gemini-3.1-pro']);
});

test('registry: agy is a provider with no fork, remote control or Claude models', () => {
  assert.equal(adapterFor('agy'), agy);
  const meta = providerMetadata(agy);
  assert.equal(meta.fork, false);
  assert.equal(providerMetadata(adapterFor('codex')).fork, true);
  assert.equal(meta.headless, true);
  assert.equal(supportsRemoteControl('agy'), false);
  assert.equal(agy.presetsSessionId, false);
  assert.equal(launchTargetError('agy', 'gemini-4-neon', 'xhigh'), null);
  assert.match(effortError('agy', 'xhigh', 'gemini-4-argon'), /Unknown effort/);
  assert.match(launchTargetError('agy', 'opus'), /"opus" is a claude model/);
  assert.deepEqual(modelPillFor('agy', 'gemini-4-neon', 'gemini-4-neon'), { label: 'neon 4', title: 'gemini-4-neon' });
  assert.ok(agy.matchProcess('/Users/me/.local/bin/agy --mode auto') && !agy.matchProcess('agyx'));
});

test('the board plugin carries a stdio MCP bridge and the SessionStart hook', () => {
  const files = pluginFiles();
  const server = files['mcp_config.json'].mcpServers['agent-wrangler'];
  assert.equal(server.command, process.execPath);
  assert.match(server.args[0], /agy-mcp-bridge\.js$/);
  assert.match(files['hooks.json']['agent-wrangler'].SessionStart[0].command, /agy-hook\.js' 'SessionStart'$/);
  const root = ensureAgyRoot({ root: tmp() });
  assert.ok(fs.existsSync(path.join(root, '.agents', 'plugins', 'agent-wrangler', 'plugin.json')));
});

test('SessionStart records the conversation and hands over instructions once', () => {
  const dir = tmp();
  const env = { AW_SESSION_ID: 'card-9', AW_AGY_IDS_DIR: dir, AW_AGY_CONTEXT: 'be good', AW_AGY_CWD: '/work/repo' };
  assert.deepEqual(sessionStart({ conversationId: ID }, env, 5), { injectSteps: [{ systemMessage: { systemMessage: 'be good' } }] });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'card-9.json'), 'utf8')), { conversationId: ID, at: 5, cwd: '/work/repo' });
  assert.equal(conversationCwd(ID, { idsDir: dir, agyDir: tmp() }), '/work/repo');
  assert.equal(sessionStart({ conversationId: ID }, env, 6), null, 'a resume of the same conversation is not told twice');
  assert.equal(sessionStart({ conversationId: ID }, {}), null);
});

test('the MCP bridge reads JSON and SSE replies', () => {
  assert.deepEqual(messagesOf('application/json', '{"id":1}'), [{ id: 1 }]);
  assert.deepEqual(messagesOf('text/event-stream', 'event: message\ndata: {"id":2}\n\n: ping\n\n'), [{ id: 2 }]);
  assert.deepEqual(messagesOf('application/json', ''), []);
});

test('the database reads as settled steps, and the mirror only grows', () => {
  const agyDir = tmp();
  const mirrorDir = tmp();
  const file = makeDb(agyDir, ID, [...CONVERSATION, step(15, { at: T0 + 5000, status: 2, reply: { text: 'still writing' } })]);
  const convo = readConversation(file);
  assert.deepEqual(convo.records.map((r) => r.kind), ['user', 'assistant', 'tool', 'assistant'], 'system message skipped, the step in progress held back');
  assert.equal(convo.records[1].model, 'gemini-4-neon');
  assert.deepEqual(convo.meta.workspaces, ['/work/repo']);
  const out = syncMirror(ID, { agyDir, mirrorDir });
  const first = fs.readFileSync(out, 'utf8');
  assert.equal(first.trim().split('\n').length, 5);
  assert.equal(syncMirror(ID, { agyDir, mirrorDir }), out);
  makeDb(agyDir, ID, [...CONVERSATION, step(15, { at: T0 + 5000, reply: { text: 'done' } })]);
  syncMirror(ID, { agyDir, mirrorDir });
  const second = fs.readFileSync(out, 'utf8');
  assert.ok(second.startsWith(first), 'earlier byte offsets stay valid');
  assert.match(second.slice(first.length), /"text":"done"/);
  makeDb(agyDir, ID, CONVERSATION.slice(0, 1));
  syncMirror(ID, { agyDir, mirrorDir });
  assert.match(fs.readFileSync(out, 'utf8').trim().split('\n').at(-1), /"rewindTo":1/);
});

test('chat view, search and usage read the mirror', async () => {
  const agyDir = tmp();
  const mirrorDir = tmp();
  makeDb(agyDir, ID, CONVERSATION);
  const lines = fs.readFileSync(syncMirror(ID, { agyDir, mirrorDir }), 'utf8').split('\n');
  const scanner = createAgyChatScanner();
  const events = scanner.selectLive(lines.map((l) => scanner.pushTagged(l)));
  assert.deepEqual(events.map((e) => e.kind), ['user', 'thinking', 'tool', 'assistant']);
  assert.equal(events[2].target, 'ls');
  assert.equal(events[2].output, 'a.txt\nb.txt');
  assert.equal(events[3].model, 'gemini-4-neon');
  scanner.pushTagged(JSON.stringify({ rewindTo: 2 }));
  assert.equal(scanner.takeRewound(), true);
  assert.equal(extractAgyLine(lines[1]).record.text, 'List the files');
  assert.deepEqual(extractAgyLine(lines[0]).meta, { id: ID, cwd: '/work/repo' });
  const a = await analyzeAgy(ID, { agyDir, mirrorDir });
  assert.deepEqual(a.tokens, { input: 9300, output: 100, cacheWrite: 0, cacheRead: 9000 });
  assert.equal(a.model, 'gemini-4-neon');
  assert.equal(a.summary, 'List the files');
  assert.ok(a.usd > 0);
  assert.equal(a.usd, agyCostUsd(a.totals));
  const { candidates } = await listResumableAgy(new Set(), { agyDir, mirrorDir, now: Date.now() });
  assert.deepEqual(candidates.map((c) => [c.sessionId, c.cwd, c.agent]), [[ID, '/work/repo', 'agy']]);
});

test('without a board record the launch folder comes from agy\'s history, not the sorted workspaces', () => {
  const agyDir = tmp();
  const memory = path.join(DATA_DIR, 'memory', 'scratch', 'card');
  makeDb(agyDir, ID, CONVERSATION, { workspaces: [BOARD_ROOT, memory, '/work/repo'] });
  assert.equal(conversationCwd(ID, { agyDir, idsDir: tmp() }), '/work/repo');
  fs.writeFileSync(path.join(agyDir, 'history.jsonl'), `${JSON.stringify({ display: 'hi', workspace: '/work/other', conversationId: ID })}\n`);
  assert.equal(conversationCwd(ID, { agyDir, idsDir: tmp() }), '/work/other');
});

test('discovery takes the hook record, else the newest conversation begun in the folder', () => {
  const agyDir = tmp();
  const idsDir = tmp();
  const cwd = tmp();
  const other = '11111111-2222-4333-8444-555555555555';
  makeDb(agyDir, ID, CONVERSATION, { workspaces: ['/x/agy/root', cwd], createdAt: Date.now() });
  makeDb(agyDir, other, CONVERSATION, { workspaces: ['/elsewhere'], createdAt: Date.now() });
  assert.equal(discoverAgyLiveId({ sessionId: 'card', cwd, agyDir, idsDir, launchedAt: Date.now() - 5000 }), ID);
  assert.equal(discoverAgyLiveId({ sessionId: 'card', cwd, agyDir, idsDir, excludeIds: new Set([ID]) }), null);
  assert.equal(discoverAgyLiveId({ sessionId: 'card', cwd, agyDir, idsDir, mintedAfter: Date.now() + 60_000 }), null);
  fs.writeFileSync(path.join(idsDir, 'card.json'), JSON.stringify({ conversationId: other, at: Date.now() }));
  assert.equal(discoverAgyLiveId({ sessionId: 'card', cwd, agyDir, idsDir }), other);
});

// Panes captured from agy 1.5.13 (paths shortened).
const RULE = '─'.repeat(80);
const IDLE = `  Antigravity CLI 1.5.13\n  Gemini API key\n${RULE}\n> hello\n  Ready! How can I help?\n${RULE}\n>\n${RULE}\n? for shortcuts                                Gemini 4 Neon · high\n`;
const MENU = `${RULE}\n> /fo\n${RULE}\n> /fork          Create a branch\n  /effort        Set the reasoning effort\n  ↑/↓ Navigate · enter Select · tab Complete\nesc to cancel                                   Gemini 4 Neon · medium\n`;
const TRUST = 'Accessing workspace:\n/work/repo\nDo you trust the contents of this project?\nAntigravity CLI requires permission to read, edit, and execute files here.\n> Yes, I trust this folder\n  No, exit\n';
const BUSY = `${RULE}\n> fix it\n⠋ Thinking\n${RULE}\n>\n${RULE}\nesc to interrupt                                Gemini 4 Neon · high\n`;

test('pane status, composer and footer model', () => {
  assert.deepEqual(agyClassify(IDLE), { status: 'idle' });
  assert.equal(agyComposer(IDLE), '');
  assert.equal(agyFooterModel(IDLE), 'Gemini 4 Neon · high');
  assert.equal(agyClassify(MENU).status, 'idle', 'the slash menu\'s `esc to cancel` is not a turn');
  assert.equal(agyComposer(MENU), '/fo');
  assert.deepEqual(agyClassify(TRUST), { status: 'needs-you', waitingFor: 'Do you trust the contents of this project' });
  assert.deepEqual(agyClassify(BUSY), { status: 'working' });
  assert.equal(agy.terminal.composerIsEmpty(IDLE), true);
  assert.equal(agy.terminal.composerIsEmpty(`${RULE}\n> draft\n${RULE}\n? for shortcuts\n`), false);
});

test('headless runs a piped prompt with every tool denied and reads its JSON', async () => {
  const target = resolveHeadlessTarget({ agent: 'agy' }, { background: null });
  assert.equal(target.model, 'gemini-3.8-flash');
  const cmd = await agy.headless.command({ prompt: 'Summarise.', stdin: 'PAYLOAD', model: 'gemini-3.8-flash', secretEnv: async () => ({}) });
  assert.equal(cmd.file, 'agy');
  assert.equal(cmd.stdin, 'PAYLOAD\n\nSummarise.');
  assert.ok(!cmd.args.includes('-p'));
  assert.deepEqual(cmd.args.slice(cmd.args.indexOf('--model'), cmd.args.indexOf('--model') + 4), ['--model', 'gemini-3.8-flash', '--effort', 'low']);
  assert.ok(JSON.parse(cmd.args[cmd.args.indexOf('--settings') + 1]).permissions.deny.includes('command(*)'));
  assert.deepEqual(agy.headless.parse('{"conversation_id":"c","status":"SUCCESS","response":" ok ","usage":{}}'), { text: 'ok', liveSessionId: 'c', error: null });
  assert.equal(agy.headless.parse('error: x\n{"conversation_id":"","status":"ERROR","response":"","error":"auth failed"}').error, 'auth failed');
});

// ---- Gemini API key from the Keychain ----------------------------------------

test('GEMINI_API_KEY: a key already in the env wins and the Keychain is never read', async () => {
  let looked = 0;
  const lookup = async () => { looked += 1; return 'from-keychain'; };
  assert.deepEqual(await agyLaunchSecretEnv({ env: { GEMINI_API_KEY: 'explicit' }, platform: 'darwin', lookup }), {});
  assert.equal(looked, 0);
});

test('GEMINI_API_KEY: falls back to the Keychain on macOS only', async () => {
  const lookup = async () => ' from-keychain\n';
  assert.deepEqual(await agyLaunchSecretEnv({ env: {}, platform: 'darwin', lookup }), { GEMINI_API_KEY: 'from-keychain' });
  assert.deepEqual(await agyLaunchSecretEnv({ env: {}, platform: 'linux', lookup }), {});
});

test('GEMINI_API_KEY: a failed or empty lookup is silent and adds nothing', async () => {
  const logged = [];
  const orig = { error: console.error, warn: console.warn, log: console.log };
  console.error = console.warn = console.log = (...a) => logged.push(a);
  try {
    assert.deepEqual(await agyLaunchSecretEnv({ env: {}, platform: 'darwin', lookup: async () => { throw new Error('item not found'); } }), {});
    assert.deepEqual(await agyLaunchSecretEnv({ env: {}, platform: 'darwin', lookup: async () => undefined }), {});
    assert.deepEqual(await agyLaunchSecretEnv({ env: {}, platform: 'darwin', lookup: async () => '  ' }), {});
  } finally {
    Object.assign(console, orig);
  }
  assert.deepEqual(logged, []);
});

test('GEMINI_API_KEY: a pane launch gets it as a secret, never on the command line', async () => {
  const orig = agy.launchSecretEnv;
  agy.launchSecretEnv = async () => ({ GEMINI_API_KEY: 'sk-test-secret' });
  try {
    const ctx = await collectLaunchContext({ sid: 'card-1', agent: 'agy' }, { ext: {}, onError: () => {} });
    assert.deepEqual(ctx.secretEnv, { GEMINI_API_KEY: 'sk-test-secret' });
    const cmd = agy.buildLaunch({ sessionId: 'card-1', cwd: '/work/repo', launchContext: ctx });
    const wrapped = await runtimeFor('local').wrapLaunch({ inner: cmd, secretEnvFile: '/data/launch-secrets/ag_x.env' });
    assert.doesNotMatch(wrapped, /sk-test-secret|GEMINI_API_KEY/);
    assert.match(wrapped, /^\. '\/data\/launch-secrets\/ag_x\.env' && rm -f/);
    // Other agents never get it.
    const claude = await collectLaunchContext({ sid: 'card-2', agent: 'claude' }, { ext: {}, onError: () => {} });
    assert.equal(claude.secretEnv, undefined);
    // An extension's own GEMINI_API_KEY is left alone.
    const ext = { hooks: { 'session.launchContext': [{ extId: 'x', fn: () => ({ secretEnv: { GEMINI_API_KEY: 'from-ext' } }) }] } };
    assert.equal((await collectLaunchContext({ sid: 'card-3', agent: 'agy' }, { ext, onError: () => {} })).secretEnv.GEMINI_API_KEY, 'from-ext');
    // A failing lookup leaves the launch as it was.
    agy.launchSecretEnv = async () => { throw new Error('boom'); };
    assert.equal((await collectLaunchContext({ sid: 'card-4', agent: 'agy' }, { ext: {}, onError: () => {} })).secretEnv, undefined);
  } finally {
    agy.launchSecretEnv = orig;
  }
});

test('GEMINI_API_KEY: a headless run gets it in its process env, the caller\'s key winning', async () => {
  const secretEnv = async ({ env }) => (env.GEMINI_API_KEY ? {} : { GEMINI_API_KEY: 'from-keychain' });
  const viaKeychain = await agy.headless.command({ prompt: 'P', model: 'gemini-3.8-flash', env: {}, secretEnv });
  assert.equal(viaKeychain.env.GEMINI_API_KEY, process.env.GEMINI_API_KEY || 'from-keychain');
  assert.ok(!viaKeychain.args.some((a) => a.includes('from-keychain')));
  const explicit = await agy.headless.command({ prompt: 'P', model: 'gemini-3.8-flash', env: { GEMINI_API_KEY: 'explicit' }, secretEnv });
  assert.equal(explicit.env.GEMINI_API_KEY, 'explicit');
});

test('the dispatch list says what Auto effort each Gemini family runs at', () => {
  const byValue = Object.fromEntries(dispatchModels(agy).map((m) => [m.value, m.autoEffort]));
  assert.equal(byValue['gemini-4-neon'], 'medium');
  assert.equal(byValue['gemini-4-hydrogen'], 'medium');
  assert.equal(byValue['gemini-3.1-pro'], 'low');
});
