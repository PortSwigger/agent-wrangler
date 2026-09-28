// server/runtimes/devcontainer.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { rewriteHostUrls, containerInputPaths, launchInputs, buildPaneScript, devcontainer, stopContainer, hasDevcontainerConfig } from './devcontainer.js';

test('rewriteHostUrls: swaps loopback for the container-reachable host', () => {
  const inner = 'claude --mcp-config \'{"url":"http://127.0.0.1:8787/mcp"}\'';
  assert.equal(
    rewriteHostUrls(inner, 'host.docker.internal'),
    'claude --mcp-config \'{"url":"http://host.docker.internal:8787/mcp"}\'',
  );
});

test('rewriteHostUrls: defaults to host.docker.internal', () => {
  assert.match(rewriteHostUrls('x http://127.0.0.1:1/y'), /host\.docker\.internal:1/);
});

test('containerInputPaths: sessioned /tmp paths', () => {
  const p = containerInputPaths('abc');
  assert.equal(p.skillsDir, '/tmp/aw-abc/skills');
  assert.equal(p.notesDir, '/tmp/aw-abc/notes');
});

test('buildPaneScript: up → discover cid → mkdir → cp -L skills+notes → exec translated inner', () => {
  const s = buildPaneScript({
    inner: "claude --plugin-dir /host/skills --add-dir /host/notes --mcp-config 'http://127.0.0.1:9/mcp'",
    hostDir: '/Users/me/code/repo', sessionId: 'abc', hostAddr: 'host.docker.internal',
  });
  assert.match(s, /devcontainer up --workspace-folder '\/Users\/me\/code\/repo'/);
  assert.match(s, /docker ps -q --filter label=devcontainer\.local_folder='\/Users\/me\/code\/repo'/);
  assert.match(s, /docker exec "\$CID" mkdir -p '\/tmp\/aw-abc'/);
  assert.match(s, /docker cp -L .*:'\/tmp\/aw-abc\/skills'/);
  assert.match(s, /docker cp -L .*:'\/tmp\/aw-abc\/notes'/);
  assert.match(s, /devcontainer exec --workspace-folder '\/Users\/me\/code\/repo' sh -lc/);
  assert.match(s, /host\.docker\.internal:9/);        // url rewritten
});

