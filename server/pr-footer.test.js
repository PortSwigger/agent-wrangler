import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasModelLine, hasAttributionLine, withModelFooter, fetchFooterModel, tagPrWithModel, runModelFooter } from './pr-footer.js';

const PR = 'https://github.com/acme/widgets/pull/7';

// A gh stand-in: answers `pr view` with `body` and records every call.
function fakeGh(body) {
  const calls = [];
  const gh = async (args, input) => {
    calls.push({ args, input });
    return args[1] === 'view' ? `${body}\n` : '';
  };
  return { gh, calls };
}

const json = (value, ok = true) => async () => ({ ok, json: async () => value });

test('hasModelLine finds a Model line anywhere in the body, and only at a line start', () => {
  assert.equal(hasModelLine('Summary\n\nModel: claude-opus-5-5'), true);
  assert.equal(hasModelLine('Model: gpt-5.5\n\nmore'), true);
  assert.equal(hasModelLine('The Model: field is not a footer'), false);
  assert.equal(hasModelLine('Model:'), false);
  assert.equal(hasModelLine(null), false);
});

test('hasAttributionLine matches ours or a longer extension variant, only at a line start', () => {
  assert.equal(hasAttributionLine('Summary\n\nMade with Agent Wrangler'), true);
  assert.equal(hasAttributionLine('Summary\n\nMade with Agent Wrangler and the acme/widgets extension'), true);
  assert.equal(hasAttributionLine('Not Made with Agent Wrangler'), false);
  assert.equal(hasAttributionLine('Made with Agent Wranglers'), false);
});

test('withModelFooter appends the Model line then the attribution, trimming trailing space', () => {
  assert.equal(withModelFooter('Summary\n\n🤖 Generated\n\n', 'claude-opus-5-5'), 'Summary\n\n🤖 Generated\n\nModel: claude-opus-5-5\n\nMade with Agent Wrangler');
  assert.equal(withModelFooter('', 'claude-opus-5-5'), 'Model: claude-opus-5-5\n\nMade with Agent Wrangler');
});

test('withModelFooter adds only the lines a body lacks', () => {
  assert.equal(withModelFooter('Summary\n\nModel: claude-sonnet-5-5', 'claude-opus-5-5'), 'Summary\n\nModel: claude-sonnet-5-5\n\nMade with Agent Wrangler');
  const ext = 'Summary\n\nMade with Agent Wrangler and the acme/widgets extension';
  assert.equal(withModelFooter(ext, 'claude-opus-5-5'), `${ext}\n\nModel: claude-opus-5-5`);
});

test('withModelFooter leaves a body with both lines, or has no model to add', () => {
  assert.equal(withModelFooter('Summary\n\nModel: claude-sonnet-5-5\n\nMade with Agent Wrangler', 'claude-opus-5-5'), null);
  assert.equal(withModelFooter('Summary', null), null);
});

test('tagPrWithModel reads the body and writes the footered body through --body-file stdin', async () => {
  const { gh, calls } = fakeGh('Summary');
  assert.equal(await tagPrWithModel({ prUrl: PR, model: 'claude-opus-5-5', gh }), 'tagged');
  assert.deepEqual(calls[0].args, ['pr', 'view', PR, '--json', 'body', '--jq', '.body']);
  assert.deepEqual(calls[1].args, ['pr', 'edit', PR, '--body-file', '-']);
  assert.equal(calls[1].input, 'Summary\n\nModel: claude-opus-5-5\n\nMade with Agent Wrangler');
});

test('tagPrWithModel never edits a body that already has both footer lines', async () => {
  const { gh, calls } = fakeGh('Summary\n\nModel: claude-sonnet-5-5\n\nMade with Agent Wrangler');
  assert.equal(await tagPrWithModel({ prUrl: PR, model: 'claude-opus-5-5', gh }), 'present');
  assert.equal(calls.length, 1);
});

test('tagPrWithModel without a model touches nothing', async () => {
  const { gh, calls } = fakeGh('Summary');
  assert.equal(await tagPrWithModel({ prUrl: PR, model: null, gh }), 'skipped');
  assert.equal(calls.length, 0);
});

test('fetchFooterModel POSTs the given identity headers and returns the model, or null', async () => {
  let seen;
  const headers = { Authorization: 'Bearer awt_x' };
  const fetchImpl = async (url, opts) => { seen = { url, opts }; return { ok: true, json: async () => ({ model: 'claude-opus-5-5' }) }; };
  assert.equal(await fetchFooterModel({ url: 'http://127.0.0.1:1/pr-model', headers, fetchImpl }), 'claude-opus-5-5');
  assert.equal(seen.opts.method, 'POST');
  assert.deepEqual(seen.opts.headers, headers);
  assert.equal(await fetchFooterModel({ url: 'u', headers, fetchImpl: json({ model: null }) }), null);
  assert.equal(await fetchFooterModel({ url: 'u', headers, fetchImpl: json({}, false) }), null);
  assert.equal(await fetchFooterModel({ url: null, headers, fetchImpl: json({ model: 'x' }) }), null);
  assert.equal(await fetchFooterModel({ url: 'u', headers: null, fetchImpl: json({ model: 'x' }) }), null);
});

test('runModelFooter sends the session token when the launch set one', async () => {
  let seen;
  const fetchImpl = async (url, opts) => { seen = opts; return { ok: true, json: async () => ({ model: null }) }; };
  await runModelFooter({ prUrl: PR, env: { AW_PR_MODEL_URL: 'u', AW_SESSION_ID: 'CARD', AW_SESSION_TOKEN: 'awt_t' }, fetchImpl, gh: fakeGh('').gh });
  assert.deepEqual(seen.headers, { Authorization: 'Bearer awt_t' });
});

test('runModelFooter: setting off (server answers null) leaves the PR untouched', async () => {
  const { gh, calls } = fakeGh('Summary');
  const env = { AW_PR_MODEL_URL: 'u', AW_SESSION_ID: 'CARD' };
  assert.equal(await runModelFooter({ prUrl: PR, env, fetchImpl: json({ model: null }), gh }), 'skipped');
  assert.equal(calls.length, 0);
});

test('runModelFooter: setting on tags the PR with the session model', async () => {
  const { gh, calls } = fakeGh('Summary');
  const env = { AW_PR_MODEL_URL: 'u', AW_SESSION_ID: 'CARD' };
  assert.equal(await runModelFooter({ prUrl: PR, env, fetchImpl: json({ model: 'gpt-5.5' }), gh }), 'tagged');
  assert.equal(calls[1].input, 'Summary\n\nModel: gpt-5.5\n\nMade with Agent Wrangler');
});
