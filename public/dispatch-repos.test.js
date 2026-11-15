import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRepoInput, runtimeHasLocation } from './dispatch-repos.js';

test('repo input splits on commas, spaces and newlines, reduces URLs and drops repeats', () => {
  assert.deepEqual(parseRepoInput(' acme/widgets, https://github.com/acme/gadgets.git\nACME/Widgets  git@github.com:other/x '), {
    repos: ['acme/widgets', 'acme/gadgets', 'other/x'], error: null,
  });
  assert.deepEqual(parseRepoInput(''), { repos: [], error: null });
});

test('repo input names the first entry that is not owner/name', () => {
  assert.equal(parseRepoInput('acme/widgets widgets').error, '"widgets" is not a GitHub repo; use owner/name.');
  assert.match(parseRepoInput('acme/a/b').error, /acme\/a\/b/);
  assert.match(parseRepoInput('-bad/name').error, /-bad\/name/);
  assert.match(parseRepoInput('acme/..').error, /acme\/\.\./);
});

test('only an extension runtime whose summary says location asks for repos', () => {
  const exts = [{ id: 'far', runtimes: [{ id: 'pod', location: true }, { id: 'box' }] }];
  assert.equal(runtimeHasLocation(exts, 'far', 'pod'), true);
  assert.equal(runtimeHasLocation(exts, 'far', 'box'), false);
  assert.equal(runtimeHasLocation(exts, undefined, 'local'), false);
  assert.equal(runtimeHasLocation(exts, 'gone', 'pod'), false);
});
