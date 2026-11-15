import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkRef, openLocation, locationIdleMs, checkTranscript, analyzeAtLocation, withLocationReads,
  checkCodexId, checkDiff, locationDiff, MAX_TRANSCRIPT_CHARS, MAX_DIFF_CHARS, MAX_REF_BYTES,
} from './index.js';

const rt = (location, over = {}) => ({ id: 'r', label: 'R', location, ...over });
const DIFF = 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n';

test('a provisioned ref is stored as its JSON round-trip, and refused when missing, unserialisable or too big', () => {
  assert.deepEqual(checkRef({ a: 1, b: undefined }, rt({})), { a: 1 });
  assert.throws(() => checkRef(undefined, rt({})), /returned no JSON-able ref/);
  assert.throws(() => checkRef(null, rt({})), /returned no JSON-able ref/);
  const loop = {}; loop.self = loop;
  assert.throws(() => checkRef(loop, rt({})), /returned no JSON-able ref/);
  assert.throws(() => checkRef({ s: 'x'.repeat(MAX_REF_BYTES) }, rt({})), /larger than 16384 bytes/);
});

test('open may name an absolute cwd; anything else fails the launch', async () => {
  const at = (answer) => openLocation(rt({ open: async () => answer }), { location: {} }, 'dispatch');
  assert.deepEqual(await at(undefined), {});
  assert.deepEqual(await at({}), {});
  assert.deepEqual(await at({ cwd: '/work/a' }), { cwd: '/work/a' });
  await assert.rejects(at({ cwd: 'work' }), /unusable cwd/);
  await assert.rejects(at({ cwd: '/a\nrm -rf /' }), /unusable cwd/);
  await assert.rejects(at({ cwd: `/${'a'.repeat(5000)}` }), /unusable cwd/);
  await assert.rejects(at('/work'), /must return an object or nothing/);
  await assert.rejects(openLocation(rt({ open: async () => { throw new Error('down'); } }), { location: {} }, 'resume'), /could not open this session's location: down/);
  assert.deepEqual(await openLocation(rt({}), { location: {} }, 'fork'), {});
});

test('a location\'s own idle threshold wins; 0 turns it off; a bad answer falls back', () => {
  const entry = { location: {} };
  assert.equal(locationIdleMs(rt({}), entry, 5), 5);
  assert.equal(locationIdleMs(rt({ suspendIdleHours: 2 }), entry, 5), 2 * 3600_000);
  assert.equal(locationIdleMs(rt({ suspendIdleHours: 0 }), entry, 5), null);
  assert.equal(locationIdleMs(rt({ suspendIdleHours: () => 0.5 }), entry, 5), 1800_000);
  assert.equal(locationIdleMs(rt({ suspendIdleHours: () => 'soon' }), entry, 5), 5);
  assert.equal(locationIdleMs(rt({ suspendIdleHours: () => { throw new Error('x'); } }), entry, 5), 5);
});

test('an oversized or malformed transcript is rejected', async () => {
  assert.equal(checkTranscript(null), null);
  assert.equal(checkTranscript('{"a":1}'), '{"a":1}');
  assert.equal(checkTranscript({ lines: [] }), null);
  assert.equal(checkTranscript(['{}']), null);
  assert.equal(checkTranscript('x'.repeat(MAX_TRANSCRIPT_CHARS + 1)), null);
  const huge = rt({ transcript: async () => 'x'.repeat(MAX_TRANSCRIPT_CHARS + 1) });
  assert.equal(await analyzeAtLocation(huge, { location: {} }, 'sid'), null);
  const wrong = rt({ transcript: async () => 42 });
  assert.equal(await analyzeAtLocation(wrong, { location: {} }, 'sid'), null);
  const throws = rt({ transcript: async () => { throw new Error('gone'); } });
  assert.equal(await analyzeAtLocation(throws, { location: {} }, 'sid'), null);
});

test('location reads never fall back to this machine, and a suspended card shows what was recorded', async () => {
  const reads = withLocationReads(rt({}));
  assert.equal(await reads.readLive({ entry: { location: {} } }), null);
  assert.equal(await reads.analyze({ entry: { location: {} }, liveSid: 'x' }), null);
  const recorded = { usd: 1.5, aiTitle: 'T' };
  assert.equal(await reads.analyze({ entry: { location: {}, suspendedAt: 1, suspendedCard: recorded } }), recorded);
  const own = withLocationReads(rt({}, { analyze: async () => ({ usd: 9 }), readLive: async () => ({ status: 'idle' }) }));
  assert.deepEqual(await own.analyze({ entry: { location: {} } }), { usd: 9 });
  assert.deepEqual(await own.readLive({ entry: { location: {} } }), { status: 'idle' });
  const host = { id: 'local' };
  assert.equal(withLocationReads(host), host);
});

test('a Codex conversation id must look like one', () => {
  assert.equal(checkCodexId(null), null);
  assert.equal(checkCodexId('019a2b3c-4d5e-7f00-8a9b-0c1d2e3f4a5b'), '019a2b3c-4d5e-7f00-8a9b-0c1d2e3f4a5b');
  assert.equal(checkCodexId('../../etc/passwd'), null);
  assert.equal(checkCodexId('a b'), null);
  assert.equal(checkCodexId('x'.repeat(129)), null);
  assert.equal(checkCodexId({ id: 'abc' }), null);
  assert.equal(checkCodexId('abc', new Set(['abc'])), null);
});

test('a diff is parsed and capped; a malformed one is an error; an oversized one is cut at a line', async () => {
  assert.deepEqual(checkDiff(null), { state: 'not-a-repo' });
  assert.equal(checkDiff('just text').state, 'error');
  assert.equal(checkDiff({ diff: 42 }).state, 'error');
  assert.equal(checkDiff({ diff: '' }).state, 'empty');
  const ok = checkDiff({ diff: DIFF, baseRef: 'origin/main', dir: '/work/widgets' });
  assert.equal(ok.state, 'ok');
  assert.equal(ok.files[0].path, 'x');
  assert.equal(ok.baseRef, 'origin/main');
  assert.deepEqual(ok.location, { dir: '/work/widgets' });
  assert.equal(checkDiff({ diff: DIFF, baseRef: 'a\nb', dir: 7 }).baseRef, undefined);
  const lines = checkDiff({ diff: DIFF + Array.from({ length: 50 }, (_, i) => `+l${i}`).join('\n') }, { lineCap: 10 });
  assert.equal(lines.state, 'ok');
  assert.ok(lines.truncated.droppedLines > 0);
  const big = `diff --git a/b b/b\n--- a/b\n+++ b/b\n@@ -0,0 +1,1 @@\n${'+y\n'.repeat(MAX_DIFF_CHARS / 3 + 10)}`;
  const cut = checkDiff({ diff: big }, { lineCap: 100 });
  assert.equal(cut.state, 'ok');
  assert.ok(cut.truncated.droppedLines > 10);
  assert.equal((await locationDiff(rt({}), { location: {} }, 'working-tree')).state, 'error');
  assert.match((await locationDiff(rt({ diff: async () => { throw new Error('ssh down'); } }), { location: {} }, 'branch')).error, /ssh down/);
});
