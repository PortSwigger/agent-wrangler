import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dispatchModePresentation } from './dispatch-mode.js';

const html = readFileSync(join(import.meta.dirname, 'index.html'), 'utf8');
const dispatch = html.match(/<div id="m-dispatch-fields">([\s\S]*?)<\/div>\s*<div id="m-subagent"/)?.[1];

test('dispatch modal keeps the primary form compact and puts optional controls in Advanced options', () => {
  assert.ok(dispatch, 'dispatch form should exist');
  assert.match(dispatch, /<div class="mode-segmented" id="m-mode-cards" role="group" aria-label="Session type">/);
  assert.doesNotMatch(dispatch, /id="m-mode-helper"/);
  assert.doesNotMatch(dispatch, /class="mode-card"/);
  assert.match(dispatch, /class="mode-segment-desc">Free-text prompt in any folder\.<\/span>/);
  assert.match(dispatch, /class="mode-segment-desc">Issue to PR autopilot\.<\/span>/);

  const worktree = dispatch.indexOf('class="worktree-box"');
  const advanced = dispatch.indexOf('id="m-advanced-options"');
  assert.ok(worktree >= 0 && worktree < advanced, 'worktree controls should remain before Advanced options');
  assert.match(dispatch, /<details class="advanced-options" id="m-advanced-options">/);

  const advancedMarkup = dispatch.slice(advanced);
  for (const id of ['m-effort', 'm-runtime', 'm-wf-auto-merge']) {
    assert.match(advancedMarkup, new RegExp(`id="${id}"`));
  }
});

test('workflow mode presentation updates the compact control and contextual copy', () => {
  assert.deepEqual(dispatchModePresentation('standard'), {
    standardPressed: true,
    workflowPressed: false,
    intentLabel: 'Intent / first prompt',
    intentPlaceholder: 'What should the agent work on?',
    launchLabel: 'Launch',
  });
  assert.deepEqual(dispatchModePresentation('workflow'), {
    standardPressed: false,
    workflowPressed: true,
    intentLabel: 'Issue (Jira key, GitHub issue, or description)',
    intentPlaceholder: 'ENT-1234, a GitHub issue URL or #number, or a free-text task',
    launchLabel: 'Start workflow',
  });
});
