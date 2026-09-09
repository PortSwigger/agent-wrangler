import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { nameBranchTool } from './name-branch.js';

function deps(captured, impl, { automated = false, jobStore = true } = {}) {
  return {
    sessionManager: {
      entryFor: () => (automated ? { automationRun: { jobId: 'job1' } } : {}),
      renameWorktreeBranch: async (sid, name, opts) => {
        captured.call = { sid, name, ...opts };
        if (impl) return impl(sid, name);
        return name;
      },
    },
    ...(jobStore ? { jobStore: { noteBranchRename: (sid, branch) => { captured.noted = { sid, branch }; return true; } } } : {}),
    rebuild: async () => { captured.rebuilt = (captured.rebuilt || 0) + 1; },
  };
}

test('name_branch renames under the caller card id and rebuilds; an autopilot run is slugged and the job store is not told', async () => {
  const captured = {};
  const out = await nameBranchTool.handler({ deps: deps(captured), caller: 'CARD1' }, { name: 'improve-branch-names' });
  assert.deepEqual(captured.call, { sid: 'CARD1', name: 'improve-branch-names', verbatim: false });
  assert.equal(captured.rebuilt, 1);
  assert.equal(captured.noted, undefined);
  assert.deepEqual(out.structuredContent, { branch: 'improve-branch-names' });
});

test('name_branch for a job session keeps the convention-shaped name verbatim and moves the sub-job\'s worktree record with it', async () => {
  const captured = {};
  const out = await nameBranchTool.handler({ deps: deps(captured, () => 'fix/AUTH-123-reliable-sign-in-2', { automated: true }), caller: 'CARD1' }, { name: 'fix/AUTH-123-reliable-sign-in' });
  assert.deepEqual(captured.call, { sid: 'CARD1', name: 'fix/AUTH-123-reliable-sign-in', verbatim: true });
  assert.deepEqual(captured.noted, { sid: 'CARD1', branch: 'fix/AUTH-123-reliable-sign-in-2' }, 'the store learns the FINAL name, suffix included');
  assert.deepEqual(out.structuredContent, { branch: 'fix/AUTH-123-reliable-sign-in-2' });
  const bare = {};
  await nameBranchTool.handler({ deps: deps(bare, null, { automated: true, jobStore: false }), caller: 'CARD1' }, { name: 'AUTH-1-x' });
  assert.equal(bare.call.verbatim, true, 'a deps set without a job store still renames');
});

test('name_branch echoes the final (possibly suffixed) branch the manager returns', async () => {
  const captured = {};
  const out = await nameBranchTool.handler({ deps: deps(captured, () => 'taken-2'), caller: 'CARD1' }, { name: 'taken' });
  assert.deepEqual(out.structuredContent, { branch: 'taken-2' });
});

test('name_branch errors (no rename, no rebuild) when the request carries no caller', async () => {
  const captured = {};
  const out = await nameBranchTool.handler({ deps: deps(captured), caller: null }, { name: 'x' });
  assert.equal(out.isError, true);
  assert.equal(captured.call, undefined);
  assert.equal(captured.rebuilt, undefined);
});

test('name_branch surfaces a manager error (e.g. no worktree) as a tool error, not a throw', async () => {
  const captured = {};
  const failing = deps(captured, () => { throw new Error('This session has no wrangler-created worktree, so there is no branch to rename.'); });
  const out = await nameBranchTool.handler({ deps: failing, caller: 'CARD1' }, { name: 'x' });
  assert.equal(out.isError, true);
  assert.match(out.content[0].text, /no wrangler-created worktree/);
  assert.equal(captured.rebuilt, undefined);
});

test('name_branch inputSchema: name required and non-empty', () => {
  const schema = z.object(nameBranchTool.inputSchema);
  assert.equal(schema.safeParse({ name: 'fix-thing' }).success, true);
  assert.equal(schema.safeParse({ name: '' }).success, false);
  assert.equal(schema.safeParse({}).success, false);
});
