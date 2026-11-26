import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cliVersion, _resetCliVersionCacheForTests } from './cli-version.js';

test('cliVersion reads x.y.z from --version, caches it, and forgets a failure', async () => {
  _resetCliVersionCacheForTests();
  let runs = 0;
  const execFile = (bin, args, _opts, cb) => { runs += 1; cb(null, `${bin} ${args[0]} 2.1.332 (Claude Code)\n`); };
  assert.equal(await cliVersion('claude', { execFile }), '2.1.332');
  assert.equal(await cliVersion('claude', { execFile }), '2.1.332');
  assert.equal(runs, 1);
  const failing = (_b, _a, _o, cb) => cb(new Error('ENOENT'));
  assert.equal(await cliVersion('nope', { execFile: failing }), null);
  assert.equal(await cliVersion('nope', { execFile: (_b, _a, _o, cb) => cb(null, 'v1.5.18') }), '1.5.18');
});
