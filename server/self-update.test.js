import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkForUpdate, applyUpdate, blockedReason, readCodeVersion } from './self-update.js';

function fakeGit({ branch = 'main', status = '', counts = '0\t2', log = 'aaa1111\tFirst\nbbb2222\tSecond: with\ttab', head = 'h0', fail = {} } = {}) {
  const calls = [];
  let current = head;
  const git = async (args) => {
    calls.push(args.join(' '));
    const [cmd] = args;
    if (fail[cmd]) throw new Error(fail[cmd]);
    if (cmd === 'fetch') return { stdout: '' };
    if (cmd === 'status') return { stdout: status };
    if (cmd === 'rev-list') return { stdout: counts };
    if (cmd === 'log') return { stdout: log };
    if (cmd === 'merge') { current = 'h1'; return { stdout: '' }; }
    if (cmd === 'rev-parse') {
      if (args[1] === '--abbrev-ref') return { stdout: `${branch}\n` };
      if (args[1] === 'HEAD') return { stdout: `${current}\n` };
      return { stdout: 'r1\n' };
    }
    throw new Error(`unexpected git ${args.join(' ')}`);
  };
  return { git, calls };
}

test('a check fetches main and lists the commits it is behind', async () => {
  const { git, calls } = fakeGit();
  const status = await checkForUpdate({ git });
  assert.equal(calls[0], 'fetch --quiet origin main');
  assert.equal(status.behind, 2);
  assert.equal(status.head, 'h0');
  assert.equal(status.remote, 'r1');
  assert.equal(status.blocked, null);
  assert.deepEqual(status.commits, [{ sha: 'aaa1111', subject: 'First' }, { sha: 'bbb2222', subject: 'Second: with\ttab' }]);
});

test('an up-to-date checkout lists no commits', async () => {
  const { git, calls } = fakeGit({ counts: '0\t0' });
  const status = await checkForUpdate({ git });
  assert.equal(status.behind, 0);
  assert.deepEqual(status.commits, []);
  assert.ok(!calls.some((c) => c.startsWith('log')));
});

test('an update is blocked off main, with local changes, or with local commits', () => {
  assert.match(blockedReason({ branch: 'feature', dirty: false, ahead: 0 }), /on "feature"/);
  assert.match(blockedReason({ branch: 'main', dirty: true, ahead: 0 }), /uncommitted changes/);
  assert.match(blockedReason({ branch: 'main', dirty: false, ahead: 1 }), /1 local commit not/);
  assert.equal(blockedReason({ branch: 'main', dirty: false, ahead: 0 }), null);
});

test('apply fast-forwards and reports the new head', async () => {
  const { git, calls } = fakeGit();
  const result = await applyUpdate({ git });
  assert.ok(calls.includes('merge --ff-only --quiet origin/main'));
  assert.equal(result.updated, true);
  assert.equal(result.head, 'h1');
});

test('apply refuses a blocked checkout without merging', async () => {
  const { git, calls } = fakeGit({ status: ' M server/index.js' });
  await assert.rejects(() => applyUpdate({ git }), /uncommitted changes/);
  assert.ok(!calls.some((c) => c.startsWith('merge')));
});

test('apply with nothing new does not merge', async () => {
  const { git, calls } = fakeGit({ counts: '0\t0' });
  const result = await applyUpdate({ git });
  assert.equal(result.updated, false);
  assert.ok(!calls.some((c) => c.startsWith('merge')));
});

test('the code version is null outside a git checkout', async () => {
  const { git } = fakeGit({ fail: { 'rev-parse': 'not a git repository' } });
  assert.equal(await readCodeVersion({ git }), null);
  assert.equal(await readCodeVersion({ git: fakeGit().git }), 'h0');
});
