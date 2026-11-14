import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { isTestProcess } from './data-dir.js';

const dataDirUrl = pathToFileURL(path.join(import.meta.dirname, 'data-dir.js')).href;

// Runs a fixture the way an agent would, WITHOUT test-setup.js, under a fake HOME
// so even a regression here cannot reach this machine's real ~/.agent-wrangler.
function bareRun(args, fixtureName) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-data-dir-test-'));
  try {
    const home = path.join(root, 'home');
    fs.mkdirSync(home);
    const fixture = path.join(root, fixtureName);
    fs.writeFileSync(fixture, `
      import os from 'node:os';
      const { DATA_DIR } = await import(${JSON.stringify(dataDirUrl)});
      console.log('RESULT ' + JSON.stringify({ DATA_DIR, home: os.homedir(), claude: process.env.CLAUDE_CONFIG_DIR ?? null, codex: process.env.CODEX_HOME ?? null }));
    `);
    const env = { ...process.env, HOME: home };
    for (const k of ['AW_DATA_DIR', 'AW_TEST_SETUP', 'NODE_TEST_CONTEXT', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'GEMINI_CLI_HOME']) delete env[k];
    const out = execFileSync(process.execPath, [...args, fixture], { env, encoding: 'utf8' });
    const line = out.split('\n').find((l) => l.includes('RESULT '));
    assert.ok(line, `fixture printed no result:\n${out}`);
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
}

test('a bare node --test run gets a throwaway data dir, not ~/.agent-wrangler', () => {
  assertRedirected(bareRun(['--test', '--test-reporter=tap'], 'fixture.test.mjs'));
});

test('running a .test.js file directly with node is redirected too', () => {
  assertRedirected(bareRun([], 'fixture.test.mjs'));
});

test('an ordinary process still resolves ~/.agent-wrangler', () => {
  const r = bareRun([], 'fixture.mjs');
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
