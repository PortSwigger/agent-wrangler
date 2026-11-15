import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normaliseRepos, childRepos, prLinkRefusal, prRepoOf, reposBrief, checkLocationBranch, findUnpushed, unpushedText, renameLocationBranchText, MAX_UNPUSHED_COMMITS } from './repos.js';

test('repos normalise to owner/name, drop repeats, and refuse anything else', () => {
  assert.deepEqual(normaliseRepos([' acme/widgets', 'https://github.com/acme/gadgets.git', 'git@github.com:acme/x', 'ACME/Widgets']), ['acme/widgets', 'acme/gadgets', 'acme/x']);
  assert.deepEqual(normaliseRepos(undefined), []);
  assert.throws(() => normaliseRepos('acme/widgets'), /must be an array/);
  assert.throws(() => normaliseRepos(['widgets']), /"widgets" is not a GitHub repo/);
  assert.throws(() => normaliseRepos(['acme/..']), /not a GitHub repo/);
  assert.throws(() => normaliseRepos([7]), /must be "owner\/name" strings/);
  assert.throws(() => normaliseRepos(Array.from({ length: 21 }, (_, i) => `a/r${i}`)), /at most 20 repos/);
});

test('a child of a location session gets only its repos', () => {
  const parent = { location: {}, repos: ['acme/widgets', 'acme/gadgets'] };
  assert.deepEqual(childRepos(parent, []), ['acme/widgets', 'acme/gadgets']);
  assert.deepEqual(childRepos(parent, ['acme/Gadgets']), ['acme/Gadgets']);
  assert.throws(() => childRepos(parent, ['acme/widgets', 'other/x']), /other\/x is not one of the spawning session's repos/);
  assert.deepEqual(childRepos({ cwd: '/host' }, ['other/x']), ['other/x'], 'a host spawner has no repos to limit to');
  assert.deepEqual(childRepos(undefined, []), []);
});

test('a location card links only pull requests in its own repos', () => {
  const entry = { location: {}, repos: ['acme/widgets'] };
  assert.equal(prRepoOf('https://github.com/acme/widgets/pull/3'), 'acme/widgets');
  assert.equal(prLinkRefusal(entry, { type: 'pr', url: 'https://github.com/ACME/widgets/pull/3' }), null);
  assert.match(prLinkRefusal(entry, { type: 'pr', url: 'https://github.com/other/x/pull/3' }), /not a pull request in this session's repos \(acme\/widgets\)/);
  assert.match(prLinkRefusal({ location: {} }, { type: 'pr', url: 'https://github.com/acme/widgets/pull/3' }), /\(none\)/);
  assert.equal(prLinkRefusal(entry, { type: 'jira', key: 'ABC-1' }), null);
  assert.equal(prLinkRefusal({ cwd: '/x' }, { type: 'pr', url: 'https://github.com/other/x/pull/3' }), null);
});

test('the brief names each clone and the branch to make', () => {
  const brief = reposBrief('/w', ['acme/widgets', 'other/widgets'], { branch: 'fix', base: 'main' });
  assert.match(brief, /acme\/widgets\.git \/w\/acme-widgets/);
  assert.match(brief, /other\/widgets\.git \/w\/other-widgets/);
  assert.match(brief, /git switch -c fix origin\/main/);
  assert.equal(reposBrief('/w', []), '');
  assert.deepEqual(checkLocationBranch({ branch: 'fix', base: 'main', repos: ['a/b'] }), { branch: 'fix', branchBase: 'main' });
  assert.throws(() => checkLocationBranch({ branch: 'fix', repos: [] }), /branch needs GitHub repos/);
  assert.throws(() => checkLocationBranch({ base: 'main', repos: ['a/b'] }), /base needs a branch/);
  assert.match(renameLocationBranchText({ cwd: '/w', repos: ['acme/widgets'] }, 'old', 'new'), /git -C \/w\/widgets branch -m old new/);
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
