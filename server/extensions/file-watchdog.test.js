import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startExtensionFileWatchdog } from './file-watchdog.js';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-extension-files-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const manifest = path.join(dir, 'index.js');
  fs.writeFileSync(manifest, 'export default {}');
  return { dir, manifest };
}

function monitor(t, list, options = {}) {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const errors = [];
  const changes = [];
  const timer = startExtensionFileWatchdog({ list, logError: (msg) => errors.push(msg), onChange: (missing) => changes.push(missing), ...options });
  t.after(() => clearInterval(timer));
  return { errors, changes, tick: () => t.mock.timers.tick(60000) };
}

test('reports missing loaded extension directories once, clears and rearms on recovery', (t) => {
  const { dir, manifest } = fixture(t);
  const m = monitor(t, () => [{ id: 'demo', label: 'Demo', external: true, dir }]);
  m.tick();
  assert.deepEqual(m.changes, []);
  fs.rmSync(dir, { recursive: true });
  m.tick();
  assert.equal(m.errors.length, 1);
  assert.match(m.errors[0], /demo.*missing/i);
  assert.deepEqual(m.changes, [[{ id: 'demo', label: 'Demo' }]]);
  m.tick();
  assert.equal(m.errors.length, 1);
  fs.mkdirSync(dir);
  m.tick();
  assert.equal(m.changes.length, 1, 'directory alone does not restore a missing manifest');
  fs.writeFileSync(manifest, 'export default {}');
  m.tick();
  assert.deepEqual(m.changes.at(-1), []);
  fs.unlinkSync(manifest);
  m.tick();
  assert.equal(m.errors.length, 2);
});

test('checks current installed entries only and uses stat without reading manifests', (t) => {
  let entries = [
    { id: 'builtin', dir: '/does-not-exist' },
    { id: 'quarantined', external: true, quarantine: 'bad manifest', dir: '/does-not-exist' },
    { id: 'demo', external: true, dir: '/installed/demo' },
  ];
  const paths = [];
  const m = monitor(t, () => entries, { stat: (name) => {
    paths.push(name);
    throw Object.assign(new Error('missing'), { code: 'ENOENT' });
  } });
  m.tick();
  assert.deepEqual(paths, ['/installed/demo']);
  assert.deepEqual(m.changes, [[{ id: 'demo', label: 'demo' }]]);
  entries = [];
  m.tick();
  assert.deepEqual(m.changes.at(-1), []);
});

test('does not mistake stat permission errors for missing files', (t) => {
  const { dir } = fixture(t);
  const m = monitor(t, () => [{ id: 'demo', external: true, dir }], { stat: () => {
    throw Object.assign(new Error('denied'), { code: 'EACCES' });
  } });
  m.tick();
  assert.deepEqual(m.changes, []);
  assert.deepEqual(m.errors, []);
});

test('unknown stat errors retain an active incident until recovery is confirmed', (t) => {
  const { dir } = fixture(t);
  let unavailable = true;
  let denied = false;
  const m = monitor(t, () => [{ id: 'demo', external: true, dir }], { stat: (name) => {
    if (unavailable || denied) throw Object.assign(new Error('unavailable'), { code: denied ? 'EACCES' : 'ENOENT' });
    return fs.statSync(name);
  } });
  m.tick();
  assert.equal(m.errors.length, 1);
  unavailable = false;
  denied = true;
  m.tick();
  assert.equal(m.changes.length, 1);
  denied = false;
  m.tick();
  assert.deepEqual(m.changes.at(-1), []);
});
