import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cloudPreflight } from './cloud-preflight.js';

// A fake promisified execFile. `out` maps a git subcommand (the argv joined after
// the `-C <cwd>` pair) to stdout, or to an Error to simulate git exiting non-zero
// — which is how "no upstream" and "no origin remote" actually present.
function fakeRun(out = {}, calls = []) {
  return async (bin, args) => {
    assert.equal(bin, 'git');
    assert.equal(args[0], '-C');
    const key = args.slice(2).join(' ');
    calls.push(key);
    const v = out[key];
    if (v instanceof Error) throw v;
    if (v === undefined) throw new Error(`unexpected git probe: ${key}`);
    return { stdout: v, stderr: '' };
  };
}

// A clean, pushed, GitHub-remote repo — the baseline every case perturbs.
const CLEAN = {
  'remote get-url origin': 'git@github.com:acme/widgets.git\n',
  'rev-list --count @{u}..HEAD': '0\n',
  'status --porcelain': '',
};

const repoRoot = async () => '/repo';

function pf(over = {}) {
  return cloudPreflight({
    cwd: '/repo',
    env: {},
    run: fakeRun(CLEAN),
    repoRoot,
    ...over,
  });
}

const codes = (list) => list.map((r) => r.code);

test('cloudPreflight: a clean pushed GitHub repo has no refusals and no warnings', async () => {
  const r = await pf();
  assert.deepEqual(r.refusals, []);
  assert.deepEqual(r.warnings, []);
});

test('cloudPreflight: codex is refused, and refused FIRST so it is what a caller shows', async () => {
  const r = await pf({ agent: 'codex', cwd: '/not-a-repo', repoRoot: async () => null });
  assert.deepEqual(codes(r.refusals), ['cloud-codex', 'cloud-not-git']);
  assert.match(r.refusals[0].message, /Claude-only/);
});

test('cloudPreflight: a workflow launch is refused (the skill rides --plugin-dir)', async () => {
  const r = await pf({ workflow: true });
  assert.deepEqual(codes(r.refusals), ['cloud-workflow']);
  assert.match(r.refusals[0].message, /--plugin-dir/);
});

for (const v of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX']) {
  test(`cloudPreflight: ${v} in the launch env is refused`, async () => {
    const r = await pf({ env: { [v]: '1' } });
    assert.deepEqual(codes(r.refusals), ['cloud-auth']);
    assert.match(r.refusals[0].message, new RegExp(v));
  });
}

test('cloudPreflight: two auth vars at once still yield exactly one auth refusal', async () => {
  const r = await pf({ env: { ANTHROPIC_API_KEY: 'sk-x', CLAUDE_CODE_USE_VERTEX: '1' } });
  assert.deepEqual(codes(r.refusals), ['cloud-auth']);
});

test('cloudPreflight: an emptied/zeroed auth var reads as absent, not as set', async () => {
  const r = await pf({ env: { ANTHROPIC_API_KEY: '', CLAUDE_CODE_USE_BEDROCK: '0', CLAUDE_CODE_USE_VERTEX: 'false' } });
  assert.deepEqual(r.refusals, []);
});

test('cloudPreflight: a malformed environmentId is refused; env_/ccpool_/empty are not', async () => {
  const bad = await pf({ environmentId: 'prod' });
  assert.deepEqual(codes(bad.refusals), ['cloud-bad-environment']);
  assert.match(bad.refusals[0].message, /env_/);
  for (const id of ['env_abc123', 'ccpool_abc123', '', '  ']) {
    const r = await pf({ environmentId: id });
    assert.deepEqual(r.refusals, [], `expected ${JSON.stringify(id)} to be accepted`);
  }
});

test('cloudPreflight: a non-repo cwd is refused and no git probe is attempted', async () => {
  const calls = [];
  const r = await pf({ repoRoot: async () => null, run: fakeRun({}, calls) });
  assert.deepEqual(codes(r.refusals), ['cloud-not-git']);
  assert.deepEqual(r.warnings, []);
  assert.deepEqual(calls, []);
});

test('cloudPreflight: an empty cwd is refused without even asking for a repo root', async () => {
  let asked = 0;
  const r = await cloudPreflight({ cwd: '', env: {}, run: fakeRun({}), repoRoot: async () => { asked += 1; return '/repo'; } });
  assert.deepEqual(codes(r.refusals), ['cloud-not-git']);
  assert.equal(asked, 0);
  assert.match(r.refusals[0].message, /No folder selected/);
});

