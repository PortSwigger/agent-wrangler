import test from 'node:test';
import assert from 'node:assert/strict';
import semver from 'semver';
import { HOST_API_VERSION, servesRange, isValidRange } from './version.js';

test('HOST_API_VERSION is a real semver version', () => {
  assert.ok(semver.valid(HOST_API_VERSION), HOST_API_VERSION);
});

// Pinned, because the number is a promise to manifests: 1.1.0 is the release
// that added host.settings to alwaysPresent, and a manifest declaring ^1.1.0 is
// saying it needs that key to exist. An additive change bumps the minor and
// keeps every ^1.0.0 manifest served by the same builders.
test('the served version is 1.1.0, and every 1.x manifest range it can honour passes', () => {
  assert.equal(HOST_API_VERSION, '1.1.0');
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
