import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  collectToolPolicy, normalizeToolPolicy, rulesForAgent, toolPolicyRefusal, policyMatcher, ruleMatchesTool,
  claudeToolPolicySettings, codexToolPolicyHooks, agyToolPolicyDeny, headlessToolRefusal,
  toolPolicyRequirements, syncToolPolicyRequirements, clearToolPolicyRequirement, ToolPolicyError,
} from './tool-policy.js';

const AGENTS = ['claude', 'codex', 'agy'];
const loaded = (rows, list = rows.map(([id]) => ({ id, enabled: true, quarantine: null, toolPolicy: true }))) => ({
  toolPolicies: rows.map(([id, fn]) => ({ id, fn })),
  list,
});
const collect = (ctx, opts) => collectToolPolicy({ sid: 's1', agent: 'claude', runtime: 'local', reason: 'dispatch', ...ctx }, { agentIds: AGENTS, ...opts });

test('no contributors and no requirements: no policy', async () => {
  assert.equal(await collect({}, { ext: loaded([]), required: [] }), null);
});

test('an extension answering no rules still yields a policy, with nothing to enforce', async () => {
  const policy = await collect({}, { ext: loaded([['slack', () => ({ rules: [] })]]), required: ['slack'] });
  assert.deepEqual(policy.sources, ['slack']);
  assert.deepEqual(policy.rules, []);
  assert.equal(toolPolicyRefusal(policy, { agent: 'claude', adapter: {}, runtime: { id: 'x' } }), null);
});

test('collect is handed the launch context and the extension host', async () => {
  let seen;
  const ext = loaded([['slack', (ctx) => { seen = ctx; return { rules: [] }; }]]);
  await collect({ parentId: 'p', task: { id: 't' }, reason: 'fork' }, { ext, required: [], hostApiFor: (id) => ({ id }) });
  assert.equal(seen.sid, 's1');
  assert.equal(seen.parentId, 'p');
  assert.deepEqual(seen.task, { id: 't' });
  assert.equal(seen.reason, 'fork');
  assert.equal(seen.agent, 'claude');
  assert.equal(seen.runtime, 'local');
  assert.deepEqual(seen.host, { id: 'slack' });
});

test('rules from several extensions are unioned, never replaced', async () => {
  const ext = loaded([
    ['a', () => ({ rules: [{ tool: 'mcp__s__write' }] })],
    ['b', () => ({ rules: [{ pattern: 'mcp__t__.*', agents: ['codex'] }] })],
  ]);
  const policy = await collect({}, { ext, required: ['a', 'b'] });
  assert.deepEqual(policy.sources, ['a', 'b']);
  assert.deepEqual(policy.rules.map((r) => [r.extId, r.kind, r.value]), [['a', 'tool', 'mcp__s__write'], ['b', 'pattern', 'mcp__t__.*']]);
  assert.equal(rulesForAgent(policy, 'claude').length, 1);
  assert.equal(rulesForAgent(policy, 'codex').length, 2);
});

test('the fingerprint changes with the rules and is stable for the same rules', async () => {
  const one = await collect({}, { ext: loaded([['a', () => ({ rules: [{ tool: 'x' }] })]]), required: [] });
  const same = await collect({}, { ext: loaded([['a', () => ({ rules: [{ tool: 'x' }] })]]), required: [] });
  const other = await collect({}, { ext: loaded([['a', () => ({ rules: [{ tool: 'y' }] })]]), required: [] });
  assert.equal(one.fingerprint, same.fingerprint);
  assert.notEqual(one.fingerprint, other.fingerprint);
  assert.ok(Object.isFrozen(one) && Object.isFrozen(one.rules) && Object.isFrozen(one.rules[0]));
});

test('a required extension that is not active refuses the launch', async () => {
  await assert.rejects(collect({}, { ext: loaded([], [{ id: 'slack', enabled: false, quarantine: 'boom' }]), required: ['slack'] }), (err) => {
    assert.ok(err instanceof ToolPolicyError);
    assert.match(err.message, /slack/);
    assert.match(err.message, /quarantined: boom/);
    return true;
  });
  await assert.rejects(collect({}, { ext: loaded([]), required: ['gone'] }), /gone.*not installed or failed to load/);
  await assert.rejects(collect({}, { ext: loaded([], [{ id: 'off', enabled: false, quarantine: null }]), required: ['off'] }), /off.*disabled/);
});

