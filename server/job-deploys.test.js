import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inferDeploys, filterMatch, matchesFilters } from './job-deploys.js';
import { JobGithub } from './job-github.js';

const wf = (text, file = 'deploy.yml') => ({ file, text });
const infer = (text, files = ['src/a.js'], base = 'main') => inferDeploys({ workflows: [wf(text)], files, base }).workflows[0];

test('filterMatch follows the cheat sheet: * stops at /, ** does not, ?/+ quantify the preceding character', () => {
  for (const [pattern, value, want] of [
    ['*.md', 'README.md', true], ['*.md', 'docs/README.md', false],
    ['**.md', 'README.md', true], ['**.md', 'docs/deep/README.md', true],
    ['**/*.js', 'src/a.js', true], ['**/*.js', 'a.js', false],
    ['src/**', 'src/a/b.js', true], ['src/**', 'server/a.js', false],
    ['pages/**/*.js', 'pages/x/y.js', true],
    ['main?', 'main', true], ['main?', 'mai', true], ['main?', 'mainn', false],
    ['ma+in', 'maain', true], ['ma+in', 'min', false],
    ['releases/v[0-9]', 'releases/v2', true], ['releases/v[0-9]', 'releases/vx', false],
    ['a.md', 'axmd', false],
    ['!docs/**', 'docs/a.md', true],
  ]) assert.equal(filterMatch(pattern, value), want, `${pattern} vs ${value}`);
  assert.equal(filterMatch(undefined, 'a'), false);
});

test('matchesFilters evaluates in order with the last match winning', () => {
  for (const [patterns, value, want] of [
    [['src/**', '!src/**/*.md'], 'src/docs/a.md', false],
    [['src/**', '!src/**/*.md'], 'src/a.js', true],
    [['src/**', '!src/docs/**', 'src/docs/keep.js'], 'src/docs/keep.js', true],
    [['!src/**'], 'src/a.js', false],
    [[], 'src/a.js', false],
  ]) assert.equal(matchesFilters(patterns, value), want, patterns.join(','));
});

test('paths triggers only when a changed file survives the ordered pattern list', () => {
  // `**/*.md` needs a directory between: the ignore has to be `**.md` to catch src/readme.md.
  const text = 'on:\n  push:\n    paths:\n      - "src/**"\n      - "!src/**.md"\n';
  assert.deepEqual(infer(text, ['src/a.js']), { name: 'deploy', file: 'deploy.yml', triggers: true, reason: 'runs on push' });
  assert.deepEqual(infer(text, ['src/readme.md', 'docs/x.txt']),
    { name: 'deploy', file: 'deploy.yml', triggers: false, reason: 'only on paths src/**, !src/**.md' });
});

test('paths-ignore triggers when one changed file escapes the ignore list, not when every file is ignored', () => {
  const text = 'on:\n  push:\n    paths-ignore: ["**.md", "docs/**"]\n';
  assert.equal(infer(text, ['README.md', 'docs/guide/x.txt']).triggers, false);
  assert.equal(infer(text, ['README.md', 'src/a.js']).triggers, true);
});

test('paths wins when a workflow illegally declares paths-ignore too', () => {
  const text = 'on:\n  push:\n    paths: ["src/**"]\n    paths-ignore: ["src/**"]\n';
  assert.equal(infer(text, ['src/a.js']).triggers, true);
});

test('branch filters glob against the base branch, both ways round', () => {
  const branches = 'on:\n  push:\n    branches: [main, "release/**"]\n';
  assert.equal(infer(branches, ['a.js'], 'main').triggers, true);
  assert.equal(infer(branches, ['a.js'], 'release/2/x').triggers, true);
  assert.deepEqual(infer(branches, ['a.js'], 'feature/x').reason, 'only branches main, release/**');
  const ignore = 'on:\n  push:\n    branches-ignore: ["dependabot/**"]\n';
  assert.equal(infer(ignore, ['a.js'], 'main').triggers, true);
  assert.equal(infer(ignore, ['a.js'], 'dependabot/npm/x').reason, 'ignores branches dependabot/**');
});

test('a tags-only push trigger never fires for a branch push', () => {
  assert.equal(infer('on:\n  push:\n    tags: ["v*"]\n', ['a.js']).reason, 'only on tags');
  assert.equal(infer('on:\n  push:\n    tags-ignore: ["v*"]\n', ['a.js']).reason, 'only on tags');
  assert.equal(infer('on:\n  push:\n    tags: ["v*"]\n    branches: [main]\n', ['a.js']).triggers, true);
});

test('on parses as a string, a list, a map and the YAML 1.1 boolean key', () => {
  assert.equal(infer('on: push\n').triggers, true);
  assert.equal(infer('on: pull_request\n').reason, 'no push trigger');
  assert.equal(infer('on: [push, pull_request]\n').triggers, true);
  assert.equal(infer('on: [pull_request]\n').reason, 'no push trigger');
  assert.equal(infer('on:\n  push:\n  workflow_dispatch:\n').triggers, true);
  assert.equal(infer('%YAML 1.1\n---\non: push\n').triggers, true);
  assert.equal(infer('on:\n  schedule:\n    - cron: "0 0 * * *"\n  workflow_run:\n    workflows: [other]\n').reason, 'no push trigger');
  assert.equal(infer('name: no triggers at all\n').reason, 'no push trigger');
});

test('unparseable YAML is reported, never thrown', () => {
  assert.deepEqual(infer('on: [push\n  bad: "'), { name: 'deploy', file: 'deploy.yml', triggers: false, reason: 'unparseable' });
  assert.equal(infer('just a string').reason, 'unparseable');
  assert.equal(infer('').reason, 'no push trigger');
});

