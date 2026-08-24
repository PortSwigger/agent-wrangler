import { test } from 'node:test';
import assert from 'node:assert/strict';
import { codex } from './codex.js';
import { adapterForContainerProcess } from './index.js';

const memory = { memoryDir: '/memory/tasks/T1', memoryPath: '/memory/tasks/T1/memory.md' };
const base = { sessionId: 'BID', model: 'gpt-5.5-codex', ...memory };

// NOTE: every arg is shell-quoted via shellQuote(), so flags AND the
// resume/fork subcommands appear quoted, e.g. `'-m' 'gpt-5.5-codex'` and
// `codex 'resume' 'ROLL-UUID'`. Env assignments quote only the value
// (`AW_SESSION_ID='BID'`) and the `codex` binary name is unquoted. Codex receives
// the resolved real task directory because 0.149+ rejects symlinked writable roots.

test('codex buildLaunch: sandbox, network, memory, env, prompt', () => {
  // taskMemory pinned so the nudge/catalog assertions don't depend on the live
  // config.json (the disabled path is covered in agent-skills.test.js).
  const cmd = codex.buildLaunch({ ...base, intent: 'fix the bug', addDirs: [], taskMemory: true });
  assert.match(cmd, /^AW_SESSION_ID='BID'/);
  assert.match(cmd, /AW_TASK_MEMORY='\/memory\/tasks\/T1\/memory.md'/);
  assert.match(cmd, /(^|\s)codex /);
  assert.match(cmd, /'-m' 'gpt-5\.5-codex'/);
  assert.match(cmd, /'--sandbox' 'workspace-write'/);
  assert.match(cmd, /'--ask-for-approval' 'never'/);
  assert.match(cmd, /'sandbox_workspace_write\.network_access=true'/);
  assert.match(cmd, /Before your first action this session, read the file at AW_TASK_MEMORY/);
  assert.match(cmd, /You have wrangler-meta skills available/);
  assert.match(cmd, /- task-memory — /);
  assert.match(cmd, /- links — /);
  assert.match(cmd, /- spawn-session — /);
  assert.doesNotMatch(cmd, /This session has shared task memory/);
  assert.match(cmd, /'--add-dir' '\/memory\/tasks\/T1'/);
  assert.doesNotMatch(cmd, /by-session\/BID/);
  assert.match(cmd, /'fix the bug'$/);
});

// Directory trust is no longer a `-c` override here: verified against the real
// binary that Codex's interactive trust dialog ignores that override entirely,
// whichever path it's keyed on. Trust is instead persisted to config.toml
// before launch by ensureCodexTrust (codex-trust.js), called by the session
// manager — this adapter must never re-introduce the dead `-c` flag.
test('codex never emits a trust_level override (that mechanism does not work; see codex-trust.js)', () => {
  const launch = codex.buildLaunch({ ...base, intent: '' });
  const resume = codex.buildResume({ sessionId: 'BID', resumeId: 'ROLL-UUID', ...memory });
  const fork = codex.buildFork({ sessionId: 'BID', sourceId: 'ROLL-UUID', ...memory });
  for (const cmd of [launch, resume, fork]) {
    assert.doesNotMatch(cmd, /trust_level/);
  }
});

test('codex buildLaunch: no env-strip wrapper, no empty trailing prompt', () => {
  const cmd = codex.buildLaunch({ ...base, intent: '', addDirs: [] });
  assert.doesNotMatch(cmd, /env -u CLAUDECODE/);
  assert.doesNotMatch(cmd, /'' *$/);
});

test('codex buildLaunch: extra addDirs each get --add-dir', () => {
  const cmd = codex.buildLaunch({ ...base, intent: '', addDirs: ['/a', '/b'] });
  assert.match(cmd, /'--add-dir' '\/a'/);
  assert.match(cmd, /'--add-dir' '\/b'/);
});

test('codex buildResume: resume id, flags re-applied, no prompt', () => {
  const cmd = codex.buildResume({ sessionId: 'BID', resumeId: 'ROLL-UUID', ...memory });
  assert.match(cmd, /codex 'resume' 'ROLL-UUID'/);
  assert.match(cmd, /'--sandbox' 'workspace-write'/);
  assert.match(cmd, /'--add-dir' '\/memory\/tasks\/T1'/);
  assert.match(cmd, /AW_SESSION_ID='BID'/);
});

test('codex buildFork: forks source into new board identity, prompt trails', () => {
  const cmd = codex.buildFork({ sessionId: 'NEWBID', sourceId: 'SRC', model: 'gpt-5.5-codex', intent: 'branch', ...memory });
  assert.match(cmd, /codex 'fork' 'SRC'/);
  assert.match(cmd, /AW_SESSION_ID='NEWBID'/);
  assert.match(cmd, /'branch'$/);
});

