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
// vocabulary, 1.6.0 added the `usage:read` and `sessions:bill` capabilities,
// 1.7.0 added the `view` slot's `badge`, 1.8.0 the client-side `openSession`
// (both public/slots.js), 1.9.0 the `dispatch.field` slot and
// `hideDispatchField` manifest key, 1.10.0 the `sessions:interrupt`
// capability, 1.11.0 the `task.action` slot and client-side `minimiseTask`
// 1.12.0 the `codexPolicy` manifest key, 1.13.0 the client `api.settings()`,
// 1.14.0 the chip veto (`cards:hideChips`), `settings.panel` and the `list` setting type,
// 1.15.0 the `task.body` slot, `claimDrag`, `openDispatch`, `onTaskDelete` and `host.tasks.adhocId`,
// 1.16.0 the `textarea` setting type,
// 1.17.0 the `hooks` manifest object, `activate`/`deactivate`, `host.events` and `host.memory`,
// 1.18.0 the `links.normalise` hook and the `link.chip` slot,
// 1.19.0 the `runtimes` manifest key, `links:write` and the `worktree` dispatch field,
// 1.20.0 the `dispatch.field` `open(el, ctx)` hook,
// 1.21.0 per-item `pattern`/`maxLength` on a `list` setting,
// 1.22.0 the runtime `launchStatus` hook,
// 1.23.0 `tasks:archive` and the client `api.ui.notify`,
// 1.24.0 the client `api.openTask`,
// and 1.25.0 the client `api.agents`,
// and a manifest declaring any of those
// ranges is saying it needs that surface to exist. An additive change bumps the
// minor and keeps every ^1.0.0 manifest served by the same builders.
test('the served version is 1.25.0, and every 1.x manifest range it can honour passes', () => {
  assert.equal(HOST_API_VERSION, '1.25.0');
  assert.equal(servesRange('^1.25.0'), true);
  assert.equal(servesRange('^1.24.0'), true);
  assert.equal(servesRange('^1.23.0'), true);
  assert.equal(servesRange('^1.22.0'), true);
  assert.equal(servesRange('^1.21.0'), true);
  assert.equal(servesRange('^1.20.0'), true);
  assert.equal(servesRange('^1.19.0'), true);
  assert.equal(servesRange('^1.18.0'), true);
  assert.equal(servesRange('^1.17.0'), true);
  assert.equal(servesRange('^1.16.0'), true);
  assert.equal(servesRange('^1.15.0'), true);
  assert.equal(servesRange('^1.14.0'), true);
  assert.equal(servesRange('^1.13.0'), true);
  assert.equal(servesRange('^1.12.0'), true);
  assert.equal(servesRange('^1.11.0'), true);
  assert.equal(servesRange('^1.10.0'), true);
  assert.equal(servesRange('^1.9.0'), true);
  assert.equal(servesRange('^1.8.0'), true);
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
