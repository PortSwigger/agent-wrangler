import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gemini, geminiApprovalArgs, geminiClassify } from './gemini.js';
import { adapterFor, modelPillFor, maxContextWindowFor, supportsRemoteControl } from './index.js';
import { agentCapabilities } from './listing.js';
import { GEMINI_TMP, findConversationSync } from './gemini-files.js';
import { createGeminiChatScanner, extractGeminiLine, collectResponses } from './gemini-transcript.js';
import { analyzeGemini, scanDaily, totalsOf } from './gemini-usage.js';
import { forkConversation, paneIdle, resumedInto } from './gemini-fork.js';
import { geminiSettings, geminiPolicy, ensureGeminiHome } from './gemini-config.js';
import { resolveHeadlessTarget } from '../headless.js';
import { priceFor } from '../price-catalog.js';
import { geminiCostUsd } from '../pricing.js';

const ID = '7b0f1c2e-1111-4222-8333-444455556666';
const at = (s) => `2026-11-09T10:00:${String(s).padStart(2, '0')}.000Z`;
const head = (id = ID) => JSON.stringify({ sessionId: id, projectHash: 'abc', startTime: at(0), lastUpdated: at(0), kind: 'main' });
const user = (id, text, s) => JSON.stringify({ id, timestamp: at(s), type: 'user', content: [{ text }] });
const reply = (id, s, extra = {}) => JSON.stringify({ id, timestamp: at(s), type: 'gemini', content: '', model: 'gemini-2.5-pro', ...extra });

// A conversation as Gemini 0.66 writes it: the injected context, a prompt, a
// reply re-appended with its tokens and then a tool call, and a failed turn
// whose prompt Gemini rewinds.
const CONVERSATION = [
  head(),
  user('ctx', '<session_context>\nThis is the Gemini CLI.', 0),
  JSON.stringify({ $set: { lastUpdated: at(0) } }),
  user('u1', 'List the files', 1),
  reply('g1', 2, { content: 'Listing them now.', thoughts: [{ subject: 'Plan', description: 'use ls', timestamp: at(2) }] }),
  reply('g1', 2, { content: 'Listing them now.', thoughts: [{ subject: 'Plan', description: 'use ls', timestamp: at(2) }], tokens: { input: 1000, output: 50, cached: 400, thoughts: 10, tool: 0, total: 1060 } }),
  reply('g1', 2, {
    content: 'Listing them now.', thoughts: [{ subject: 'Plan', description: 'use ls', timestamp: at(2) }], tokens: { input: 1000, output: 50, cached: 400, thoughts: 10, tool: 0, total: 1060 },
    toolCalls: [{ id: 't1', name: 'run_shell_command', args: { command: 'ls' }, status: 'executing', timestamp: at(3) }],
  }),
  reply('g1', 2, {
    content: 'Listing them now.', thoughts: [{ subject: 'Plan', description: 'use ls', timestamp: at(2) }], tokens: { input: 1000, output: 50, cached: 400, thoughts: 10, tool: 0, total: 1060 },
    toolCalls: [{ id: 't1', name: 'run_shell_command', displayName: 'Shell', args: { command: 'ls' }, status: 'success', resultDisplay: 'a.txt\nb.txt', timestamp: at(4) }],
  }),
  user('u2', 'Now delete them', 5),
  JSON.stringify({ $rewindTo: 'u2' }),
  JSON.stringify({ id: 'e1', timestamp: at(6), type: 'error', content: '[API Error: quota exceeded]' }),
];

function geminiTree(lines, { slug = 'proj', id = ID } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-gemini-'));
  const chats = path.join(root, slug, 'chats');
  fs.mkdirSync(chats, { recursive: true });
  const file = path.join(chats, `session-2026-11-09T10-00-${id.slice(0, 8)}.jsonl`);
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  return { root, file };
}

