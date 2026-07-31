import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseGithubSlug } from './repo-slug.js';

test('parses SSH scp form with a custom user (an SSO-enforced org remote)', () => {
  assert.equal(
    parseGithubSlug('org-123456789@github.com:PortSwigger/agent-wrangler.git'),
    'PortSwigger/agent-wrangler',
  );
});
test('parses plain git@ SSH scp form, with and without .git', () => {
  assert.equal(parseGithubSlug('git@github.com:owner/repo.git'), 'owner/repo');
  assert.equal(parseGithubSlug('git@github.com:owner/repo'), 'owner/repo');
});
test('parses HTTPS form, with and without .git and a trailing slash', () => {
  assert.equal(parseGithubSlug('https://github.com/owner/repo.git'), 'owner/repo');
  assert.equal(parseGithubSlug('https://github.com/owner/repo'), 'owner/repo');
  assert.equal(parseGithubSlug('https://github.com/owner/repo/'), 'owner/repo');
});
test('parses ssh:// URL form', () => {
  assert.equal(parseGithubSlug('ssh://git@github.com/owner/repo.git'), 'owner/repo');
});
test('returns null for a non-github host', () => {
  assert.equal(parseGithubSlug('git@gitlab.com:owner/repo.git'), null);
  assert.equal(parseGithubSlug('https://bitbucket.org/owner/repo.git'), null);
});
test('returns null for empty/unparseable input', () => {
  assert.equal(parseGithubSlug(''), null);
  assert.equal(parseGithubSlug(undefined), null);
  assert.equal(parseGithubSlug('not a url'), null);
});

import { repoSlugFor } from './repo-slug.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const exec = promisify(execFile);

test('repoSlugFor reads the origin remote of a real repo', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-slug-'));
  await exec('git', ['-C', dir, 'init', '-q']);
  await exec('git', ['-C', dir, 'remote', 'add', 'origin', 'git@github.com:acme/widgets.git']);
  assert.equal(await repoSlugFor(dir), 'acme/widgets');
  await fs.rm(dir, { recursive: true, force: true });
});
test('repoSlugFor returns null for a dir with no git repo', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-noslug-'));
  assert.equal(await repoSlugFor(dir), null);
  await fs.rm(dir, { recursive: true, force: true });
});
test('repoSlugFor returns null for a falsy dir', async () => {
  assert.equal(await repoSlugFor(''), null);
  assert.equal(await repoSlugFor(undefined), null);
});
