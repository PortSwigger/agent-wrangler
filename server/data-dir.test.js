import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { isTestProcess } from './data-dir.js';

const dataDirUrl = pathToFileURL(path.join(import.meta.dirname, 'data-dir.js')).href;

function moduleProbe(fixtureName, testContext = false) {
  const scratch = path.join(import.meta.dirname, '..', '.scratch');
  fs.mkdirSync(scratch, { recursive: true });
  const root = fs.mkdtempSync(path.join(scratch, 'aw-data-dir-test-'));
  fs.mkdirSync(path.join(root, 'tmp'));
  try {
    const home = path.join(root, 'home');
    fs.mkdirSync(home);
    const fixture = path.join(root, fixtureName);
    fs.writeFileSync(fixture, `
      import os from 'node:os';
      const { DATA_DIR } = await import(${JSON.stringify(dataDirUrl)});
      console.log('RESULT ' + JSON.stringify({ DATA_DIR, home: os.homedir(), claude: process.env.CLAUDE_CONFIG_DIR ?? null, codex: process.env.CODEX_HOME ?? null, gemini: process.env.GEMINI_CLI_HOME ?? null }));
    `);
    const env = { ...process.env, HOME: home, TMPDIR: path.join(root, 'tmp') };
    for (const k of ['AW_DATA_DIR', 'AW_TEST_SETUP', 'NODE_TEST_CONTEXT', 'NODE_OPTIONS', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'GEMINI_CLI_HOME']) delete env[k];
    if (testContext) env.NODE_TEST_CONTEXT = 'child-v8';
    const out = execFileSync(process.execPath, [fixture], { env, encoding: 'utf8' });
    const line = out.split('\n').find((l) => l.includes('RESULT '));
    assert.ok(line, `fixture printed no result:\n${out}`);
    assert.deepEqual(fs.readdirSync(home), []);
    return { ...JSON.parse(line.slice(line.indexOf('RESULT ') + 7)), home };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function assertRedirected(r) {
  assert.notEqual(r.DATA_DIR, path.join(r.home, '.agent-wrangler'));
  assert.ok(!r.DATA_DIR.startsWith(r.home), r.DATA_DIR);
  assert.ok(r.claude && !r.claude.startsWith(r.home), 'CLAUDE_CONFIG_DIR redirected');
  assert.ok(r.codex && !r.codex.startsWith(r.home), 'CODEX_HOME redirected');
  assert.ok(r.gemini && !r.gemini.startsWith(r.home), 'GEMINI_CLI_HOME redirected');
}

test('a runner-context module import redirects without a preload', () => {
  assertRedirected(moduleProbe('fixture.mjs', true));
});

test('running a .test.js file directly with node is redirected too', () => {
  assertRedirected(moduleProbe('fixture.test.mjs'));
});

test('an ordinary process still resolves ~/.agent-wrangler', () => {
  const r = moduleProbe('fixture.mjs');
  assert.equal(r.DATA_DIR, path.join(r.home, '.agent-wrangler'));
});

test('isTestProcess reads the runner env, --test flags and a .test.js entry point', () => {
  const plain = { env: {}, execArgv: [], argv: ['node', '/x/server/cli.js'] };
  assert.equal(isTestProcess(plain), false);
  assert.equal(isTestProcess({ ...plain, env: { NODE_TEST_CONTEXT: 'child-v8' } }), true);
  assert.equal(isTestProcess({ ...plain, execArgv: ['--test'] }), true);
  assert.equal(isTestProcess({ ...plain, execArgv: ['--test-isolation=none'] }), true);
  assert.equal(isTestProcess({ ...plain, argv: ['node', '/x/a.test.js'] }), true);
});