test('registry: Gemini is a third provider with its own prefix and flags, never a Claude fallback', () => {
  const adapter = adapterFor('gemini');
  assert.equal(adapter, gemini);
  assert.equal(adapter.tmuxPrefix, 'gm_');
  assert.equal(supportsRemoteControl('gemini'), false, 'phone control stays gated on remoteControl');
  assert.deepEqual(agentCapabilities(adapter), { disallowedTools: false, remoteControl: false, askUserTool: null, sandbox: false, mailWhileWorking: false, headless: true });
  assert.equal(adapter.models.filter((m) => m.default).length, 1);
  assert.equal(adapter.modelId('auto'), null);
  assert.equal(adapter.modelId('gemini-2.5-pro'), 'gemini-2.5-pro');
  assert.deepEqual(modelPillFor('gemini', 'gemini-3.5-flash', 'auto'), { label: 'flash 3.5', title: 'gemini-3.5-flash' });
  assert.equal(maxContextWindowFor('gemini', null, 'auto'), 1_048_576);
  assert.ok(adapter.matchProcess('node /opt/homebrew/bin/gemini --skip-trust --session-id x'));
  assert.ok(!adapter.matchProcess('node /usr/bin/claude --resume x'));
  assert.ok(!adapterFor('claude').matchProcess('node /opt/homebrew/bin/gemini'));
});