test('buildPaneScript: substitutes each manifest src → its container dest; skips substitute:false', () => {
  const inputs = [
    { src: '/host/skills', dest: '/tmp/aw-abc/skills' },
    { src: '/host/notes', dest: '/tmp/aw-abc/notes' },
    { src: '/host/scripts/pr-attach-hook.mjs', dest: '/tmp/aw-abc/scripts/pr-attach-hook.mjs', chmodX: true },
    { src: '/host/server/pr-hook.js', dest: '/tmp/aw-abc/server/pr-hook.js', substitute: false },
  ];
  const inner = "claude --plugin-dir /host/skills --add-dir /host/notes --settings '{\"command\":\"/host/scripts/pr-attach-hook.mjs\"}'";
  const s = buildPaneScript({ inner, hostDir: '/repo', sessionId: 'abc', inputs });
  assert.match(s, /--plugin-dir \/tmp\/aw-abc\/skills/);
  assert.match(s, /--add-dir \/tmp\/aw-abc\/notes/);
  assert.match(s, /\/tmp\/aw-abc\/scripts\/pr-attach-hook\.mjs/);   // hook path translated in --settings
  assert.doesNotMatch(s, /"command":"\/host\/scripts/);   // the --settings command path was translated, not left host
  assert.doesNotMatch(s, /--plugin-dir \/host\/skills/);   // translated to the container path
  assert.doesNotMatch(s, /--add-dir \/host\/notes/);
  // one docker cp -L per input
  assert.match(s, /docker cp -L '\/host\/skills' "\$CID":'\/tmp\/aw-abc\/skills'/);
  assert.match(s, /docker cp -L '\/host\/server\/pr-hook\.js' "\$CID":'\/tmp\/aw-abc\/server\/pr-hook\.js'/);
  // parents mkdir'd (unique dirnames), chmod +x only the hook
  assert.match(s, /mkdir -p '\/tmp\/aw-abc' '\/tmp\/aw-abc\/scripts' '\/tmp\/aw-abc\/server'/);
  assert.match(s, /docker exec -u root "\$CID" chmod \+x '\/tmp\/aw-abc\/scripts\/pr-attach-hook\.mjs'/);
});

test('launchInputs: base = skills + notes + PR-hook (2 files); workflow adds issue-to-pr', () => {
  const base = launchInputs('abc');
  const dests = base.map((i) => i.dest);
  assert.deepEqual(dests, [
    '/tmp/aw-abc/skills', '/tmp/aw-abc/notes',
    '/tmp/aw-abc/scripts/pr-attach-hook.mjs', '/tmp/aw-abc/server/pr-hook.js',
  ]);
  // the parser dep is copied but its path is NOT substituted into the command
  assert.equal(base.find((i) => i.dest.endsWith('/server/pr-hook.js')).substitute, false);
  assert.equal(base.find((i) => i.dest.endsWith('/pr-attach-hook.mjs')).chmodX, true);
  const wf = launchInputs('abc', { workflow: true });
  assert.ok(wf.some((i) => i.dest === '/tmp/aw-abc/issue-to-pr'), 'workflow adds issue-to-pr');
  assert.ok(!base.some((i) => i.dest === '/tmp/aw-abc/issue-to-pr'), 'non-workflow omits it');
});

test('wrapLaunch: workflow:true copies the issue-to-pr skill dir into the container', async () => {
  const s = await devcontainer.wrapLaunch({
    inner: "claude --mcp-config 'http://127.0.0.1:9/mcp'", cwd: '/repo', sessionId: 'z', workflow: true,
  });
  assert.match(s, /docker cp -L .* "\$CID":'\/tmp\/aw-z\/issue-to-pr'/);
});

test('wrapLaunch: returns the pane script (async, no injected deps needed)', async () => {
  const s = await devcontainer.wrapLaunch({
    inner: "claude --mcp-config 'http://127.0.0.1:9/mcp'", cwd: '/repo', sessionId: 'z',
  });
  assert.match(s, /devcontainer up --workspace-folder '\/repo'/);
});

// Modelled on transcript-reader.test.js's usage-line fixture: a user line + one
// assistant line carrying message.usage, so analyzeLines resolves a real usd.
const SAMPLE_TWO_LINES = [
  JSON.stringify({ type: 'user', message: { role: 'user', content: 'fix the widget' }, timestamp: '2026-01-01T00:00:00.000Z' }),
  JSON.stringify({
    type: 'assistant',
    message: {
      id: 'msg_1',
      role: 'assistant',
      model: 'claude-sonnet-4',
      usage: { input_tokens: 1200, output_tokens: 340, cache_read_input_tokens: 50, cache_creation_input_tokens: 20 },
      content: [{ type: 'text', text: 'Fixed it.' }],
    },
    timestamp: '2026-01-01T00:00:01.000Z',
  }),
].join('\n');

test('devcontainer.analyze: cat the jsonl out of the container and parse it', async () => {
  const calls = [];
  const run = async (cmd, args) => {
    calls.push([cmd, args]);
    if (cmd === 'docker' && args[0] === 'ps') return { stdout: 'cid1\n' };
    if (cmd === 'docker' && args[0] === 'exec') return { stdout: SAMPLE_TWO_LINES };
    throw new Error('unexpected: ' + [cmd, ...args].join(' '));
  };
  const enr = await devcontainer.analyze({ entry: { cwd: '/repo' }, liveSid: 'L1' }, { run });
  assert.ok(enr && typeof enr.usd === 'number');
  const execCall = calls.find(([cmd, args]) => cmd === 'docker' && args[0] === 'exec');
  const execCmd = execCall[1][execCall[1].length - 1];
  assert.match(execCmd, /\/home\/\*\/\.claude\/projects/);
  assert.match(execCmd, /\/root\/\.claude\/projects/);
  assert.doesNotMatch(execCmd, /~\/\.claude/);
  // An unmatched glob leaves `cat` a literal arg it can't open, exiting non-zero
  // even when the OTHER path matched — promisify(execFile) rejects on any
  // non-zero exit regardless of stdout, so `|| true` must force exit 0.
  assert.match(execCmd, /\|\| true$/);
});

test('devcontainer.analyze: returns null when the container is gone', async () => {
  const run = async () => ({ stdout: '' }); // no cid
  assert.equal(await devcontainer.analyze({ entry: { cwd: '/repo' }, liveSid: 'L1' }, { run }), null);
});

test('devcontainer.readLive: selects the blob matching liveSessionId (pid-independent)', async () => {
  const blobs = [
    JSON.stringify({ sessionId: 'other', status: 'idle' }),
    JSON.stringify({ sessionId: 'L1', status: 'busy', name: 'x', updatedAt: 5 }),
  ].join('\n');
  const calls = [];
  const run = async (cmd, args) => {
    calls.push([cmd, args]);
    if (args[0] === 'ps') return { stdout: 'cid1\n' };
    return { stdout: blobs };
  };
  const live = await devcontainer.readLive({ entry: { cwd: '/repo', liveSessionId: 'L1' } }, { run });
  assert.equal(live.liveSid, 'L1');
  assert.equal(live.status, 'working');      // 'busy' → working (statusOf)
  const execCall = calls.find(([cmd, args]) => cmd === 'docker' && args[0] === 'exec');
  const execCmd = execCall[1][execCall[1].length - 1];
  assert.match(execCmd, /\/home\/\*\/\.claude\/sessions/);
  assert.match(execCmd, /\/root\/\.claude\/sessions/);
  assert.doesNotMatch(execCmd, /~\/\.claude/);
  // Same unmatched-glob exit-code tolerance as analyze's cat — see its comment.
  assert.match(execCmd, /\|\| true$/);
});

test('devcontainer.readLive: null when no session file matches (→ pane scrape)', async () => {
  const run = async (cmd, args) => ({ stdout: args[0] === 'ps' ? 'cid1\n' : '{"sessionId":"z"}' });
  assert.equal(await devcontainer.readLive({ entry: { cwd: '/repo', liveSessionId: 'L1' } }, { run }), null);
});

test('stopContainer: resolves the cid by workspace label, then `docker stop`s that one container', async () => {
  const calls = [];
  const run = async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (args[0] === 'ps') return { stdout: 'cid1\n' };
    return { stdout: '' };
  };
  const cid = await stopContainer('/Users/me/code/repo', { run });
  assert.equal(cid, 'cid1');
  // Discovered via the same devcontainer.local_folder label containerIdFor uses.
  const psCall = calls.find(([cmd, sub]) => cmd === 'docker' && sub === 'ps');
  assert.ok(psCall.includes('label=devcontainer.local_folder=/Users/me/code/repo'));
  // Stops exactly that one container — never a `compose down` of the whole project.
  assert.deepEqual(calls.find(([cmd, sub]) => cmd === 'docker' && sub === 'stop'), ['docker', 'stop', 'cid1']);
  assert.ok(!calls.some(([, sub]) => sub === 'compose'), 'must not compose down the project');
});