test('the name is the workflow name when it has one, else the file basename without extension', () => {
  assert.equal(inferDeploys({ workflows: [{ file: '.github/workflows/deployment-pipeline.yaml', text: 'on: push' }], files: ['a.js'], base: 'main' }).workflows[0].name, 'deployment-pipeline');
  assert.equal(infer('name: Deploy to prod\non: push\n').name, 'Deploy to prod');
});

test('summary names every triggering workflow when a deploy is expected', () => {
  const out = inferDeploys({ base: 'main', files: ['src/a.js'], workflows: [
    { file: 'deploy.yml', text: 'name: Deploy\non: push\n' },
    { file: 'docs.yml', text: 'on:\n  push:\n    paths: ["docs/**"]\n' },
    { file: 'release.yml', text: 'on:\n  push:\n    branches: [main]\n' },
  ] });
  assert.equal(out.expected, true);
  assert.equal(out.summary, 'Deploys on merge · Deploy · release');
});

test('summary names the workflow that declined this diff, or says nothing runs', () => {
  // The design case: an AGENTS.md-only change against a repo whose pipeline skips docs.
  const docsOnly = inferDeploys({ base: 'main', files: ['AGENTS.md', 'docs/x.md'], workflows: [
    { file: 'pr-checks.yml', text: 'on:\n  pull_request:\n' },
    { file: 'deployment-pipeline.yaml', text: 'on:\n  push:\n    paths-ignore: ["**.md"]\n' },
  ] });
  assert.equal(docsOnly.expected, false);
  assert.equal(docsOnly.summary, 'Merge completes it · deployment-pipeline ignores **.md');
  const noPush = inferDeploys({ base: 'main', files: ['a.js'], workflows: [{ file: 'pr-checks.yml', text: 'on: pull_request\n' }] });
  assert.equal(noPush.summary, 'Merge completes it · nothing runs on push to main');
  assert.equal(inferDeploys({ base: 'main', files: ['a.js'], workflows: [] }).summary, 'Merge completes it · no workflows');
  assert.equal(inferDeploys().summary, 'Merge completes it · no workflows');
});

test('an unknown file list expects the deploy rather than claiming the merge delivers it', () => {
  assert.equal(infer('on:\n  push:\n    paths: ["src/**"]\n', []).triggers, true);
});

test('JobGithub.deploys reads the PR files, prefers the worktree tree and carries head and base', async () => {
  const calls = [];
  const github = new JobGithub(async (bin, args, cwd) => { calls.push({ bin, args, cwd }); return JSON.stringify({ files: [{ path: 'README.md' }, { path: 'src/a.js' }] }); });
  const dirs = [];
  github.readWorkflows = (dir) => { dirs.push(dir); return dir.includes('worktrees') ? [{ file: 'deploy.yml', text: 'on:\n  push:\n    paths: ["src/**"]\n' }] : []; };
  const sub = { repo: '~/IdeaProjects/thing', worktree: { path: '/tmp/worktrees/thing-1' }, pr: { url: 'https://github.com/o/r/pull/7' } };
  const out = await github.deploys(sub, { url: 'https://github.com/o/r/pull/7', head: 'sha7', base: 'main' });
  assert.deepEqual(calls[0].args, ['pr', 'view', 'https://github.com/o/r/pull/7', '--json', 'files']);
  assert.equal(calls[0].cwd, '~/IdeaProjects/thing');
  assert.equal(dirs[0], '/tmp/worktrees/thing-1/.github/workflows');
  assert.deepEqual(out, { head: 'sha7', base: 'main', expected: true,
    workflows: [{ name: 'deploy', file: 'deploy.yml', triggers: true, reason: 'runs on push' }],
    summary: 'Deploys on merge · deploy' });
});

test('JobGithub.deploys falls back to the checkout with ~ expanded, and to no workflows at all', async () => {
  const github = new JobGithub(async () => JSON.stringify({ files: [{ path: 'AGENTS.md' }] }));
  const dirs = [];
  github.readWorkflows = (dir) => { dirs.push(dir); return dir.startsWith('/') && !dir.includes('missing') ? [{ file: 'pipeline.yml', text: 'on:\n  push:\n    paths-ignore: ["**.md"]\n' }] : []; };
  const sub = { repo: '~/IdeaProjects/thing', worktree: { path: '/tmp/missing/wt' }, pr: { url: 'u' } };
  const out = await github.deploys(sub, { head: 'sha1', base: 'main' });
  assert.equal(dirs[1], `${process.env.HOME}/IdeaProjects/thing/.github/workflows`);
  assert.equal(out.expected, false);
  assert.equal(out.summary, 'Merge completes it · pipeline ignores **.md');
  const bare = new JobGithub(async () => JSON.stringify({ files: [] }));
  bare.readWorkflows = () => [];
  assert.equal((await bare.deploys({ repo: '/r', pr: { url: 'u' } }, { head: 'h', base: 'main' })).summary, 'Merge completes it · no workflows');
});

test('readWorkflows returns an empty list for a missing directory and only reads yml/yaml', () => {
  const github = new JobGithub();
  assert.deepEqual(github.readWorkflows('/definitely/not/a/dir'), []);
  const files = github.readWorkflows(new URL('../.github/workflows', import.meta.url).pathname);
  assert.ok(files.every((f) => /\.ya?ml$/.test(f.file) && typeof f.text === 'string'));
});
