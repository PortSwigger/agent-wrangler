import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractCreatedPrUrl } from './pr-hook.js';

const PR = 'https://github.com/o/r/pull/42';
const payload = (command, output) => JSON.stringify({
  tool_name: 'Bash',
  tool_input: { command },
  tool_response: { stdout: output },
});

test('extracts the url from a gh pr create payload', () => {
  assert.equal(extractCreatedPrUrl(payload('gh pr create --fill', `Creating pull request\n${PR}\n`)), PR);
});

test('finds the url regardless of which output field carries it', () => {
  // Older CC versions name the field tool_output rather than tool_response.stdout.
  const legacy = JSON.stringify({ tool_input: { command: 'gh pr create' }, tool_output: PR });
  assert.equal(extractCreatedPrUrl(legacy), PR);
});

test('non-create gh commands do not attach, even when they print a url', () => {
  assert.equal(extractCreatedPrUrl(payload('gh pr view 42', PR)), null);
  assert.equal(extractCreatedPrUrl(payload('gh pr list', PR)), null);
});

test('a grep whose SEARCH PATTERN merely contains "gh pr create" text does not attach, even when its matched output surfaces an unrelated PR url', () => {
  // Reproduces a real false-attach: debugging this exact hook by grepping a
  // transcript for the literal string "gh pr create" (among other terms) caused
  // the grep's own matched lines — which happened to mention a DIFFERENT PR's url
  // — to get attached to the grepping session as if it had just created that PR.
  const command = 'grep -n "gh pr create\\|pull/134\\|pr-attach" /some/transcript.jsonl | head -20';
  const output = '75:{"type":"pr-link","prUrl":"https://github.com/o/other-repo/pull/134", ...}';
  assert.equal(extractCreatedPrUrl(payload(command, output)), null);
});

test('a chained `cmd && gh pr create` invocation still attaches (segment-start match, not just line-start)', () => {
  assert.equal(extractCreatedPrUrl(payload('cd /repo && gh pr create --fill', `Creating pull request\n${PR}\n`)), PR);
});

test('a multi-line command (`cd repo` then `gh pr create` on its own line) still attaches', () => {
  // A newline-joined Bash call runs each line sequentially, same as `;` — the
  // gate must treat it as a chain segment, not miss it for lacking &&/;/|.
  assert.equal(extractCreatedPrUrl(payload('cd /repo\ngh pr create --fill', `Creating pull request\n${PR}\n`)), PR);
});

test('a git push compare/hint url is ignored (not a /pull/<n> url)', () => {
  const hint = 'https://github.com/o/r/pull/new/my-branch';
  assert.equal(extractCreatedPrUrl(payload('gh pr create', hint)), null);
});

test('create with no resulting pr url yields null', () => {
  assert.equal(extractCreatedPrUrl(payload('gh pr create', 'a pull request already exists')), null);
});

test('malformed json falls back to a raw-text gate', () => {
  assert.equal(extractCreatedPrUrl(`not json … gh pr create … ${PR}`), PR);
  assert.equal(extractCreatedPrUrl(`not json … gh pr view … ${PR}`), null);
});

test('empty / non-string input yields null', () => {
  assert.equal(extractCreatedPrUrl(''), null);
  assert.equal(extractCreatedPrUrl(undefined), null);
});
