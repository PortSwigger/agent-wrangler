import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import jira, { dir, baseUrlFrom, normalise } from './index.js';
import { chip, hrefFor } from './public/index.js';
import { validateManifest, BUILTIN, loadExtensions } from '../../index.js';

const hostWith = (baseUrl) => ({ settings: { get: (k) => (k === 'baseUrl' ? baseUrl : undefined) } });

test('the manifest validates and is a builtin living in its own directory, on by default', () => {
  assert.doesNotThrow(() => validateManifest({ ...jira, dir }));
  assert.ok(BUILTIN.includes(jira));
  assert.deepEqual(dir.split(path.sep).slice(-2), ['builtin', 'jira']);
  assert.equal(jira.defaultEnabled, true);
  assert.ok(fs.existsSync(path.join(dir, 'public', 'index.js')));
});

test('it loads, contributing the links.normalise hook and a text baseUrl setting', () => {
  const loaded = loadExtensions({ cfg: {}, builtin: [{ ...jira, dir }] });
  const row = loaded.list.find((e) => e.id === 'jira');
  assert.ok(row.enabled);
  assert.ok(!row.quarantine);
  assert.deepEqual(loaded.hooks['links.normalise'].map((h) => h.extId), ['jira']);
  assert.deepEqual(jira.settings.map((s) => [s.key, s.type]), [['baseUrl', 'text']]);
});

test('disabled, it contributes no hook', () => {
  const loaded = loadExtensions({ cfg: { extensions: { jira: false } }, builtin: [{ ...jira, dir }] });
  assert.deepEqual(loaded.hooks['links.normalise'], []);
});

test('baseUrlFrom: the setting wins, empty falls back to the env var, a missing slash is added', () => {
  const env = { AW_JIRA_BASE_URL: 'https://env.atlassian.net/browse/' };
  assert.equal(baseUrlFrom('https://co.atlassian.net/browse/', env), 'https://co.atlassian.net/browse/');
  assert.equal(baseUrlFrom('https://co.atlassian.net/browse', env), 'https://co.atlassian.net/browse/');
  assert.equal(baseUrlFrom('  ', env), 'https://env.atlassian.net/browse/');
  assert.equal(baseUrlFrom(undefined, env), 'https://env.atlassian.net/browse/');
  assert.equal(baseUrlFrom('', {}), '');
});

test('normalise claims only jira: explicit url wins, base+key builds a url, key alone has none', () => {
  const host = hostWith('https://co.atlassian.net/browse/');
  assert.equal(normalise({ link: { type: 'pr', url: 'x' }, host }), undefined);
  assert.deepEqual(normalise({ link: { type: 'jira', key: 'ENT-1', url: 'https://x/y' }, host }), { type: 'jira', key: 'ENT-1', url: 'https://x/y' });
  assert.deepEqual(normalise({ link: { type: 'jira', key: 'ENT-1' }, host }), { type: 'jira', key: 'ENT-1', url: 'https://co.atlassian.net/browse/ENT-1' });
  assert.deepEqual(normalise({ link: { type: 'jira', key: 'ENT-1' }, host: hostWith('') }), { type: 'jira', key: 'ENT-1' });
  assert.throws(() => normalise({ link: { type: 'jira' }, host }), /key or url/i);
});

test('the client chip answers for jira only, resolving a key-only link against the current setting', () => {
  assert.equal(chip({ type: 'pr' }, null, {}), null);
  const api = { settings: () => ({ baseUrl: 'https://co.atlassian.net/browse' }) };
  const out = chip({ type: 'jira', key: 'ENT-1' }, null, api);
  assert.equal(out.label, 'ENT-1');
  assert.equal(out.href, 'https://co.atlassian.net/browse/ENT-1');
  assert.match(out.icon, /^<svg /);
  assert.equal(chip({ type: 'jira', key: 'ENT-1', url: 'https://x/y' }, null, api).href, 'https://x/y');
  assert.equal(hrefFor({ key: 'ENT-1' }, ''), '');
});
