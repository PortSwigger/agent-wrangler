import { test } from 'node:test';
import assert from 'node:assert/strict';
import { codexComposerDiagnostic, paneComposerIsEmpty } from './composer-parsers.js';

const E = '\x1b';
for (const [name, pane, check, length, escapeOnly] of [
  ['missing style', '› private draft', 'missing-styling', 13, false],
  ['missing composer', `${E}[0moutput only`, 'composer-missing', null, false],
  ['unbold prompt', `${E}[0m› private draft`, 'prompt-not-bold', 13, false],
  ['faint echoed prompt', `${E}[1;2m› private draft`, 'prompt-dim', 13, false],
  ['typed draft', `${E}[1m›${E}[0m private draft`, 'visible-content', 13, false],
  ['unknown faint hint', `${E}[1m›${E}[0m ${E}[2mprivate draft`, 'placeholder-mismatch', 13, false],
  ['only escapes', `${E}[1m›${E}[0m ${E}[31m${E}[0m`, 'placeholder-mismatch', 0, true],
  ['empty composer', `${E}[1m›${E}[0m ${E}[2mAsk Codex to do anything`, 'empty', 24, false],
]) {
  test(`Codex diagnostic identifies ${name} without exposing pane content`, () => {
    assert.deepEqual(codexComposerDiagnostic(pane), {
      check, length, escapeOnly, mouseFragmentsOnly: false, approvalSelector: false,
    });
    assert.doesNotMatch(JSON.stringify(codexComposerDiagnostic(pane)), /private draft|output only|Ask Codex/);
  });
}

test('an approval menu below a protected draft never exposes that draft', () => {
  const pane = `${E}[1m›${E}[0m private draft\n  ${E}[1;7m› 1. Allow ${E}[0;7mRun the tool and continue`;
  const diagnostic = codexComposerDiagnostic(pane);
  assert.equal(diagnostic.check, 'approval-selector');
  assert.equal(diagnostic.approvalSelector, true);
  assert.doesNotMatch(JSON.stringify(diagnostic), /private|Run the tool/);
  assert.equal(paneComposerIsEmpty(pane, 'codex'), false);
});

test('an old selected approval above the current composer is not reported as a live selector', () => {
  const pane = `  ${E}[1;7m› 1. Allow ${E}[0;7mRun the tool and continue${E}[0m\n${E}[1m›${E}[0m private draft`;
  const diagnostic = codexComposerDiagnostic(pane);
  assert.equal(diagnostic.check, 'visible-content');
  assert.equal(diagnostic.approvalSelector, false);
});
