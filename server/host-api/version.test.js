import test from 'node:test';
import assert from 'node:assert/strict';
import semver from 'semver';
import { HOST_API_VERSION, servesRange, isValidRange } from './version.js';

test('HOST_API_VERSION is a real semver version', () => {
  assert.ok(semver.valid(HOST_API_VERSION), HOST_API_VERSION);
});

// Pinned, because the number is a promise to manifests: 1.1.0 added
// host.settings to alwaysPresent, 1.2.0 added the client-side onMessage seam
// (public/slots.js), 1.3.0 added `extId`/`settings` to the store factory bag
// (server/index.js), 1.4.0 added the worktree/addDirs/taskId/PR-automation
// options to `sessions:spawn` (host-api/v1.js), 1.5.0 widened the setting-def
// vocabulary, 1.6.0 added the `usage:read` and `sessions:bill` capabilities and
// 1.7.0 added the `view` slot's `badge` (public/slots.js), and a manifest
// declaring any of those ranges is saying it needs that surface to exist. An
// additive change bumps the minor and keeps every ^1.0.0 manifest served by the
// same builders.
test('the served version is 1.7.0, and every 1.x manifest range it can honour passes', () => {
  assert.equal(HOST_API_VERSION, '1.7.0');
  assert.equal(servesRange('^1.7.0'), true);
  assert.equal(servesRange('^1.6.0'), true);
  assert.equal(servesRange('^1.5.0'), true);
  assert.equal(servesRange('^1.4.0'), true);
  assert.equal(servesRange('^1.3.0'), true);
  assert.equal(servesRange('^1.2.0'), true);
  assert.equal(servesRange('^1.1.0'), true);
  assert.equal(servesRange('^1.0.0'), true);
  assert.equal(servesRange('^2.0.0'), false);
});

test('an absent range is no constraint', () => {
  assert.equal(servesRange(null), true);
  assert.equal(servesRange(undefined), true);
  assert.equal(servesRange(''), true);
});

test('servesRange matches the served version', () => {
  assert.equal(servesRange(`^${HOST_API_VERSION}`), true);
  assert.equal(servesRange(`>=${HOST_API_VERSION}`), true);
  assert.equal(servesRange(`>${HOST_API_VERSION}`), false);
  assert.equal(servesRange(`<${HOST_API_VERSION}`), false);
});

test('a malformed range never passes', () => {
  assert.equal(isValidRange('not a range'), false);
  assert.equal(servesRange('not a range'), false);
  assert.equal(isValidRange('^1.0.0'), true);
});
