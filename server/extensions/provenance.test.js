import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../data-dir.js';
import {
  ID_RE,
  isValidExtensionId,
  externalDir,
  tmpDir,
  readProvenance,
  recordFor,
  putRecord,
  removeRecord,
  ensureDirs,
} from './provenance.js';

// test-setup.js (node --test --import) redirects AW_DATA_DIR to a per-process
// temp dir, so these write into the REAL paths the module computes with no
// snapshot/restore of the developer's ~/.agent-wrangler. Still cleaned between
// tests: a leftover extensions.json (or a `.corrupt` sibling) would make
// "a missing file reads as {}" pass or fail depending on test order.
const FILE = path.join(DATA_DIR, 'extensions.json');
const clean = () => {
  for (const n of fs.readdirSync(DATA_DIR)) {
    if (n.startsWith('extensions.json')) fs.rmSync(path.join(DATA_DIR, n), { force: true });
  }
};

const record = (over = {}) => ({
  id: 'demo',
  originUrl: 'https://github.com/example/demo',
  sha: 'a'.repeat(40),
  installedAt: '2026-01-01T00:00:00.000Z',
  requires: ['sessions:read', 'tasks:write'],
  dependencies: ['left-pad@1.3.0', 'semver@7.6.0'],
  ...over,
});

test('paths live under DATA_DIR and .tmp sits inside the external dir', () => {
  assert.equal(externalDir(), path.join(DATA_DIR, 'extensions'));
  assert.equal(tmpDir(), path.join(externalDir(), '.tmp'));
  ensureDirs();
  assert.ok(fs.existsSync(tmpDir()));
});

test('a missing file reads as {} and an unknown id has no record', () => {
  clean();
  assert.deepEqual(readProvenance(), {});
  assert.equal(recordFor('nope'), null);
});

test('putRecord round-trips through readProvenance and recordFor', () => {
  clean();
  const written = putRecord(record());
  assert.deepEqual(written, record());
  assert.deepEqual(readProvenance(), { demo: record() });
  assert.deepEqual(recordFor('demo'), record());
  clean();
});

test('a second putRecord replaces its own id and leaves siblings alone', () => {
  clean();
  putRecord(record());
  putRecord(record({ id: 'other', requires: [] }));
  putRecord(record({ sha: 'b'.repeat(40) }));
  const all = readProvenance();
  assert.deepEqual(Object.keys(all).sort(), ['demo', 'other']);
  assert.equal(all.demo.sha, 'b'.repeat(40));
  assert.deepEqual(all.other.requires, []);
  clean();
});

test('removeRecord deletes only the named id and reports whether it existed', () => {
  clean();
  putRecord(record());
  putRecord(record({ id: 'other' }));
  assert.equal(removeRecord('demo'), true);
  assert.equal(removeRecord('demo'), false);
  assert.deepEqual(Object.keys(readProvenance()), ['other']);
  clean();
});

// The id builds `extensions/<id>/` from a third-party manifest, so a write must
// fail loudly rather than persist a record that later resolves somewhere else.
test('a bad id is refused on write and never resolves on read', () => {
  clean();
  for (const id of ['../escape', 'Demo', '1demo', 'demo/sub', '', '.tmp', null, undefined]) {
    assert.throws(() => putRecord(record({ id })), /Extension id must match/);
    assert.equal(recordFor(id), null);
    assert.equal(removeRecord(id), false);
  }
  assert.ok(!ID_RE.test('../escape'));
  assert.ok(isValidExtensionId('demo') && !isValidExtensionId('.tmp'));
  assert.deepEqual(readProvenance(), {});
});

// The consented capability set is the reason this file exists, so a record whose
// arrays were hand-edited away must read as EMPTY rather than undefined — a diff
// against undefined throws, and "no recorded consent" has to look like "consents
// to nothing" so an update re-prompts. A bad ENTRY costs only itself.
test('missing or malformed fields normalise instead of throwing', () => {
  clean();
  fs.writeFileSync(
    FILE,
    JSON.stringify({ demo: { id: 'demo', requires: 'sessions:read' }, BAD: { id: 'BAD' }, nul: null })
  );
  const all = readProvenance();
  assert.deepEqual(Object.keys(all), ['demo']);
  assert.deepEqual(all.demo, {
    id: 'demo', originUrl: null, sha: null, installedAt: null, requires: [], dependencies: [],
  });
  clean();
});

test('a non-object top level reads as {}', () => {
  clean();
  fs.writeFileSync(FILE, '[]');
  assert.deepEqual(readProvenance(), {});
  clean();
});

test('a corrupt file degrades to {} rather than throwing', () => {
  clean();
  fs.writeFileSync(FILE, '{ this is not json');
  assert.deepEqual(readProvenance(), {});
  // readJsonOrLoud renames the bad bytes aside, so the next write starts clean.
  assert.ok(fs.existsSync(`${FILE}.corrupt`));
  putRecord(record());
  assert.deepEqual(recordFor('demo'), record());
  clean();
});
