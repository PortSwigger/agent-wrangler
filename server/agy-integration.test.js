import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { SessionManager } from './session-manager.js';
import { acceptAgyHook } from './agy-hooks.js';
import { prepareAgyPane } from './agy-lifecycle.js';
import { createAgyMcpBridge } from './agy-mcp-entry.js';
import { createPaneDeferral } from './pane-deferral.js';
import { deliverMailNotification } from './mailbox-delivery.js';
import { deliverMessage } from './message-delivery.js';
import { readAgySummaries } from './agents/agy-summaries.js';
import { agyHistory, readAgySteps } from './agents/agy-history.js';
import { manageAgyIntegration } from './config-store.js';
import { agy } from './agents/agy.js';
import { acceptAgyNative, agyNativeReady, AGY_STARTUP_PROBE } from './agy-startup.js';
import { INSTALL_ROOT } from './install-root.js';

const idle = '────────────────────────────\n> \n────────────────────────────\n? for shortcuts      auto   Gemini 3.8 Flash · medium';
test('Manage agy integration defaults off and refuses dispatch before side effects', async () => {
  assert.equal(manageAgyIntegration({}), false);
  assert.equal(manageAgyIntegration({ manageAgyIntegration: true }), true);
  const sm = new SessionManager();
  let started = false; sm._newSession = async () => { started = true; };
  await assert.rejects(sm.dispatch({ agent: 'agy' }), /Manage agy integration/);
  assert.equal(started, false); assert.equal(sm.map.size, 0);
});
test('pane mode verification cycles BTab only on an empty composer, then forks; never approves a dialog', async () => {
  const keys = [], sends = [];
  let count = 0;
  const result = await prepareAgyPane({ target: 'fixture', socket: '', fork: true, capture: async () => count++ ? idle : idle.replace('auto', 'default'), keys: async (_t, k) => keys.push(k), send: async (_t, text) => sends.push(text), sleep: async () => {} });
  assert.equal(result.ready, true); assert.deepEqual(keys, [['BTab']]); assert.deepEqual(sends, ['/fork']);
  const blocked = await prepareAgyPane({ capture: async () => idle + '\nRequesting permission for: run', keys: async () => assert.fail('dialog key'), send: async () => assert.fail('dialog paste') });
  assert.equal(blocked.ready, false);
});
test('dispatch, resume and interactive fork retain grants, auto policy, launch selection and immutable parent prefix', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-manager-'));
  const root = 'fixture-root';
  const logs = path.join(os.homedir(), '.gemini/antigravity-cli/brain', root, '.system_generated/logs'); fs.mkdirSync(logs, { recursive: true });
  const line = (step_index, content) => JSON.stringify({ step_index, type: 'USER_INPUT', content });
  fs.writeFileSync(path.join(logs, 'transcript_full.jsonl'), line(0, 'parent before fork') + '\n');
  const sm = new SessionManager(), commands = [], phases = [];
  sm._agyReady = () => true; sm._save = () => {}; sm.refreshAlive = async () => {}; sm.killForSession = async () => {}; sm._fireExtHooks = async () => {};
  sm._newSession = async (_tmux, _dir, cmd) => { commands.push(cmd); return '%1'; };
  const sent = [];
  sm._prepareAgyPane = async () => ({ ready: true });
  sm._agyPaneIO = { send: async (_target, text) => sent.push(text), confirm: async () => true };
  const recover = async (cardId, conversationId) => {
    const entry = sm.entryFor(cardId);
    await acceptAgyHook({ cardId, launchId: entry.agyStartup.launchId, parentPid: 42, conversationId, event: 'PreInvocation', stepIdx: 1 }, { map: sm.map, rootPid: async () => 42, summaries: async () => [{ conversation_id: conversationId, parent_conversation_id: '', nesting_depth: 0 }], save: () => {} });
    assert.equal(await acceptAgyNative({ cardId, launchId: entry.agyStartup.launchId, pid: process.pid, connectionId: 'native-fixture', state: 'ready' }, { map: sm.map, rootPid: async () => 42, inspect: async () => ({ parentPid: 42, command: `${process.execPath} ${INSTALL_ROOT}/server/agy-mcp-entry.js` }) }), true);
    await Promise.all([sm._finishProviderLaunch(agy, cardId), sm._finishProviderLaunch(agy, cardId)]);
    await sm._finishProviderLaunch(agy, cardId);
  };
  try {
    const launch = await sm.dispatch({ agent: 'agy', cwd, intent: 'hello', model: 'gemini-3.8-flash', effort: 'medium', addDirs: [cwd] });
    const card = launch.sessionId;
    assert.deepEqual(sent, [AGY_STARTUP_PROBE]);
    assert.equal(sm.entryFor(card).agyPendingIntent.state, 'pending');
    await recover(card, root);
    assert.deepEqual(sent, [AGY_STARTUP_PROBE, 'hello']);
    const oldLaunch = sm.entryFor(card).agyStartup.launchId;
    await sm.resume(card, cwd, { intent: 'wake task', queueIntent: true });
    assert.equal(sm.entryFor(card).agyPendingIntent.text, 'wake task');
    assert.equal(sent.filter((t) => t === 'wake task').length, 0);
    assert.notEqual(sm.entryFor(card).agyStartup.launchId, oldLaunch);
    assert.equal(agyNativeReady(sm.entryFor(card)), false);
    await recover(card, root);
    assert.equal(sent.filter((t) => t === 'hello').length, 1);
    assert.equal(sent.filter((t) => t === 'wake task').length, 1);
    const child = await sm.fork({ sourceId: root, parentId: card, parentEntry: sm.entryFor(card), cwd, prompt: 'child task' });
    assert.equal(sent.filter((t) => t === '/fork').length, 1);
    await sm._finishProviderLaunch(agy, child.sessionId);
    await recover(child.sessionId, 'fixture-child');
    assert.equal(sent.filter((t) => t === 'child task').length, 1);
    assert.equal(sm.entryFor(child.sessionId).liveSessionId, 'fixture-child');
    assert.equal(sm.entryFor(card).liveSessionId, root);
    assert.equal(sm.entryFor(child.sessionId).agyFork.forkStep, 0);
    assert.equal(sm.entryFor(child.sessionId).effort, 'medium');
    for (const cmd of commands) { assert.match(cmd, /'--mode' 'auto'/); assert.match(cmd, /'--model' 'gemini-3.8-flash'/); assert.match(cmd, /'--effort' 'medium'/); assert.ok(cmd.includes(cwd)); assert.doesNotMatch(cmd, /hello|child task/); }
    fs.writeFileSync(path.join(logs, 'transcript_full.jsonl'), line(0, 'parent rewound after fork') + '\n');
    const file = await agyHistory.findFile('fixture-child');
    assert.match(fs.readFileSync(file, 'utf8'), /parent before fork/);
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /parent rewound/);
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});
test('mail preserves drafts and permission screens; busy clear input gets one notification after current-process MCP', async () => {
  let pane = idle, sent = 0;
  const entry = { agent: 'agy', createdAt: 10, relaunchedAt: 20 };
  const deferral = createPaneDeferral({ agentFor: () => 'agy', tmuxFor: () => 'ag_fixture', socketFor: () => '', capture: async () => pane, sendText: async () => { sent++; } });
  const deps = { sessionManager: { entryFor: () => entry }, tmuxFor: () => 'ag_fixture', socketFor: () => '', paneDeferral: deferral, mcpSeenAt: () => 30, agyNativeReady: () => true };
  pane = idle.replace('> ', '> a human draft');
  assert.equal((await deliverMailNotification('card', 'mail', deps)).mode, 'deferred');
  pane = idle + '\nAllow calling this tool?';
  assert.equal((await deliverMailNotification('card', 'mail', deps)).mode, 'deferred');
  pane = idle.replace('? for shortcuts', 'esc to cancel');
  assert.equal((await deliverMailNotification('card', 'mail', deps)).mode, 'live');
  assert.equal(sent, 1);
  assert.equal((await deliverMailNotification('card', 'mail', { ...deps, mcpSeenAt: () => Date.now(), agyNativeReady: () => false })).mode, 'deferred');
  assert.equal(sent, 1);
  const result = await deliverMessage('card', 'hello', { ...deps, waitForCompactionEnd: async () => 'none', waitForComposerReady: async () => false, sendText: async () => assert.fail('draft overwritten') });
  assert.equal(result.outcome, 'rejected');
  assert.deepEqual(agy.terminal.interruptKeys, ['Escape']);
});
test('stdio bridge has zero tools and zero connections without identity, including extension tool isolation', async () => {
  let connects = 0;
  const connect = async () => { connects++; return { listTools: async () => ({ tools: [{ name: 'read_mail' }, { name: 'extension_tool' }] }) }; };
  const inert = await createAgyMcpBridge({ env: {}, connect });
  assert.deepEqual(await inert.listTools(), { tools: [] }); assert.equal(connects, 0);
  const identified = await createAgyMcpBridge({ env: { AW_SESSION_ID: 'card' }, connect });
  assert.equal((await identified.listTools()).tools.length, 2); assert.equal(connects, 1);
});
test('summaries reader is read-only, classifies native children and treats unknown schema as pending', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-db-'));
  const dbPath = path.join(dir, 'summary.db');
  try {
    const db = new Database(dbPath); db.exec('CREATE TABLE conversations (conversation_id TEXT, parent_conversation_id TEXT, nesting_depth INTEGER, title TEXT)');
    db.prepare('INSERT INTO conversations VALUES (?, ?, ?, ?)').run('root', '', 0, 'Fixture'); db.close();
    const before = fs.readFileSync(dbPath);
    assert.equal(readAgySummaries({ dbPath })[0].conversation_id, 'root');
    assert.deepEqual(fs.readFileSync(dbPath), before);
    assert.deepEqual(readAgySummaries({ dbPath: path.join(dir, 'missing.db') }), []);
    assert.equal(fs.existsSync(path.join(dir, 'missing.db')), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('actual chat handler renders agy events and invalidates the epoch after a same-size rewrite', async () => {
  const { chatHandler } = await import('./control/handlers/chat.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-chat-'));
  const file = path.join(dir, 'chat.jsonl');
  const line = (content) => JSON.stringify({ step_index: 0, type: 'USER_INPUT', content, created_at: '2026-10-29T12:00:00Z' }) + '\n';
  fs.writeFileSync(file, line('first'));
  const replies = [];
  const ctx = { sessionFromGraph: () => ({ agent: 'agy', liveSessionId: 'chat-fixture' }), reply: (reply) => replies.push(reply), findConversationFiles: async () => [file], analyzeProvider: async () => ({ contextPercent: 1 }) };
  try {
    await chatHandler.handler({ sessionId: 'card' }, ctx);
    assert.equal(replies[0].events[0].text, 'first');
    const epoch = replies[0].epoch;
    fs.writeFileSync(file, line('other'));
    fs.utimesSync(file, new Date(), new Date(Date.now() + 1000));
    await chatHandler.handler({ sessionId: 'card', sinceOffset: replies[0].offset }, ctx);
    assert.ok(replies.at(-1).epoch > epoch);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('mixed Gemini/Claude native-child usage is counted once; unknown models stay tokens-only and price-only updates invalidate the report', async () => {
  const { _setFetchedForTest } = await import('./price-catalog.js');
  const { scanAllDaily, rollup } = await import('./usage-report.js');
  const { cachedScan, _resetUsageCache } = await import('./usage-scan-memo.js');
  const { DATA_DIR } = await import('./data-dir.js');
  const provider = path.join(os.homedir(), '.gemini/antigravity-cli'); fs.mkdirSync(provider, { recursive: true });
  const dbPath = path.join(provider, 'conversation_summaries.db');
  const db = new Database(dbPath); db.exec('CREATE TABLE conversations (conversation_id TEXT, parent_conversation_id TEXT, nesting_depth INTEGER)');
  db.prepare('INSERT INTO conversations VALUES (?, ?, ?)').run('usage-root', '', 0);
  db.prepare('INSERT INTO conversations VALUES (?, ?, ?)').run('usage-child', 'usage-root', 1); db.close();
  const write = (id, model) => { const logs = path.join(provider, 'brain', id, '.system_generated/logs'); fs.mkdirSync(logs, { recursive: true }); fs.writeFileSync(path.join(logs, 'transcript_full.jsonl'), JSON.stringify({ step_index: 0, type: 'PLANNER_RESPONSE', model, content: 'fixture', created_at: '2026-10-29T12:00:00Z', input_tokens: 100, output_tokens: 10, cache_read_tokens: 20 }) + '\n'); };
  write('usage-root', 'gemini-3.8-flash'); write('usage-child', 'claude-sonnet-4-6'); write('usage-unknown', 'unknown-fixture');
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, 'mappings.json'), JSON.stringify({ owner: { agent: 'agy', liveSessionId: 'usage-root', priorLiveSessionIds: ['usage-root'] }, duplicate: { agent: 'agy', liveSessionId: 'usage-root' }, unknown: { agent: 'agy', liveSessionId: 'usage-unknown' } }));
  const rates = (input) => ({ input, output: 2, cacheRead: 0.1 });
  let calls = 0;
  const scan = () => { calls++; return scanAllDaily({ dataDir: DATA_DIR, projectsDir: path.join(DATA_DIR, 'empty'), codexSessionsDir: path.join(DATA_DIR, 'empty') }); };
  const report = async () => rollup(await cachedScan(scan), { granularity: 'month', start: Date.parse('2026-10-01'), end: Date.parse('2026-11-01') });
  try {
    _setFetchedForTest({ gemini: { 'gemini-3.8-flash': rates(1) }, anthropic: { 'claude-sonnet-4-6': rates(1) } });
    const first = await report();
    assert.equal(first.totals.tokens.input, 240);
    assert.equal(first.totals.unpricedTokens, 110);
    assert.ok(first.totals.usd > 0);
    await report(); assert.equal(calls, 1);
    _setFetchedForTest({ gemini: { 'gemini-3.8-flash': rates(5) }, anthropic: { 'claude-sonnet-4-6': rates(1) } });
    assert.ok((await report()).totals.usd > first.totals.usd); assert.equal(calls, 2);
  } finally { _setFetchedForTest(null); _resetUsageCache(); }
});


test('native subagent rows have visible lifecycle metadata and a provider-specific detail reader', async () => {
  const { analyzeAgy, agySubagentDetail } = await import('./agents/agy-history.js');
  const { visibleSubAgents } = await import('../public/cards.js');
  const result = await analyzeAgy('usage-root');
  assert.equal(result.subAgents.length, 1);
  assert.equal(result.subAgents[0].status, 'completed');
  assert.equal(visibleSubAgents(result.subAgents, { showFinished: true, now: Date.now() }).length, 1);
  assert.equal((await agySubagentDetail('usage-root', 'usage-child')).result, 'fixture');
  assert.equal((await agySubagentDetail('unrelated', 'usage-child')).result, null);
});

test('agy resume refuses a deleted workspace before killing a pane or widening its launch cwd', async () => {
  const sm = new SessionManager();
  sm._agyReady = () => true;
  sm.map.set('missing-workspace', { agent: 'agy', liveSessionId: 'fixture-root', cwd: '/nonexistent/agy-fixture-workspace' });
  let touched = false; sm.killForSession = async () => { touched = true; }; sm._newSession = async () => { touched = true; };
  await assert.rejects(sm.resume('missing-workspace'), /saved workspace/);
  assert.equal(touched, false);
});