test('worktree guardrail is folded into developer_instructions only when launched in a worktree', () => {
  const plain = codex.buildLaunch({ ...base, intent: '', addDirs: [] });
  const wt = codex.buildLaunch({ ...base, intent: '', addDirs: [], worktree: { path: '/v/proj-worktree-x', branch: 'x' } });
  assert.doesNotMatch(plain, /already running inside a dedicated git worktree/);
  assert.match(wt, /already running inside a dedicated git worktree/);
});

test('developer_instructions carries the mandatory-skill nudge and the skills catalog as a TOML string', () => {
  const cmd = codex.buildLaunch({ ...base, intent: '', addDirs: [], taskMemory: true });
  assert.match(cmd, /Before your first action this session, read the file at AW_TASK_MEMORY/);
  assert.match(cmd, /You have wrangler-meta skills available/);
});

test('codex resume and fork also carry the nudge + skills catalog in developer_instructions', () => {
  const resume = codex.buildResume({ sessionId: 'BID', resumeId: 'ROLL-UUID', taskMemory: true, ...memory });
  const fork = codex.buildFork({ sessionId: 'BID', sourceId: 'ROLL-UUID', model: 'gpt-5.5', taskMemory: true, ...memory });
  for (const cmd of [resume, fork]) {
    assert.match(cmd, /Before your first action this session, read the file at AW_TASK_MEMORY/);
    assert.match(cmd, /You have wrangler-meta skills available/);
  }
});

test('codex does not grant a writable --add-dir for the skills dir', () => {
  const cmd = codex.buildLaunch({ ...base, intent: '', addDirs: [] });
  assert.doesNotMatch(cmd, /--add-dir' '[^']*agent-skills/);
});

test('codex launch injects the wrangler MCP server + bearer-token env keyed on the card id', () => {
  const cmd = codex.buildLaunch({ sessionId: 'BID', intent: '' });
  // Card id is exported to the bearer-token env var the MCP config reads.
  assert.match(cmd, /AW_MCP_TOKEN='BID'/);
  assert.match(cmd, /mcp_servers\.agent-wrangler\.url=/);
  assert.match(cmd, /mcp_servers\.agent-wrangler\.bearer_token_env_var=/);
  assert.match(cmd, /mcp_servers\.agent-wrangler\.default_tools_approval_mode="approve"/);
});

test('matchContainerized: a devcontainer/docker exec wrapping codex matches; a plain host codex does not', () => {
  const dc = "node /x/node_modules/.bin/devcontainer exec --workspace-folder /r sh -lc env codex '-m' 'gpt-5.5'";
  const dk = "docker exec -i -t -u node CID sh -lc env codex 'resume' 'ROLL-UUID'";
  assert.equal(adapterForContainerProcess(dc)?.id, 'codex');
  assert.equal(adapterForContainerProcess(dk)?.id, 'codex');
  assert.equal(adapterForContainerProcess('/usr/bin/codex resume x'), null); // plain host = not containerized
  assert.equal(adapterForContainerProcess('docker exec CID /bin/sh'), null); // wrapper but no agent
});

test('codex exposes an efforts list with expected levels and no default', () => {
  const values = codex.efforts.map((e) => e.value);
  assert.deepEqual(values, ['minimal', 'low', 'medium', 'high']);
  assert.ok(!codex.efforts.some((e) => e.default));
});

test('codex threads model_reasoning_effort into launch/resume/fork only when set', () => {
  const launch = codex.buildLaunch({ ...base, effort: 'high' });
  const resume = codex.buildResume({ sessionId: 'BID', resumeId: 'ROLL', effort: 'medium' });
  const fork = codex.buildFork({ sessionId: 'BID', sourceId: 'ROLL', effort: 'low' });
  assert.match(launch, /'model_reasoning_effort=high'/);
  assert.match(resume, /'model_reasoning_effort=medium'/);
  assert.match(fork, /'model_reasoning_effort=low'/);
});

test('codex omits model_reasoning_effort when no effort is given', () => {
  assert.doesNotMatch(codex.buildLaunch({ ...base }), /model_reasoning_effort/);
  assert.doesNotMatch(codex.buildResume({ sessionId: 'BID', resumeId: 'ROLL' }), /model_reasoning_effort/);
  assert.doesNotMatch(codex.buildFork({ sessionId: 'BID', sourceId: 'ROLL' }), /model_reasoning_effort/);
});
