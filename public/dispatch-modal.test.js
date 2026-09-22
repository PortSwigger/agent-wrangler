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
  for (const id of ['m-effort', 'm-runtime', 'm-auto-compact-presets', 'm-wf-auto-merge']) {
    assert.match(advancedMarkup, new RegExp(`id="${id}"`));
  }
  assert.doesNotMatch(advancedMarkup, /id="m-auto-compact-tokens"/);
  assert.match(advancedMarkup, /data-auto-compact-tokens="50000"[^>]*>50k<\/button>/);
  assert.match(advancedMarkup, /data-auto-compact-tokens="100000"[^>]*>100k<\/button>/);
  assert.match(advancedMarkup, /data-auto-compact-tokens="250000"[^>]*>250k<\/button>/);
  assert.match(advancedMarkup, /data-auto-compact-tokens="500000"[^>]*>500k<\/button>/);
  assert.match(advancedMarkup, /data-auto-compact-tokens="1000000"[^>]*>1m<\/button>/);
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

// ── The `dispatch.field` anchor hosts and the hideable core rows ──────────
test('the dispatch modal carries the three dispatch.field anchor hosts', () => {
  for (const at of ['top', 'model', 'advanced']) {
    assert.match(dispatch, new RegExp(`<div class="ext-dispatch-slot" data-at="${at}"></div>`));
  }
});

test('the `model` anchor host sits OUTSIDE #m-model-row, so hiding model keeps the extension control', () => {
  const rowStart = dispatch.indexOf('id="m-model-row"');
  const rowEnd = dispatch.indexOf('</div>', dispatch.indexOf('<select id="m-model">'));
  const host = dispatch.indexOf('data-at="model"');
  assert.ok(rowStart >= 0 && rowEnd > rowStart, '#m-model-row should wrap the model label and select');
  assert.ok(host > rowEnd, 'the model anchor host must come after #m-model-row closes, not inside it');
});

test('the `top` anchor host sits between the intent block and the Folder label', () => {
  const intent = dispatch.indexOf('id="m-intent"');
  const host = dispatch.indexOf('data-at="top"');
  const folder = dispatch.indexOf('<label>Folder (cwd)</label>');
  assert.ok(intent >= 0 && intent < host && host < folder, 'top host belongs after the intent block, before Folder');
});

test('the `advanced` anchor host is the last thing in the Advanced options body', () => {
  const body = dispatch.indexOf('class="advanced-options-body"');
  const autoMerge = dispatch.indexOf('id="m-wf-auto-merge-row"');
  const host = dispatch.indexOf('data-at="advanced"');
  assert.ok(body >= 0 && body < autoMerge && autoMerge < host, 'advanced host belongs inside the body, after the auto-merge row');
});

test('every hideable core field is wrapped in its own id\'d .dispatch-field row', () => {
  const rows = {
    'm-model-row': ['<label>Model</label>', 'id="m-model"'],
    'm-effort-row': ['<label>Effort</label>', 'id="m-effort"'],
    'm-auto-compact-row': ['<label>Auto-compaction threshold</label>', 'id="m-auto-compact-presets"'],
    'm-runtime-row': ['<label>Runtime</label>', 'id="m-runtime"'],
  };
  for (const [id, parts] of Object.entries(rows)) {
    const start = dispatch.indexOf(`<div class="dispatch-field" id="${id}">`);
    assert.ok(start >= 0, `${id} should exist as a .dispatch-field wrapper`);
    // Bounded by the next wrapper (or the end), so a part living in a SIBLING
    // row cannot satisfy this row's assertion.
    const rest = dispatch.slice(start + 1);
    const nextRow = rest.indexOf('<div class="dispatch-field"');
    const slice = nextRow >= 0 ? rest.slice(0, nextRow) : rest;
    for (const part of parts) assert.ok(slice.includes(part), `${id} should wrap ${part}`);
  }
});
