import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const helper = fileURLToPath(new URL('./setup-locale.sh', import.meta.url));
const keys = ['LC_ALL', 'LC_CTYPE', 'LANG', 'LC_TIME', 'LC_NUMERIC'];

function run(t, { settings = {}, locales = ['C', 'POSIX'], encodings = {}, missing = false, listFails = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-locale-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  if (!missing) {
    fs.writeFileSync(path.join(dir, 'locale'), `#!${process.execPath}
      import fs from 'node:fs';
      fs.appendFileSync(process.env.PROBE_LOG, JSON.stringify({ args: process.argv.slice(2), LC_ALL: process.env.LC_ALL }) + '\\n');
      if (process.argv[2] === '-a') {
        if (${listFails}) process.exit(1);
        console.log(${JSON.stringify(locales.join('\n'))});
      } else if (process.argv[2] === 'charmap') {
        const encodings = ${JSON.stringify({ C: 'US-ASCII', POSIX: 'US-ASCII', ...encodings })};
        const encoding = encodings[process.env.LC_ALL];
        if (!encoding) process.exit(1);
        console.log(encoding);
      } else process.exit(1);
    `, { mode: 0o755 });
    fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
  }
  const log = path.join(dir, 'probes');
  const result = spawnSync('/bin/sh', ['-c', '. "$1"; exec "$2" -e "$3"', 'sh', helper,
    process.execPath, `console.log(JSON.stringify(Object.fromEntries(${JSON.stringify(keys)}.map(k => [k, process.env[k] ?? null]))))`], {
    env: { PATH: missing ? dir : `${dir}:/usr/bin:/bin`, PROBE_LOG: log, ...settings },
    encoding: 'utf8', timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr);
  return {
    values: JSON.parse(result.stdout),
    warning: result.stderr,
    probes: fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse) : [],
  };
}

function expected(settings = {}) {
  return Object.fromEntries(keys.map(key => [key, settings[key] ?? null]));
}

for (const { name, settings, effective } of [
  { name: 'LC_ALL overrides non-UTF8 LC_CTYPE and LANG', settings: { LC_ALL: 'all-utf8', LC_CTYPE: 'C', LANG: 'C' }, effective: 'all-utf8' },
  { name: 'LC_CTYPE overrides non-UTF8 LANG', settings: { LC_CTYPE: 'ctype-utf8', LANG: 'C' }, effective: 'ctype-utf8' },
  { name: 'LANG supplies the effective locale', settings: { LANG: 'lang-utf8' }, effective: 'lang-utf8' },
  { name: 'empty higher-precedence variables do not mask LANG', settings: { LC_ALL: '', LC_CTYPE: '', LANG: 'lang-utf8' }, effective: 'lang-utf8' },
]) {
  test(`preserves a working UTF-8 configuration: ${name}`, t => {
    const result = run(t, { settings, encodings: { [effective]: 'UTF-8' } });
    assert.deepEqual(result.values, expected(settings));
    assert.equal(result.warning, '');
    assert.deepEqual(result.probes, [{ args: ['charmap'], LC_ALL: effective }]);
  });
}

for (const settings of [
  { LC_ALL: 'C', LC_CTYPE: 'utf8', LANG: 'utf8' },
  { LC_CTYPE: 'C', LANG: 'utf8' },
  { LANG: 'C' },
]) {
  test(`warns and preserves explicit non-UTF8 ${Object.keys(settings)[0]}`, t => {
    const result = run(t, { settings, encodings: { utf8: 'UTF-8' } });
    assert.deepEqual(result.values, expected(settings));
    assert.match(result.warning, /not a usable UTF-8 locale; preserving it/);
    assert.match(result.warning, new RegExp(`update ${Object.keys(settings)[0]}`));
    assert.equal(result.probes.length, 1);
  });
}

test('warns and preserves an explicitly unavailable UTF-8 locale', t => {
  const settings = { LANG: 'missing.UTF-8' };
  const result = run(t, { settings, locales: ['C.utf8'], encodings: { 'C.utf8': 'UTF-8' } });
  assert.deepEqual(result.values, expected(settings));
  assert.match(result.warning, /LANG=missing.UTF-8.*preserving it/);
});

for (const { name, locales, encodings, chosen } of [
  { name: 'prefers C.utf8 and preserves spelling', locales: ['fr_FR.UTF-8', 'en_US.UTF-8', 'C.utf8'], encodings: { 'fr_FR.UTF-8': 'UTF-8', 'en_US.UTF-8': 'UTF-8', 'C.utf8': 'UTF-8' }, chosen: 'C.utf8' },
  { name: 'uses US English next', locales: ['fr_FR.UTF-8', 'en_US.utf8'], encodings: { 'fr_FR.UTF-8': 'UTF-8', 'en_US.utf8': 'UTF-8' }, chosen: 'en_US.utf8' },
  { name: 'uses another installed UTF8 locale', locales: ['C', 'fr_FR.UTF-8'], encodings: { 'fr_FR.UTF-8': 'UTF-8' }, chosen: 'fr_FR.UTF-8' },
  { name: 'validates encoding rather than trusting a UTF8 name', locales: ['C.UTF-8', 'en_US.UTF-8', 'utf8-alias'], encodings: { 'C.UTF-8': 'US-ASCII', 'utf8-alias': 'UTF8' }, chosen: 'utf8-alias' },
]) {
  test(`unconfigured locale ${name}`, t => {
    const settings = { LC_TIME: 'custom-time', LC_NUMERIC: 'custom-numbers' };
    const result = run(t, { settings, locales, encodings });
    assert.deepEqual(result.values, expected({ ...settings, LC_CTYPE: chosen }));
    assert.equal(result.warning, '');
    assert.deepEqual(result.probes[0], { args: ['-a'], LC_ALL: 'C' });
  });
}

test('empty locale variables allow a default while preserving unrelated settings', t => {
  const settings = { LC_ALL: '', LC_CTYPE: '', LANG: '', LC_TIME: 'C' };
  const result = run(t, { settings, locales: ['C.UTF-8'], encodings: { 'C.UTF-8': 'UTF-8' } });
  assert.deepEqual(result.values, expected({ ...settings, LC_CTYPE: 'C.UTF-8' }));
  assert.equal(result.warning, '');
});

for (const scenario of [
  { name: 'no usable UTF-8 locale', locales: ['C', 'POSIX'] },
  { name: 'an empty locale list', locales: [] },
  { name: 'a failing locale list', listFails: true },
]) {
  test(`warns and does not invent a locale with ${scenario.name}`, t => {
    const result = run(t, scenario);
    assert.deepEqual(result.values, expected());
    assert.match(result.warning, /no usable installed UTF-8 locale/);
    assert.match(result.warning, /Install or generate.*LC_CTYPE/);
  });
}

test('a missing locale utility warns and leaves settings unchanged', t => {
  const settings = { LANG: 'user-locale', LC_NUMERIC: 'numbers' };
  const result = run(t, { missing: true, settings });
  assert.deepEqual(result.values, expected(settings));
  assert.match(result.warning, /locale utility not found/);
  assert.match(result.warning, /Install locale support.*LC_CTYPE/);
});
