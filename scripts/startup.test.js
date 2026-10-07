import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const sourceRoot = fileURLToPath(new URL('../', import.meta.url));

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-startup-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const dir of ['bin', 'scripts', 'server', 'node_modules/.bin', 'home', 'logs', 'brew node/bin']) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
  }
  for (const file of ['bin/agent-wrangler', 'scripts/wrangler-start.sh', 'scripts/sync-deps.sh', 'scripts/trim-service-logs.sh', 'scripts/setup-locale.sh']) {
    fs.copyFileSync(path.join(sourceRoot, file), path.join(root, file));
  }
  const node = path.join(root, 'brew node/bin/node');
  fs.symlinkSync(process.execPath, node);
  fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
  fs.writeFileSync(path.join(root, 'package-lock.json'), '{}');
  const env = {
    HOME: path.join(root, 'home'),
    PATH: '/usr/bin:/bin',
    AW_NODE: node,
    AW_LOG_DIR: path.join(root, 'logs'),
    AW_LOG_MAX_BYTES: '256',
  };
  return { root, env };
}

function run(root, env, file = 'bin/agent-wrangler') {
  return spawnSync(path.join(root, file), [], {
    cwd: root, env, encoding: 'utf8', timeout: 10000,
  });
}

test('AW_NODE supplies Node to child tools on a bare service PATH', t => {
  const { root, env } = fixture(t);
  fs.writeFileSync(path.join(root, 'node_modules/.bin/devcontainer'),
    '#!/usr/bin/env node\nconsole.log(process.execPath);\n', { mode: 0o755 });
  fs.writeFileSync(path.join(root, 'server/cli.js'), `
    import { spawnSync } from 'node:child_process';
    const child = spawnSync('devcontainer', ['--version'], { encoding: 'utf8' });
    process.stdout.write(child.stdout || '');
    process.stderr.write(child.stderr || '');
    process.exit(child.status ?? 1);
  `);
  const result = run(root, env);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), fs.realpathSync(process.execPath));
});

test('AW_NODE fallback preserves the Node already on the user PATH', t => {
  const { root, env } = fixture(t);
  const userBin = path.join(root, 'user-bin');
  fs.mkdirSync(userBin);
  fs.writeFileSync(path.join(userBin, 'node'), '#!/bin/sh\necho user-node\n', { mode: 0o755 });
  fs.writeFileSync(path.join(root, 'server/cli.js'), `
    import { execFileSync } from 'node:child_process';
    process.stdout.write(execFileSync('node', ['--version'], { encoding: 'utf8' }));
  `);
  const result = run(root, { ...env, PATH: `${userBin}:${env.PATH}` });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'user-node');
});

function oversizedLogs(root) {
  return ['wrangler.log', 'wrangler.err'].map(name => {
    const file = path.join(root, 'logs', name);
    fs.writeFileSync(file, 'old history\n'.repeat(100) + 'recent tail\n');
    return { file, ino: fs.statSync(file).ino };
  });
}

function assertTrimmed(logs) {
  for (const { file, ino } of logs) {
    assert.equal(fs.statSync(file).ino, ino, 'preserve the supervisor log inode');
    const text = fs.readFileSync(file, 'utf8');
    assert.ok(Buffer.byteLength(text) < 512, 'keep a bounded tail and trim marker');
    assert.match(text, /recent tail/);
    assert.equal(text.match(/log trimmed at startup/g)?.length, 1, 'trim once per start');
  }
}

test('checkout service trims logs even when npm ci fails and does not start the server', t => {
  const { root, env } = fixture(t);
  const logs = oversizedLogs(root);
  fs.writeFileSync(path.join(root, 'bin/npm'), '#!/bin/sh\necho dependency-sync-failed >&2\nexit 42\n', { mode: 0o755 });
  fs.writeFileSync(path.join(root, 'server/cli.js'), 'console.log("server-started");');
  const result = run(root, { ...env, PATH: `${root}/bin:${env.PATH}` }, 'scripts/wrangler-start.sh');
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /dependency-sync-failed/);
  assert.doesNotMatch(result.stdout, /server-started/);
  assertTrimmed(logs);
});

test('checkout service trims logs once before handing off to the launcher', t => {
  const { root, env } = fixture(t);
  const logs = oversizedLogs(root);
  fs.writeFileSync(path.join(root, 'bin/npm'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(root, 'server/cli.js'), 'console.log("server-started");');
  const result = run(root, { ...env, PATH: `${root}/bin:${env.PATH}` }, 'scripts/wrangler-start.sh');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /server-started/);
  assertTrimmed(logs);
});

for (const supervised of [false, true]) {
  test(`direct launcher ${supervised ? 'trims supervised' : 'preserves interactive'} logs`, t => {
    const { root, env } = fixture(t);
    const logs = oversizedLogs(root);
    fs.writeFileSync(path.join(root, 'server/cli.js'), 'console.log("server-started");');
    const result = run(root, { ...env, ...(supervised ? { AW_SUPERVISED: '1' } : {}) });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /server-started/);
    if (supervised) assertTrimmed(logs);
    else for (const { file } of logs) assert.ok(fs.statSync(file).size > 1000);
  });
}
