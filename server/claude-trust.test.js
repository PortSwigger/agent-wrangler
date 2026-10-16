import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureClaudeTrust } from './claude-trust.js';

function withTemp(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-trust-test-'));
  try {
    return fn(path.join(dir, '.claude.json'), dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const quiet = () => {};

test('ensureClaudeTrust: creates the file with a trusted entry when none exists', () => {
  withTemp((file) => {
    assert.equal(ensureClaudeTrust('/s', { file, log: quiet }), true);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { projects: { '/s': { hasTrustDialogAccepted: true } } });
  });
});

test('ensureClaudeTrust: keeps other keys, other projects, indent, trailing newline and mode', () => {
  withTemp((file) => {
    const orig = { numStartups: 3, projects: { '/a': { hasTrustDialogAccepted: false, allowedTools: ['x'] } }, theme: 'dark' };
    fs.writeFileSync(file, JSON.stringify(orig, null, 2) + '\n', { mode: 0o600 });
    fs.chmodSync(file, 0o600);
    ensureClaudeTrust('/s', { file, log: quiet });
    const text = fs.readFileSync(file, 'utf8');
    assert.deepEqual(JSON.parse(text), { ...orig, projects: { ...orig.projects, '/s': { hasTrustDialogAccepted: true } } });
    assert.ok(text.endsWith('}\n'));
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ['.claude.json'], 'no temp file left behind');
  });
});

test('ensureClaudeTrust: flips an existing false entry without dropping its other fields', () => {
  withTemp((file) => {
    fs.writeFileSync(file, JSON.stringify({ projects: { '/s': { hasTrustDialogAccepted: false, allowedTools: ['x'] } } }));
    ensureClaudeTrust('/s', { file, log: quiet });
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).projects['/s'], { hasTrustDialogAccepted: true, allowedTools: ['x'] });
  });
});

test('ensureClaudeTrust: an already-trusted file is left byte-identical (no write)', () => {
  withTemp((file) => {
    const text = '{"projects":{"/s":{"hasTrustDialogAccepted":true}},   "odd":   1}';
    fs.writeFileSync(file, text);
    const past = new Date(2020, 0, 1);
    fs.utimesSync(file, past, past);
    assert.equal(ensureClaudeTrust('/s', { file, log: quiet }), true);
    assert.equal(fs.readFileSync(file, 'utf8'), text);
    assert.equal(fs.statSync(file).mtimeMs, past.getTime());
  });
});

test('ensureClaudeTrust: malformed JSON is skipped with a log and the file is untouched', () => {
  withTemp((file) => {
    const text = '{"projects": {"/a": ';
    fs.writeFileSync(file, text);
    const logs = [];
    assert.equal(ensureClaudeTrust('/s', { file, log: (m) => logs.push(m) }), false);
    assert.equal(fs.readFileSync(file, 'utf8'), text);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /\[claude-trust\] skipped trusting \/s/);
  });
});

test('ensureClaudeTrust: a non-object root or projects is skipped, not clobbered', () => {
  withTemp((file) => {
    for (const text of ['[]', 'null', '{"projects":[]}', '{"projects":"x"}']) {
      fs.writeFileSync(file, text);
      assert.equal(ensureClaudeTrust('/s', { file, log: quiet }), false);
      assert.equal(fs.readFileSync(file, 'utf8'), text);
    }
  });
});

test('ensureClaudeTrust: no-ops on a missing dirPath', () => {
  withTemp((file) => {
    assert.equal(ensureClaudeTrust('', { file, log: quiet }), false);
    assert.equal(fs.existsSync(file), false);
  });
});