test('a throwing, slow or malformed contributor refuses the launch', async () => {
  await assert.rejects(collect({}, { ext: loaded([['a', () => { throw new Error('nope'); }]]), required: [] }), /a.*nope/);
  await assert.rejects(collect({}, { ext: loaded([['a', () => new Promise(() => {})]]), required: [], timeoutMs: 20 }), /a.*did not answer within/);
  await assert.rejects(collect({}, { ext: loaded([['a', () => null]]), required: [] }), /must return \{ rules \}/);
  await assert.rejects(collect({}, { ext: loaded([['a', () => ({ rules: [{ tool: 'x', extra: 1 }] })]]), required: [] }), /unknown key "extra"/);
});

test('normalizeToolPolicy validates every rule strictly', () => {
  const bad = (rules, re) => assert.throws(() => normalizeToolPolicy('e', { rules }, { agentIds: AGENTS }), re);
  bad('x', /rules must be an array/);
  bad([{}], /exactly one of tool or pattern/);
  bad([{ tool: 'a', pattern: 'b' }], /exactly one of tool or pattern/);
  bad([{ tool: '' }], /tool must be/);
  bad([{ tool: 'has space' }], /tool must be/);
  bad([{ pattern: '(' }], /pattern does not compile/);
  bad([{ pattern: 'a(?!b)' }], /lookaround/);
  bad([{ pattern: '(a)\\1' }], /backreference/);
  bad([{ tool: 'x', agents: [] }], /agents must be a non-empty array/);
  bad([{ tool: 'x', agents: ['gemini-cli'] }], /unknown agent "gemini-cli"/);
  bad([{ tool: 'x', reason: 'two\nlines' }], /reason must be/);
  bad(Array.from({ length: 201 }, (_, i) => ({ tool: `t${i}` })), /at most 200 rules/);
  assert.throws(() => normalizeToolPolicy('e', { rules: [], other: 1 }, { agentIds: AGENTS }), /unknown key "other"/);
  const [rule] = normalizeToolPolicy('e', { rules: [{ tool: 'mcp__s__w', agents: ['claude', 'claude'] }] }, { agentIds: AGENTS });
  assert.deepEqual(rule, { extId: 'e', kind: 'tool', value: 'mcp__s__w', agents: ['claude'], reason: 'Blocked by an Agent Wrangler tool policy (e).' });
});

test('policyMatcher anchors exact names and patterns into one regex', () => {
  const rules = normalizeToolPolicy('e', { rules: [{ tool: 'mcp__a.b__c' }, { pattern: 'mcp__s__send_.*' }] }, { agentIds: AGENTS });
  const re = new RegExp(policyMatcher(rules));
  assert.ok(re.test('mcp__a.b__c'));
  assert.ok(!re.test('mcp__aXb__c'));
  assert.ok(!re.test('xmcp__a.b__c'));
  assert.ok(re.test('mcp__s__send_message'));
  assert.ok(re.test('mcp__s__send_message_extra'));
  assert.ok(!re.test('pre_mcp__s__send_message'));
  assert.ok(ruleMatchesTool(rules[1], 'mcp__s__send_x'));
  assert.ok(!ruleMatchesTool(rules[0], 'mcp__a.b__cd'));
});

