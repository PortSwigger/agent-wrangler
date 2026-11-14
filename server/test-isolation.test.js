import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const modules = ['data-dir.js', 'styles.js', 'claude-paths.js', 'claude-socket.js', 'codex-trust.js', 'claude-trust.js', 'agents/codex-discover.js', 'agents/codex-rollout.js', 'search/corpus.js', 'usage-report.js'];

function probe(imports, { entryPoint = 'fixture.mjs', inheritedSetup = false, testContext = true, unsafeDataDir = false, isolatedEnvironment = false, symlinkedDataDir = false } = {}) {
  const scratch = path.join(import.meta.dirname, '..', '.scratch');
  fs.mkdirSync(scratch, { recursive: true });
  const root = fs.mkdtempSync(path.join(scratch, 'aw-isolation-test-'));
  fs.mkdirSync(path.join(root, 'tmp'));
  try {
    const home = path.join(root, isolatedEnvironment ? 'tmp/home' : 'home');
    fs.mkdirSync(home);
    const fixture = path.join(root, entryPoint);
    fs.writeFileSync(fixture, `${imports.map((file, i) => `import * as m${i} from ${JSON.stringify(pathToFileURL(path.join(import.meta.dirname, file)).href)};`).join('\n')}
      import os from 'node:os';
      import fs from 'node:fs';
      for (const dir of [${imports.map((_, i) => `m${i}.DATA_DIR, m${i}.CUSTOM_STYLES_DIR`).join(',')}].filter(Boolean)) {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(dir + '/probe', 'isolated');
      }
      console.log('RESULT ' + JSON.stringify({ paths: [${imports.map((_, i) => `m${i}.CUSTOM_STYLES_DIR, m${i}.CLAUDE_DIR, m${i}.DATA_DIR`).join(',')}], home: os.homedir(), dirs: ['AW_DATA_DIR', 'CODEX_HOME', 'GEMINI_CLI_HOME', 'CLAUDE_CONFIG_DIR'].map(k => process.env[k]) }));
    `);
    const env = { ...process.env, HOME: home, TMPDIR: path.join(root, 'tmp') };
    for (const key of ['AW_DATA_DIR', 'AW_TEST_SETUP', 'NODE_TEST_CONTEXT', 'NODE_OPTIONS', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'GEMINI_CLI_HOME']) delete env[key];
    if (testContext) env.NODE_TEST_CONTEXT = 'child-v8';
    if (inheritedSetup) env.AW_TEST_SETUP = '1';
    if (isolatedEnvironment) {
      env.AW_TEST_SETUP = '1';
      for (const key of ['AW_DATA_DIR', 'CODEX_HOME', 'GEMINI_CLI_HOME', 'CLAUDE_CONFIG_DIR']) {
        env[key] = path.join(root, 'tmp', key);
        fs.mkdirSync(env[key]);
      }
    }
    if (symlinkedDataDir) {
      const protectedDir = path.join(root, 'protected-data');
      fs.mkdirSync(protectedDir);
      fs.rmdirSync(env.AW_DATA_DIR);
      fs.symlinkSync(protectedDir, env.AW_DATA_DIR);
    }
    if (unsafeDataDir) env.AW_DATA_DIR = path.join(home, '.agent-wrangler');
    const output = execFileSync(process.execPath, [fixture], { cwd: root, env, encoding: 'utf8' });
    const line = output.split('\n').find(l => l.includes('RESULT '));
    const result = JSON.parse(line.slice(line.indexOf('RESULT ') + 7));
    if (isolatedEnvironment && !symlinkedDataDir) assert.equal(result.home, home, 'safe child homes must be preserved');
    else assert.notEqual(result.home, home, 'HOME must be isolated before homedir-based modules run');
    for (const dir of [...result.dirs, ...result.paths.filter(Boolean)]) {
      assert.ok(dir && !dir.startsWith(home), `home remained unprotected: ${dir}`);
      assert.ok(dir.startsWith(path.join(root, 'tmp') + path.sep), `path escaped temporary root: ${dir}`);
    }
    if (isolatedEnvironment && !symlinkedDataDir) assert.equal(result.paths.find(Boolean), env.AW_DATA_DIR);
    if (symlinkedDataDir) assert.deepEqual(fs.readdirSync(path.join(root, 'protected-data')), []);
    assert.deepEqual(fs.readdirSync(home), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

for (const module of modules) {
  test(`bare imports isolate homes for ${module}`, () => probe([module]));
}
test('static sibling imports finish setup before computing paths', () => probe(modules));
test('direct test-file module probe isolates homes', () => probe(['styles.js'], { entryPoint: 'fixture.test.mjs', testContext: false }));
test('an inherited setup marker cannot bypass isolation', () => probe(['data-dir.js'], { inheritedSetup: true }));
test('an explicit home data directory is replaced in a test process', () => probe(['data-dir.js'], { unsafeDataDir: true }));
test('a child with verified temporary homes keeps its fixture data directory', () => probe(['data-dir.js'], { isolatedEnvironment: true }));
test('an inherited data directory symlink escaping the temporary root is replaced', () => probe(['data-dir.js'], { isolatedEnvironment: true, symlinkedDataDir: true }));