test('cloudPreflight: a repo with no origin remote is refused', async () => {
  const r = await pf({ run: fakeRun({ ...CLEAN, 'remote get-url origin': new Error('no such remote') }) });
  assert.deepEqual(codes(r.refusals), ['cloud-no-origin']);
});

test('cloudPreflight: a non-GitHub origin is refused as firmly as none', async () => {
  const r = await pf({ run: fakeRun({ ...CLEAN, 'remote get-url origin': 'git@gitlab.com:acme/widgets.git\n' }) });
  assert.deepEqual(codes(r.refusals), ['cloud-no-origin']);
  assert.match(r.refusals[0].message, /gitlab\.com/);
});

test('cloudPreflight: an https GitHub origin is accepted', async () => {
  const r = await pf({ run: fakeRun({ ...CLEAN, 'remote get-url origin': 'https://github.com/acme/widgets.git\n' }) });
  assert.deepEqual(r.refusals, []);
});

test('cloudPreflight: unpushed commits warn, with the count in the message', async () => {
  const r = await pf({ run: fakeRun({ ...CLEAN, 'rev-list --count @{u}..HEAD': '3\n' }) });
  assert.deepEqual(r.refusals, []);
  assert.deepEqual(codes(r.warnings), ['cloud-unpushed']);
  assert.match(r.warnings[0].message, /3 commits/);
});

test('cloudPreflight: a branch with no upstream does NOT warn about unpushed commits', async () => {
  const r = await pf({ run: fakeRun({ ...CLEAN, 'rev-list --count @{u}..HEAD': new Error('no upstream configured') }) });
  assert.deepEqual(r.warnings, []);
});

test('cloudPreflight: a dirty working tree warns (the VM only sees the pushed ref)', async () => {
  const r = await pf({ run: fakeRun({ ...CLEAN, 'status --porcelain': ' M server/index.js\n?? scratch.txt\n' }) });
  assert.deepEqual(r.refusals, []);
  assert.deepEqual(codes(r.warnings), ['cloud-dirty']);
});

test('cloudPreflight: unpushed and dirty stack as two independent warnings', async () => {
  const r = await pf({
    run: fakeRun({
      ...CLEAN,
      'rev-list --count @{u}..HEAD': '1\n',
      'status --porcelain': ' M a.js\n',
    }),
  });
  assert.deepEqual(codes(r.warnings), ['cloud-unpushed', 'cloud-dirty']);
  assert.match(r.warnings[0].message, /1 commit /);
});

test('cloudPreflight: refusals and warnings coexist — a warning never hides a refusal', async () => {
  const r = await pf({ workflow: true, run: fakeRun({ ...CLEAN, 'status --porcelain': ' M a.js\n' }) });
  assert.deepEqual(codes(r.refusals), ['cloud-workflow']);
  assert.deepEqual(codes(r.warnings), ['cloud-dirty']);
});

test('cloudPreflight: env/flag refusals precede git ones in a fully-broken case', async () => {
  const r = await pf({
    agent: 'codex',
    workflow: true,
    environmentId: 'nope',
    env: { ANTHROPIC_API_KEY: 'sk-x' },
    run: fakeRun({ ...CLEAN, 'remote get-url origin': new Error('no such remote') }),
  });
  assert.deepEqual(codes(r.refusals), [
    'cloud-codex', 'cloud-workflow', 'cloud-auth', 'cloud-bad-environment', 'cloud-no-origin',
  ]);
});

test('cloudPreflight: every refusal and warning carries a human message', async () => {
  const r = await pf({
    agent: 'codex',
    workflow: true,
    environmentId: 'nope',
    env: { ANTHROPIC_API_KEY: 'sk-x' },
    run: fakeRun({ ...CLEAN, 'rev-list --count @{u}..HEAD': '2\n', 'status --porcelain': ' M a.js\n' }),
  });
  for (const item of [...r.refusals, ...r.warnings]) {
    assert.equal(typeof item.code, 'string');
    assert.ok(item.code.length > 0);
    assert.ok(item.message.length > 20, `too terse: ${item.message}`);
  }
});

test('cloudPreflight: `ref` is accepted and never probed against git', async () => {
  const calls = [];
  const r = await pf({ ref: 'feature/x', run: fakeRun(CLEAN, calls) });
  assert.deepEqual(r.refusals, []);
  assert.ok(!calls.some((c) => c.includes('feature/x')));
});