test('stopContainer: no-op (null) when no container is running for the dir', async () => {
  const calls = [];
  const run = async (cmd, args) => { calls.push(args[0]); return { stdout: '' }; };
  assert.equal(await stopContainer('/repo', { run }), null);
  assert.ok(!calls.includes('stop'), 'never issues docker stop when there is no cid');
});

test('stopContainer: null-degrades when docker errors (never breaks the archive it rides)', async () => {
  const run = async (cmd, args) => {
    if (args[0] === 'ps') return { stdout: 'cid1\n' };
    throw new Error('docker daemon not running');
  };
  assert.equal(await stopContainer('/repo', { run }), null);
});

test('hasDevcontainerConfig: true for .devcontainer/devcontainer.json or a top-level .devcontainer.json', () => {
  const none = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-dc-cfg-none-'));
  assert.equal(hasDevcontainerConfig(none), false);
  const nested = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-dc-cfg-nested-'));
  fs.mkdirSync(path.join(nested, '.devcontainer'));
  fs.writeFileSync(path.join(nested, '.devcontainer', 'devcontainer.json'), '{}');
  assert.equal(hasDevcontainerConfig(nested), true);
  const flat = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-dc-cfg-flat-'));
  fs.writeFileSync(path.join(flat, '.devcontainer.json'), '{}');
  assert.equal(hasDevcontainerConfig(flat), true);
});

test('devcontainer.preflight: refuses no-config and blank cwd, passes when a config is present', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-dc-pf-'));
  assert.match(await devcontainer.preflight({ cwd: dir }), /No devcontainer config/);
  assert.match(await devcontainer.preflight({ cwd: '' }), /blank or scratch/);
  assert.match(await devcontainer.preflight({}), /blank or scratch/);
  fs.mkdirSync(path.join(dir, '.devcontainer'));
  fs.writeFileSync(path.join(dir, '.devcontainer', 'devcontainer.json'), '{}');
  assert.equal(await devcontainer.preflight({ cwd: dir }), null);
});
