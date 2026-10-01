import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normaliseLink, normaliseLinks, linkMatches, createLinkNormaliser } from './links.js';

const claimJira = (link) => (link.type === 'jira' ? { type: 'jira', key: link.key, url: `https://co/browse/${link.key}` } : undefined);

test('a type nothing claims is rejected', () => {
  assert.throws(() => normaliseLink({ type: 'github', url: 'https://x' }), /unknown link type/i);
  assert.throws(() => normaliseLink({ type: 'jira', key: 'ENT-1' }, { claim: () => undefined }), /unknown link type/i);
});

test('a claiming extension normalises its own type', () => {
  assert.deepEqual(normaliseLink({ type: 'jira', key: 'ENT-1' }, { claim: claimJira }), { type: 'jira', key: 'ENT-1', url: 'https://co/browse/ENT-1' });
});

test('an unclaimed link already stored passes through unchanged, so a full-list set_links survives an extension being off', () => {
  const stored = { type: 'jira', key: 'ENT-1', url: 'https://old/ENT-1' };
  assert.deepEqual(normaliseLink({ type: 'jira', key: 'ent-1' }, { existing: [stored] }), stored);
  assert.deepEqual(normaliseLinks([{ type: 'jira', key: 'ENT-1' }, { type: 'pr', url: 'https://github.com/a/b/pull/1' }], { existing: [stored] }).map((l) => l.type), ['jira', 'pr']);
  assert.throws(() => normaliseLink({ type: 'jira', key: 'ENT-2' }, { existing: [stored] }), /unknown link type/i);
});

test('normaliseLinks maps a list and rejects a non-array', () => {
  const out = normaliseLinks([{ type: 'jira', key: 'ENT-1' }], { claim: claimJira });
  assert.equal(out.length, 1);
  assert.equal(out[0].url, 'https://co/browse/ENT-1');
  assert.throws(() => normaliseLinks('nope'), /must be an array/i);
});

test('createLinkNormaliser asks each enabled extension in turn and skips one with no façade', () => {
  const ext = { hooks: { 'links.normalise': [
    { extId: 'off', fn: () => { throw new Error('must not run'); } },
    { extId: 'a', fn: ({ link }) => (link.type === 'x' ? { type: 'x', via: 'a' } : undefined) },
    { extId: 'b', fn: ({ link, host }) => (link.type === 'y' ? { type: 'y', via: host.id } : undefined) },
  ] } };
  const claim = createLinkNormaliser(ext, (id) => (id === 'off' ? undefined : { id }));
  assert.deepEqual(claim({ type: 'x' }), { type: 'x', via: 'a' });
  assert.deepEqual(claim({ type: 'y' }), { type: 'y', via: 'b' });
  assert.equal(claim({ type: 'z' }), undefined);
  assert.equal(createLinkNormaliser({}, () => ({}))({ type: 'x' }), undefined);
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
  const out = normaliseLink({ type: 'pr', url: 'https://github.com/acme/widgets/pull/42', checkStatus: 'passing', checkStatusFetchedAt: '2026-06-16T00:00:00Z', headSha: '293558cba987' });
  assert.equal(out.checkStatus, 'passing');
  assert.equal(out.checkStatusFetchedAt, '2026-06-16T00:00:00Z');
  assert.equal(out.headSha, '293558cba987');
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