test('toolPolicyRefusal: agents, adapters and runtimes that cannot enforce the rules refuse', async () => {
  const policy = await collect({}, { ext: loaded([['slack', () => ({ rules: [{ tool: 'x' }, { pattern: 'y.*', agents: ['codex', 'agy'] }] })]]), required: [] });
  const local = { id: 'local', toolPolicy: true };
  assert.equal(toolPolicyRefusal(policy, { agent: 'claude', adapter: { label: 'Claude', toolPolicy: { patterns: true } }, runtime: local }), null);
  assert.match(toolPolicyRefusal(policy, { agent: 'claude', adapter: { label: 'Claude' }, runtime: local }), /Claude can't enforce.*slack/);
  assert.match(toolPolicyRefusal(policy, { agent: 'agy', adapter: { label: 'agy', toolPolicy: { patterns: false } }, runtime: local }), /agy can't enforce pattern rules.*slack/);
  assert.match(toolPolicyRefusal(policy, { agent: 'claude', adapter: { label: 'Claude', toolPolicy: { patterns: true } }, runtime: { id: 'box', label: 'Box' } }), /Box runtime does not carry tool policies/);
  assert.match(toolPolicyRefusal(policy, { agent: 'claude', adapter: { label: 'Claude', toolPolicy: { patterns: true } }, runtime: { id: 'svc', toolPolicy: true, buildLaunch: () => '' } }), /builds its own launch/);
  assert.equal(toolPolicyRefusal(null, { agent: 'claude', adapter: {}, runtime: {} }), null);
});

test('claudeToolPolicySettings: exact names are denied, every rule gets a blocking hook', () => {
  const rules = normalizeToolPolicy('e', { rules: [{ tool: 'mcp__s__w' }, { pattern: 'mcp__t__.*', reason: 'No t.' }] }, { agentIds: AGENTS });
  const s = claudeToolPolicySettings(rules);
  assert.deepEqual(s.permissions, { deny: ['mcp__s__w'] });
  assert.equal(s.disableAllHooks, false);
  assert.equal(s.hooks.PreToolUse.length, 2);
  const [first, second] = s.hooks.PreToolUse;
  assert.equal(first.matcher, '^(?:mcp__s__w)$');
  assert.deepEqual(first.hooks[0], { type: 'command', command: "echo 'Blocked by an Agent Wrangler tool policy (e).' >&2; exit 2", timeout: 10, onFailure: 'block' });
  assert.equal(second.matcher, '^(?:mcp__t__.*)$');
  assert.match(second.hooks[0].command, /No t\./);
  assert.equal(claudeToolPolicySettings([]), null);
});

test('codexToolPolicyHooks: one synchronous PreToolUse hook per rule', () => {
  const rules = normalizeToolPolicy('e', { rules: [{ tool: 'mcp__s__w' }] }, { agentIds: AGENTS });
  assert.deepEqual(codexToolPolicyHooks(rules), [{ event: 'PreToolUse', matcher: '^(?:mcp__s__w)$', command: "echo 'Blocked by an Agent Wrangler tool policy (e).' >&2; exit 2", async: false }]);
});

test('agyToolPolicyDeny: exact names only, and a pattern throws', () => {
  const rules = normalizeToolPolicy('e', { rules: [{ tool: 'mcp(s/w)', agents: ['agy'] }] }, { agentIds: AGENTS });
  assert.deepEqual(agyToolPolicyDeny(rules), ['mcp(s/w)']);
  const pat = normalizeToolPolicy('e', { rules: [{ pattern: 'x.*' }] }, { agentIds: AGENTS });
  assert.throws(() => agyToolPolicyDeny(pat), /pattern/);
});

test('headlessToolRefusal: another extension denying the tool refuses; the caller\'s own rules are exempt', async () => {
  const policy = await collect({ agent: 'claude', reason: 'headless-tool' }, {
    ext: loaded([
      ['slack', () => ({ rules: [{ tool: 'mcp__claude_ai_Slack__slack_send_message' }] })],
      ['other', () => ({ rules: [{ pattern: 'mcp__claude_ai_Gmail__.*' }] })],
    ]),
    required: [],
  });
  assert.equal(headlessToolRefusal(policy, 'mcp__claude_ai_Slack__slack_send_message', 'slack'), null);
  assert.match(headlessToolRefusal(policy, 'mcp__claude_ai_Slack__slack_send_message', 'mailer'), /slack's tool policy blocks/);
  assert.match(headlessToolRefusal(policy, 'mcp__claude_ai_Gmail__send', 'slack'), /other's tool policy blocks/);
  assert.equal(headlessToolRefusal(null, 'x', 'slack'), null);
});

test('requirements: recorded for every active extension with a policy, cleared only explicitly', () => {
  let cfg = {};
  const write = (patch) => { cfg = { ...cfg, ...patch }; return cfg; };
  const list = [
    { id: 'slack', enabled: true, quarantine: null, toolPolicy: true },
    { id: 'plain', enabled: true, quarantine: null, toolPolicy: false },
    { id: 'broken', enabled: false, quarantine: 'boom', toolPolicy: false },
  ];
  syncToolPolicyRequirements(list, { cfg, write, now: () => 1 });
  assert.deepEqual(toolPolicyRequirements(cfg), ['slack']);
  syncToolPolicyRequirements([{ id: 'slack', enabled: false, quarantine: 'boom', toolPolicy: false }], { cfg, write });
  assert.deepEqual(toolPolicyRequirements(cfg), ['slack'], 'a quarantined extension keeps its requirement');
  syncToolPolicyRequirements([], { cfg, write });
  assert.deepEqual(toolPolicyRequirements(cfg), ['slack'], 'a missing extension keeps its requirement');
  syncToolPolicyRequirements([{ id: 'slack', enabled: true, quarantine: null, toolPolicy: false }], { cfg, write });
  assert.deepEqual(toolPolicyRequirements(cfg), [], 'an active version that no longer declares one drops it');
  syncToolPolicyRequirements(list, { cfg, write });
  clearToolPolicyRequirement('slack', { cfg, write });
  assert.deepEqual(toolPolicyRequirements(cfg), []);
  assert.deepEqual(toolPolicyRequirements({ toolPolicyRequirements: 'junk' }), []);
});
