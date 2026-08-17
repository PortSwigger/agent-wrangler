import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normaliseLink, normaliseLinks, linkMatches } from './links.js';

const base = () => 'https://co.atlassian.net/browse/';

test('explicit url wins over base+key', () => {
  const out = normaliseLink({ type: 'jira', key: 'ENT-1', url: 'https://x/y' }, base());
  assert.deepEqual(out, { type: 'jira', key: 'ENT-1', url: 'https://x/y' });
});

test('base + key builds the url when no explicit url', () => {
  const out = normaliseLink({ type: 'jira', key: 'ENT-1' }, base());
  assert.deepEqual(out, { type: 'jira', key: 'ENT-1', url: 'https://co.atlassian.net/browse/ENT-1' });
});

test('key only, no base, leaves url absent', () => {
  const out = normaliseLink({ type: 'jira', key: 'ENT-1' }, '');
  assert.deepEqual(out, { type: 'jira', key: 'ENT-1' });
});

test('unknown type is rejected', () => {
  assert.throws(() => normaliseLink({ type: 'github', url: 'https://x' }, ''), /unknown link type/i);
});

test('neither key nor url is rejected', () => {
  assert.throws(() => normaliseLink({ type: 'jira' }, ''), /key or url/i);
});

test('normaliseLinks maps a list and rejects a non-array', () => {
  const out = normaliseLinks([{ type: 'jira', key: 'ENT-1' }], base());
  assert.equal(out.length, 1);
  assert.equal(out[0].url, 'https://co.atlassian.net/browse/ENT-1');
  assert.throws(() => normaliseLinks('nope', ''), /must be an array/i);
});

test('pr link derives repo and number from a github pull url', () => {
  const out = normaliseLink({ type: 'pr', url: 'https://github.com/acme/widgets/pull/42' });
  assert.deepEqual(out, { type: 'pr', url: 'https://github.com/acme/widgets/pull/42', repo: 'acme/widgets', number: 42 });
});

test('pr link rejects a non-pull github url', () => {
  assert.throws(() => normaliseLink({ type: 'pr', url: 'https://github.com/acme/widgets' }), /github pull-request url/i);
});

test('pr link rejects a non-github url', () => {
  assert.throws(() => normaliseLink({ type: 'pr', url: 'https://gitlab.com/acme/widgets/-/merge_requests/1' }), /github pull-request url/i);
});

test('pr link requires a url', () => {
  assert.throws(() => normaliseLink({ type: 'pr' }), /pr links need a url/i);
});

test('pr link preserves an existing checkStatus through normalise', () => {
  const out = normaliseLink({ type: 'pr', url: 'https://github.com/acme/widgets/pull/42', checkStatus: 'passing', checkStatusFetchedAt: '2026-06-16T00:00:00Z' });
  assert.equal(out.checkStatus, 'passing');
  assert.equal(out.checkStatusFetchedAt, '2026-06-16T00:00:00Z');
});

test('pr link preserves an existing dirty flag through normalise', () => {
  const out = normaliseLink({ type: 'pr', url: 'https://github.com/acme/widgets/pull/42', dirty: true });
  assert.equal(out.dirty, true);
  const clean = normaliseLink({ type: 'pr', url: 'https://github.com/acme/widgets/pull/42', dirty: false });
  assert.equal(clean.dirty, false);
  const absent = normaliseLink({ type: 'pr', url: 'https://github.com/acme/widgets/pull/42' });
  assert.equal('dirty' in absent, false);
});

test('pr link preserves an existing unresolvedCount through normalise', () => {
  const out = normaliseLink({ type: 'pr', url: 'https://github.com/acme/widgets/pull/42', unresolvedCount: 3 });
  assert.equal(out.unresolvedCount, 3);
  const zero = normaliseLink({ type: 'pr', url: 'https://github.com/acme/widgets/pull/42', unresolvedCount: 0 });
  assert.equal(zero.unresolvedCount, 0);
  const absent = normaliseLink({ type: 'pr', url: 'https://github.com/acme/widgets/pull/42' });
  assert.equal('unresolvedCount' in absent, false);
});

test('linkMatches matches jira by key, case-insensitive and trimmed', () => {
  assert.equal(linkMatches({ type: 'jira', key: 'ENT-1' }, { type: 'jira', key: ' ent-1 ' }), true);
});

test('linkMatches matches jira by url', () => {
  assert.equal(linkMatches({ type: 'jira', key: 'ENT-1', url: 'https://co/browse/ENT-1' }, { type: 'jira', url: ' https://co/browse/ENT-1 ' }), true);
});

test('linkMatches matches pr by url despite a trailing slash', () => {
  assert.equal(linkMatches({ type: 'pr', url: 'https://github.com/acme/widgets/pull/42', repo: 'acme/widgets', number: 42 }, { type: 'pr', url: 'https://github.com/acme/widgets/pull/42/' }), true);
});

test('linkMatches is false across different types', () => {
  assert.equal(linkMatches({ type: 'pr', url: 'https://github.com/a/b/pull/1' }, { type: 'jira', key: 'ENT-1' }), false);
});

test('linkMatches is false on a miss', () => {
  assert.equal(linkMatches({ type: 'jira', key: 'ENT-1' }, { type: 'jira', key: 'ENT-2' }), false);
});
