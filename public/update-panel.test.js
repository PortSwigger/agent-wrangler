import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldReloadForVersion, updateSummary, sessionOnOlderCode, updateAvailable, rolledBackText, updateToastText } from './update-panel.js';

test('a page reloads only when a known code version changes', () => {
  assert.equal(shouldReloadForVersion(null, 'abc'), false, 'first connect just records it');
  assert.equal(shouldReloadForVersion('abc', 'abc'), false, 'a plain restart keeps the page');
  assert.equal(shouldReloadForVersion('abc', null), false, 'a server outside git never forces a reload');
  assert.equal(shouldReloadForVersion('abc', 'def'), true);
});

test('the summary says what the check found', () => {
  const base = { head: '0123456789abcdef', commits: [], blocked: null, canApply: true };
  assert.equal(updateSummary({ phase: 'status', status: { ...base, behind: 0 } }), 'Up to date (0123456).');
  assert.equal(updateSummary({ phase: 'status', status: { ...base, behind: 1 } }), '1 new commit on origin/main.');
  assert.equal(updateSummary({ phase: 'status', status: { ...base, behind: 3 } }), '3 new commits on origin/main.');
});

test('the summary explains why an available update cannot be applied', () => {
  const base = { head: 'x', commits: [], behind: 2, canApply: true };
  assert.match(updateSummary({ phase: 'status', status: { ...base, blocked: 'The install checkout has uncommitted changes.' } }), /2 new commits.*uncommitted changes/);
  assert.match(updateSummary({ phase: 'status', status: { ...base, blocked: null, canApply: false } }), /pull and restart it by hand/);
});

test('an error shows the server message', () => {
  assert.equal(updateSummary({ phase: 'error', error: 'fetch failed' }), 'fetch failed');
});

test('a live session launched on another commit is on older code', () => {
  assert.equal(sessionOnOlderCode({ managed: true, launchedCodeVersion: 'a' }, 'b'), true);
  assert.equal(sessionOnOlderCode({ managed: true, launchedCodeVersion: 'b' }, 'b'), false);
  assert.equal(sessionOnOlderCode({ managed: false, launchedCodeVersion: 'a' }, 'b'), false);
  assert.equal(sessionOnOlderCode({ managed: true, launchedCodeVersion: null }, 'b'), false);
  assert.equal(sessionOnOlderCode({ managed: true, launchedCodeVersion: 'a' }, null), false);
});

test('the settings dot shows only for an update that can be taken', () => {
  assert.equal(updateAvailable({ behind: 2, blocked: null }), true);
  assert.equal(updateAvailable({ behind: 2, blocked: 'dirty' }), false);
  assert.equal(updateAvailable({ behind: 0, blocked: null }), false);
  assert.equal(updateAvailable(null), false);
});

test('a rollback names both commits', () => {
  assert.equal(rolledBackText(null), '');
  assert.match(rolledBackText({ target: 'bbbbbbbbbb', previous: 'aaaaaaaaaa' }), /update to bbbbbbb failed to start.*rolled back to aaaaaaa/);
});

test('a new update toasts once per upstream commit, and not when the user just asked', () => {
  const status = { behind: 2, blocked: null, remote: 'r2', rolledBack: null };
  assert.equal(updateToastText(status), 'Update available:');
  assert.equal(updateToastText(status, { lastToasted: 'r2' }), '');
  assert.equal(updateToastText(status, { lastToasted: 'r1' }), 'Update available:');
  assert.equal(updateToastText(status, { userAsked: true }), '');
  assert.equal(updateToastText({ ...status, blocked: 'dirty' }), '');
  assert.equal(updateToastText({ ...status, rolledBack: { target: 'r2' } }), '', 'the rollback banner already covers it');
});