test('launch, resume and fork all carry the session identity, settings, policy and approval mode', () => {
  const launch = gemini.buildLaunch({ sessionId: 'card-1', liveSessionId: ID, intent: '-starts with a dash', model: 'gemini-2.5-pro', addDirs: ['/tmp/extra'] });
  assert.match(launch, /AW_SESSION_ID='card-1' /);
  assert.match(launch, /GEMINI_CLI_HOME='[^']+gemini\/home' /);
  assert.match(launch, /AW_GEMINI_CONTEXT='.*rename_session MCP tool with \{"target":"card-1"/s);
  assert.match(launch, new RegExp(`gemini '--session-id' '${ID}' '--prompt-interactive=-starts with a dash' '--skip-trust' '--approval-mode' 'yolo' '--policy' '[^']+policy\\.toml' '-m' 'gemini-2\\.5-pro' '--include-directories' '/tmp/extra'`));
  const resume = gemini.buildResume({ sessionId: 'card-1', resumeId: ID, permissionMode: 'manual' });
  assert.match(resume, new RegExp(`gemini '--resume' '${ID}' '--skip-trust' '--approval-mode' 'default'`, 's'));
  assert.match(resume, /AW_SESSION_ID='card-1' /);
  const fork = gemini.buildFork({ sessionId: 'card-2', liveSessionId: 'new-id', sourceId: ID, intent: 'carry on' });
  assert.match(fork, new RegExp(`GEMINI_CLI_HOME='[^']+' .*gemini-fork\\.js' '${ID}' 'new-id' 'carry on' && .*AW_SESSION_ID='card-2' .*gemini '--resume' 'new-id' '--skip-trust'`, 's'));
  assert.ok(!/--resume.*--prompt-interactive/s.test(fork) && !/--resume.*--prompt-interactive/s.test(resume), 'a prompt beside --resume races Gemini\'s resume');
  assert.deepEqual(geminiApprovalArgs('acceptEdits'), ['--approval-mode', 'auto_edit']);
  assert.deepEqual(geminiApprovalArgs('plan'), ['--approval-mode', 'plan']);
  assert.throws(() => geminiApprovalArgs('bypassPermissions'), /not supported for Gemini/);
});

test('settings: the board MCP server keyed by $AW_SESSION_ID, our hooks appended to any existing ones', () => {
  const settings = geminiSettings({ port: 4321, base: { hooks: { AfterTool: [{ matcher: 'x', hooks: [] }] }, mcpServers: { mine: { command: 'm' } }, ui: { theme: 'x' } } });
  assert.deepEqual(settings.mcpServers['agent-wrangler'], { httpUrl: 'http://127.0.0.1:4321/mcp', headers: { 'X-AW-Session': '$AW_SESSION_ID' }, description: 'Agent Wrangler board' });
  assert.ok(settings.mcpServers.mine, 'a server already in the defaults file is kept');
  assert.equal(settings.ui.theme, 'x');
  assert.equal(settings.hooks.AfterTool.length, 2);
  assert.match(settings.hooks.AfterTool[1].hooks[0].command, /pr-attach-hook\.mjs/);
  assert.match(settings.hooks.SessionStart[0].hooks[0].command, /gemini-context-hook\.js/);
  const policy = geminiPolicy({ ext: { allowedToolNames: ['ext_tool'] } });
  assert.match(policy, /"mcp_agent-wrangler_rename_session"/);
  assert.match(policy, /"mcp_agent-wrangler_ext_tool"/);
  assert.match(policy, /decision = "allow"/);
});

test('home: the board\'s Gemini home links the user\'s sign-in and extensions, keeps its own settings and chats', () => {
  const userHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-gemini-user-'));
  const userDir = path.join(userHome, '.gemini');
  fs.mkdirSync(path.join(userDir, 'extensions'), { recursive: true });
  fs.mkdirSync(path.join(userDir, 'tmp', 'mine', 'chats'), { recursive: true });
  fs.writeFileSync(path.join(userDir, 'oauth_creds.json'), '{}');
  fs.writeFileSync(path.join(userDir, 'projects.json'), '{"projects":{}}');
  fs.writeFileSync(path.join(userDir, 'settings.json'), '// mine\n{ "security": { "auth": { "selectedType": "oauth-personal" } }, "mcpServers": { "mine": { "command": "x" } } }');
  const home = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aw-gemini-board-')), 'home');
  const before = fs.readFileSync(path.join(userDir, 'settings.json'), 'utf8');
  const { policyPath } = ensureGeminiHome({ home, userDir, port: 4321, ext: { allowedToolNames: [] } });
  const own = path.join(home, '.gemini');
  assert.equal(fs.readlinkSync(path.join(own, 'oauth_creds.json')), path.join(userDir, 'oauth_creds.json'));
  assert.equal(fs.readlinkSync(path.join(own, 'extensions')), path.join(userDir, 'extensions'));
  for (const name of ['tmp', 'projects.json']) assert.throws(() => fs.lstatSync(path.join(own, name)), /ENOENT/, `${name} is the board's own`);
  const settings = JSON.parse(fs.readFileSync(path.join(own, 'settings.json'), 'utf8'));
  assert.equal(settings.security.auth.selectedType, 'oauth-personal');
  assert.equal(settings.security.folderTrust.enabled, false);
  assert.ok(settings.mcpServers.mine && settings.mcpServers['agent-wrangler']);
  assert.equal(policyPath, path.join(own, 'policy.toml'));
  assert.equal(fs.readFileSync(path.join(userDir, 'settings.json'), 'utf8'), before, 'the user\'s settings are never written');
});

test('pane: working, needs-you and an idle composer read off the Gemini TUI', () => {
  const rule = (c) => c.repeat(40);
  const composer = (line) => ['✦ Done.', rule('▄'), line, rule('▀'), ' workspace (/directory)     sandbox     /model', ' ~/proj                     no sandbox  Auto'].join('\n');
  assert.deepEqual(geminiClassify(composer(' >   Type your message or @path/to/file')), { status: 'idle' });
  assert.deepEqual(geminiClassify(`⠋ Reading files (esc to cancel, 4s)\n${composer(' >   Type your message or @path/to/file')}`), { status: 'working' });
  assert.equal(geminiClassify('│ Allow execution of [Shell] rm -rf build?\n│ ● 1. Allow once').status, 'needs-you');
  assert.equal(geminiClassify('│ Enter Gemini API Key\n│ Paste your API key here').status, 'needs-you');
  assert.equal(geminiClassify('starting…').status, 'unknown');
  assert.equal(gemini.terminal.composerIsEmpty(composer(' >   Type your message or @path/to/file')), true);
  assert.equal(gemini.terminal.composerIsEmpty(composer(' > half a draft')), false);
  assert.equal(gemini.terminal.composerIsReady(composer(' * ')), true, 'the YOLO glyph is a composer too');
});

test('chat: each message once, thoughts and finished tools, rewound prompts pruned on a full read', () => {
  const scanner = createGeminiChatScanner();
  const tagged = CONVERSATION.map((line) => scanner.pushTagged(line));
  const live = scanner.selectLive(tagged).map((e) => [e.kind, e.text || e.name]);
  assert.deepEqual(live, [
    ['user', 'List the files'],
    ['thinking', 'Plan: use ls'],
    ['assistant', 'Listing them now.'],
    ['tool', 'Shell'],
    ['user', 'Now delete them'],
    ['context', '[API Error: quota exceeded]'],
  ], 'a failed turn keeps its prompt beside the error');
  const tool = tagged.flatMap((t) => t.events).find((e) => e.kind === 'tool');
  assert.equal(tool.target, 'ls');
  assert.equal(tool.output, 'a.txt\nb.txt');
  assert.equal(tool.ok, true);
  assert.equal(scanner.takeRewound(), false);
  // A /rewind: the dropped prompt and reply leave the chat, and a poll that
  // already showed them asks the view to rebuild.
  const rewind = createGeminiChatScanner();
  const lines = [...CONVERSATION.slice(0, 8), JSON.stringify({ $rewindTo: 'g1' }), JSON.stringify({ $set: { lastUpdated: at(9) } }), user('u3', 'Try another way', 10)];
  const kept = rewind.selectLive(lines.map((line) => rewind.pushTagged(line))).map((e) => e.text || e.name);
  assert.deepEqual(kept, ['List the files', 'Try another way']);
  assert.equal(rewind.takeRewound(), true);
  assert.equal(rewind.takeRewound(), false);
  // While a tool runs it is the pending call.
  const partial = createGeminiChatScanner();
  CONVERSATION.slice(0, 7).forEach((line) => partial.push(line));
  assert.deepEqual(partial.pending(), { name: 'run_shell_command', target: 'ls' });
});

test('search indexes the prompt and the reply once, never injected context', () => {
  const records = CONVERSATION.map((line) => extractGeminiLine(line)?.record).filter(Boolean);
  assert.deepEqual(records.map((r) => r.text), ['List the files', 'Listing them now.', 'Now delete them']);
  assert.equal(extractGeminiLine(head()).meta.id, ID);
});

test('usage: each response billed once, cached input at the cache rate, thoughts as output', async () => {
  const { responses } = collectResponses(CONVERSATION);
  assert.equal(responses.length, 1);
  const totals = totalsOf(responses);
  assert.deepEqual(totals['gemini-2.5-pro'], { input: 600, output: 60, cacheRead: 400, cacheWrite5m: 0, cacheWrite1h: 0 });
  const rate = priceFor('gemini', 'gemini-2.5-pro');
  assert.ok(rate, 'the snapshot prices Gemini models');
  assert.equal(geminiCostUsd(totals), (600 * rate.input + 60 * rate.output + 400 * rate.cacheRead) / 1e6);
  const { root } = geminiTree(CONVERSATION);
  const a = await analyzeGemini(ID, { root });
  assert.equal(a.model, 'gemini-2.5-pro');
  assert.equal(a.summary, 'List the files');
  assert.equal(a.contextPercent, 0);
  assert.ok(a.usd > 0);
  // A prompt past the long-context threshold bills the whole response at the long rate.
  const long = totalsOf([{ model: 'gemini-2.5-pro', tokens: { input: 300_000, output: 10, cached: 0 } }]);
  assert.equal(long['gemini-2.5-pro'].long.input, 300_000);
  assert.equal(geminiCostUsd(long), (300_000 * rate.long.input + 10 * rate.long.output) / 1e6);
});

test('usage report: a Gemini card is billed per UTC day under Google', async (t) => {
  const chats = path.join(GEMINI_TMP[0], 'usage-proj', 'chats');
  fs.mkdirSync(chats, { recursive: true });
  const file = path.join(chats, `session-2026-11-09T10-00-${ID.slice(0, 8)}.jsonl`);
  fs.writeFileSync(file, `${CONVERSATION.join('\n')}\n`);
  t.after(() => fs.rmSync(path.join(GEMINI_TMP[0], 'usage-proj'), { recursive: true, force: true }));
  const raw = [];
  await scanDaily({ cardId: 'card-1', entry: { liveSessionId: ID }, task: null, raw, blankTokens: () => ({ input: 0, output: 0, cacheWrite: 0, cacheRead: 0 }), dayKeyOf: (ms) => new Date(ms).toISOString().slice(0, 10) });
  assert.equal(raw.length, 1);
  assert.equal(raw[0].file, file);
  assert.equal(raw[0].owner, true);
  const day = raw[0].days['2026-11-09'];
  assert.equal(day.provider, 'google');
  assert.deepEqual(day.tokens, { input: 600, output: 60, cacheWrite: 0, cacheRead: 400 });
  assert.ok(day.byModel['gemini-2.5-pro'].usd > 0);
});

test('fork: the conversation is copied under the new id, and usage skips what the parent spent', async () => {
  const { root } = geminiTree([...CONVERSATION, JSON.stringify({ $set: { sessionId: ID } })]);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-gemini-home-'));
  const tmp = path.join(home, 'tmp');
  fs.renameSync(root, tmp);
  fs.writeFileSync(path.join(home, 'projects.json'), JSON.stringify({ projects: { '/work/proj': 'proj' } }));
  const newId = 'aaaabbbb-0000-4000-8000-000000000001';
  const file = forkConversation({ sourceId: ID, newId, cwd: '/work/proj', root: tmp, home, now: new Date('2026-11-09T11:00:00Z') });
  assert.equal(path.dirname(file), path.join(tmp, 'proj', 'chats'));
  assert.equal(path.basename(file), 'session-2026-11-09T11-00-aaaabbbb.jsonl');
  assert.equal(findConversationSync(newId, tmp), file);
  const forked = fs.readFileSync(file, 'utf8').split('\n');
  assert.equal(JSON.parse(forked[0]).forkedFrom, ID);
  const source = fs.readFileSync(findConversationSync(ID, tmp), 'utf8').split('\n');
  assert.deepEqual(forked.slice(1), [...source.slice(1, -2), ''], 'the parent\'s recorded resume id is dropped, all else copied');
  assert.equal((await analyzeGemini(newId, { root: tmp })).usd, null, 'the parent\'s responses are not billed to the fork');
  assert.throws(() => forkConversation({ sourceId: ID, newId, cwd: '/work/proj', root: tmp, home }), /already exists/);
  assert.equal(resumedInto(`x\n{"$set":{"sessionId":"${newId}"}}\n`, newId), true);
  assert.equal(resumedInto(fs.readFileSync(file, 'utf8'), newId), false, 'a fresh copy is not yet resumed');
  assert.equal(paneIdle(' >   Type your message or @path/to/file\n workspace'), true);
  assert.equal(paneIdle('  Executing Hook: agent-wrangler-context\n >   Type your message or @path/to/file'), false);
  assert.throws(() => forkConversation({ sourceId: 'missing', newId: 'x', root: tmp, home }), /No Gemini conversation/);
});

test('history: a conversation is found by id wherever its project folder is', async () => {
  const { root, file } = geminiTree(CONVERSATION, { slug: 'elsewhere' });
  assert.equal(await gemini.history.findFile(ID, { geminiDir: root }), file);
  assert.deepEqual(await gemini.history.findFiles(ID, { geminiDir: root }), [file]);
  assert.equal(await gemini.history.findFile('00000000-0000-4000-8000-000000000000', { geminiDir: root }), null);
});

test('headless: gemini -p with every tool denied, a fixed id, and its JSON answer parsed', async () => {
  const cmd = gemini.headless.command({ prompt: 'Summarise', model: 'gemini-3.1-flash-lite', cwd: os.tmpdir() });
  assert.equal(cmd.file, 'gemini');
  assert.deepEqual(cmd.args.slice(0, 8), ['-p', 'Summarise', '-o', 'json', '-m', 'gemini-3.1-flash-lite', '--session-id', cmd.liveSessionId]);
  assert.ok(cmd.args.includes('-e') && cmd.args[cmd.args.indexOf('-e') + 1] === 'none');
  const policy = fs.readFileSync(cmd.args[cmd.args.indexOf('--policy') + 1], 'utf8');
  assert.match(policy, /toolName = "\*"\s+decision = "deny"/);
  assert.deepEqual(gemini.headless.parse(JSON.stringify({ session_id: 's', response: ' ok \n', stats: {} })), { text: 'ok', liveSessionId: 's', error: null });
  assert.equal(gemini.headless.parse(JSON.stringify({ session_id: 's', error: { type: 'Error', message: 'no key' } })).error, 'no key');
  const target = resolveHeadlessTarget({ agent: 'gemini' }, { background: { agent: 'claude', model: 'haiku' } });
  assert.equal(target.model, 'gemini-3.1-flash-lite');
  assert.throws(() => resolveHeadlessTarget({ agent: 'gemini', effort: 'high' }), /Unknown effort/);
  const bg = resolveHeadlessTarget({}, { background: { agent: 'gemini', model: 'gemini-2.5-pro' } });
  assert.deepEqual([bg.agent, bg.model], ['gemini', 'gemini-2.5-pro']);
});
