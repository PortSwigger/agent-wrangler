import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldReloadForVersion, updateSummary, sessionOnOlderCode, updateAvailable, rolledBackText, updateToastText, installDriftNotice } from './update-panel.js';

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

test('the summary names the checkout service when an update cannot be applied here', () => {
  assert.match(updateSummary({ phase: 'status', status: { head: 'x', commits: [], behind: 1, blocked: null, canApply: false } }), /not started by the checkout service/);
});

test('a landed upgrade asks for a restart, offering the button only where the server can restart', () => {
  const drift = { installRoot: '/opt/aw', target: '/versions/0.2.0', version: '0.2.0', runningVersion: '0.1.0', restartHint: 'Restart it with `brew services restart agent-wrangler`.' };
  assert.equal(installDriftNotice({ drift: null, canRestart: true }), null);
  for (const [canRestart, restart, hint] of [
    [true, true, null],
    [false, false, drift.restartHint],
  ]) {
    const notice = installDriftNotice({ drift, canRestart });
    assert.equal(notice.restart, restart, `canRestart=${canRestart}`);
    assert.equal(notice.hint, hint, `canRestart=${canRestart}`);
    assert.match(notice.text, /An upgrade has landed \(0\.1\.0 → 0\.2\.0\).*restart the wrangler to finish/);
  }
});

test('the drift notice leaves out versions it cannot tell apart, and says when the path is mid-upgrade', () => {
  const base = { installRoot: '/opt/aw', target: '/versions/x', restartHint: 'h' };
  assert.match(installDriftNotice({ drift: { ...base, version: null, runningVersion: '0.1.0' } }).text, /^An upgrade has landed, but/);
  assert.match(installDriftNotice({ drift: { ...base, version: '0.1.0', runningVersion: '0.1.0' } }).text, /^An upgrade has landed, but/);
  assert.match(installDriftNotice({ drift: { ...base, target: null, version: null } }).text, /\/opt\/aw cannot be resolved, so an upgrade may be in progress/);
});
