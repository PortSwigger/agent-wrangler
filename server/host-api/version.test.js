import test from 'node:test';
import assert from 'node:assert/strict';
import semver from 'semver';
import { HOST_API_VERSION, servesRange, isValidRange } from './version.js';

test('HOST_API_VERSION is a real semver version', () => {
  assert.ok(semver.valid(HOST_API_VERSION), HOST_API_VERSION);
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
