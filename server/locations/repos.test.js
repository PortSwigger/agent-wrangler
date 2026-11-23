import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkLocationBranch, findUnpushed, unpushedText, renameLocationBranchText, MAX_UNPUSHED_COMMITS } from './repos.js';

test('a remote branch can be specified without a repository', () => {
  assert.deepEqual(checkLocationBranch({ branch: 'fix', base: 'main' }), { branch: 'fix', branchBase: 'main' });
  assert.throws(() => checkLocationBranch({ base: 'main' }), /base needs a branch/);
  assert.match(renameLocationBranchText('old', 'new'), /git branch -m old new/);
});

test('unpushed answers are capped and cleaned; a card on this machine or a runtime without the hook is not asked', async () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ sha: `abcdef${String(i).padStart(2, '0')}`, subject: `s${i}\nsecond line` }));
  const rt = { id: 'r', location: { unpushed: async () => [{ repo: 'acme/widgets', commits: [...many, { sha: 'not hex' }] }, null, { repo: 'x' }] } };
  const entries = { a: { runtime: 'r', location: { box: 1 } }, b: { runtime: 'r', location: { box: 1 } }, h: { cwd: '/x' } };
  const found = await findUnpushed(['a', 'b', 'h'], { entryFor: (id) => entries[id], runtimeOf: () => rt });
  assert.equal(found.length, 1, 'cards sharing a location are asked once');
  assert.equal(found[0].repos.length, 1);
  assert.equal(found[0].repos[0].commits.length, MAX_UNPUSHED_COMMITS);
  assert.equal(found[0].repos[0].commits[0].subject, 's0 second line');
  assert.match(unpushedText(found), /acme\/widgets: 20 commits on no remote branch/);
  const none = await findUnpushed(['a'], { entryFor: (id) => entries[id], runtimeOf: () => ({ location: {} }) });
  assert.deepEqual(none, []);
  const gone = await findUnpushed(['a'], { entryFor: (id) => entries[id], runtimeOf: () => null });
  assert.match(gone[0].repos[0].error, /runtime is not available/);
});
