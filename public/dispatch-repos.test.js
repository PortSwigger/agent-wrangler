import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runtimeHasLocation } from './dispatch-repos.js';

test('only an extension runtime whose summary says location asks for repos', () => {
  const exts = [{ id: 'far', runtimes: [{ id: 'pod', location: true }, { id: 'box' }] }];
  assert.equal(runtimeHasLocation(exts, 'far', 'pod'), true);
  assert.equal(runtimeHasLocation(exts, 'far', 'box'), false);
  assert.equal(runtimeHasLocation(exts, undefined, 'local'), false);
  assert.equal(runtimeHasLocation(exts, 'gone', 'pod'), false);
});
