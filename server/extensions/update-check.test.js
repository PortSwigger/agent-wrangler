import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createExtensionUpdateCheck, summarizeExtensionUpdates, currentExtensionUpdates } from './update-check.js';

const list = [
  { id: 'core-thing', external: false, label: 'Core thing' },
  { id: 'jira-links', external: true, label: 'Jira links', dir: '/ext/jira-links' },
  { id: 'slack-digest', external: true, label: 'Slack digest', dir: '/ext/slack-digest' },
  { id: 'usage', external: true, label: 'Usage', dir: '/ext/usage' },
  { id: 'by-hand', external: true, label: 'By hand', dir: '/ext/by-hand' },
  { id: 'offline', external: true, label: 'Offline', dir: '/ext/offline' },
];
const records = {
  'jira-links': { originUrl: 'https://example.invalid/jira.git', sha: 'j0' },
  'slack-digest': { originUrl: 'https://example.invalid/slack.git', sha: 's0' },
  usage: { originUrl: 'https://example.invalid/usage.git', sha: 'u0' },
  offline: { originUrl: 'https://example.invalid/offline.git', sha: 'o0' },
};
const remotes = { 'https://example.invalid/jira.git': 'j1', 'https://example.invalid/slack.git': 's1', 'https://example.invalid/usage.git': 'u0' };
const counts = { 'jira-links': { commits: 7, capped: false }, 'slack-digest': { commits: 1, capped: false } };

function checker(overrides = {}) {
  const calls = { lsRemote: [], count: [] };
  const check = createExtensionUpdateCheck({
    list: () => list,
    provenance: () => records,
    lsRemote: async (url) => { calls.lsRemote.push(url); if (!remotes[url]) throw new Error('unreachable'); return remotes[url]; },
    count: async (dir, sha, url) => { calls.count.push({ dir, sha, url }); return counts[dir.split('/').pop()]; },
    hasGitDir: () => true,
    ...overrides,
  });
  return { check, calls };
}

test('counts outdated installed extensions and the changes they miss, skipping builtins, hand-placed and failed ones', async () => {
  const { check, calls } = checker();
  const summary = await check();
  assert.equal(summary.outdated, 2);
  assert.equal(summary.commitsBehind, 8);
  assert.equal(summary.capped, false);
  assert.deepEqual(summary.extensions.map((e) => e.id), ['jira-links', 'slack-digest', 'usage', 'offline']);
  assert.match(summary.extensions.find((e) => e.id === 'offline').error, /unreachable/);
  assert.equal(summary.extensions.find((e) => e.id === 'usage').behind, false);
  // Only the outdated ones are fetched to count.
  assert.deepEqual(calls.count.map((c) => c.dir), ['/ext/jira-links', '/ext/slack-digest']);
  assert.equal(calls.count[0].url, 'https://example.invalid/jira.git');
});

test('an unmoved remote head is counted once, not on every tick', async () => {
  const { check, calls } = checker();
  await check();
  await check();
  assert.equal(calls.count.length, 2);
  assert.equal(calls.lsRemote.length, 8);
});

test('a count that cannot be made still says at least one change', async () => {
  const { check } = checker({ count: async () => { throw new Error('fetch refused'); } });
  const summary = await check();
  assert.equal(summary.outdated, 2);
  assert.equal(summary.commitsBehind, 2);
  assert.equal(summary.capped, true);
});

test('an extension with no clone directory is never counted in', async () => {
  let counted = 0;
  const { check } = checker({ hasGitDir: () => false, count: async () => { counted += 1; return { commits: 3 }; } });
  await check();
  assert.equal(counted, 0);
});

test('the published result drops extensions updated or removed since the check', () => {
  const summary = { ...summarizeExtensionUpdates([
    { id: 'jira-links', sha: 'j0', behind: true, commits: 7 },
    { id: 'slack-digest', sha: 's0', behind: true, commits: 1 },
  ]), checkedAt: 5 };
  const now = currentExtensionUpdates(summary, { 'jira-links': { sha: 'j1' }, 'slack-digest': { sha: 's0' } });
  assert.deepEqual({ outdated: now.outdated, commitsBehind: now.commitsBehind, checkedAt: now.checkedAt }, { outdated: 1, commitsBehind: 1, checkedAt: 5 });
  assert.equal(currentExtensionUpdates(null, {}), null);
});
