import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureCodexTrust, hasDuplicateHeader } from './codex-trust.js';

function withCodexHome(fn) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-trust-test-')));
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo);
  const prev = process.env.CODEX_HOME;
  process.env.CODEX_HOME = dir;
  try {
    return fn(dir, path.join(dir, 'config.toml'), repo);
  } finally {
    if (prev === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('ensureCodexTrust: creates config.toml with a trust entry when none exists', () => {
  withCodexHome((home, file, repo) => {
    ensureCodexTrust(repo);
    const text = fs.readFileSync(file, 'utf8');
    assert.ok(text.includes(`[projects.${JSON.stringify(repo)}]`));
    assert.match(text, /trust_level = "trusted"/);
  });
});

test('ensureCodexTrust: appends onto an existing config.toml without touching prior content', () => {
  withCodexHome((home, file, repo) => {
    fs.writeFileSync(file, '[some_unrelated]\nfoo = "bar"\n');
    ensureCodexTrust(repo);
    const text = fs.readFileSync(file, 'utf8');
    assert.match(text, /\[some_unrelated\]\nfoo = "bar"/);
    assert.ok(text.includes(`[projects.${JSON.stringify(repo)}]\ntrust_level = "trusted"`));
  });
});

test('ensureCodexTrust: is a no-op when the exact path is already trusted', () => {
  withCodexHome((home, file, repo) => {
    ensureCodexTrust(repo);
    const before = fs.readFileSync(file, 'utf8');
    ensureCodexTrust(repo);
    const after = fs.readFileSync(file, 'utf8');
    assert.equal(after, before);
  });
});

test('ensureCodexTrust: a different path gets its own entry alongside an existing one', () => {
  withCodexHome((home, file, repo) => {
    const other = path.join(home, 'other');
    fs.mkdirSync(other);
    ensureCodexTrust(repo);
    ensureCodexTrust(other);
    const text = fs.readFileSync(file, 'utf8');
    assert.ok(text.includes(`[projects.${JSON.stringify(repo)}]`));
    assert.ok(text.includes(`[projects.${JSON.stringify(other)}]`));
  });
});

test('ensureCodexTrust: no-ops on a missing/absent dirPath', () => {
  withCodexHome((home, file, repo) => {
    ensureCodexTrust('');
    ensureCodexTrust(undefined);
    assert.equal(fs.existsSync(file), false);
  });
});

test('ensureCodexTrust: escapes a path containing double quotes', () => {
  withCodexHome((home, file, repo) => {
    const quoted = path.join(repo, 'with "quotes"');
    fs.mkdirSync(quoted);
    ensureCodexTrust(quoted);
    const text = fs.readFileSync(file, 'utf8');
    assert.equal(text, `[projects.${JSON.stringify(quoted)}]\ntrust_level = "trusted"\n`);
  });
});

test('ensureCodexTrust: a duplicate header ALREADY present before this call (unrelated to dirPath) throws without claiming to have fixed it, and leaves our own block in place', () => {
  withCodexHome((home, file, repo) => {
    // Pre-existing corruption for a DIFFERENT path — config.toml was already
    // unloadable before this call touched it. Undoing our own (non-colliding)
    // block can't fix that, so this must say so rather than claim a repair.
    const corrupt = '[projects."/A"]\ntrust_level = "trusted"\n\n[projects."/A"]\ntrust_level = "trusted"\n';
    fs.writeFileSync(file, corrupt);

    assert.throws(() => ensureCodexTrust(repo), /already had a duplicate.*BEFORE this launch/s);

    const after = fs.readFileSync(file, 'utf8');
    assert.ok(after.includes(`[projects.${JSON.stringify(repo)}]`)); // our own block is left in place — it did no additional harm
    assert.equal(after.startsWith(corrupt), true); // pre-existing corruption untouched

    const dir = fs.readdirSync(home);
    assert.ok(dir.some((f) => f.startsWith('config.toml.wrangler-broken-')));
  });
});

test('ensureCodexTrust: a genuine collision on the SAME key (a concurrent writer lands our exact header mid-append) throws and removes exactly the copy this call added', () => {
  withCodexHome((home, file, repo) => {
    fs.writeFileSync(file, '[some_unrelated]\nfoo = "bar"\n');
    const realAppend = fs.appendFileSync;
    let intercepted = false;
    // Patches the real fs module for the duration of this call only (restored
    // in `finally` before the next assertion runs). Safe here because every
    // test in this file is synchronous and `node --test` gives this file its
    // own process — nothing else can observe the patched fs mid-call.
    fs.appendFileSync = (p, data, ...rest) => {
      if (!intercepted && p === file) {
        intercepted = true;
        // Simulate another process's write of the IDENTICAL block landing
        // between our no-op check and our own append.
        realAppend(p, data, ...rest);
      }
      return realAppend(p, data, ...rest);
    };
    try {
      assert.throws(() => ensureCodexTrust(repo), /Retry the launch/);
    } finally {
      fs.appendFileSync = realAppend;
    }

    const after = fs.readFileSync(file, 'utf8');
    assert.equal(hasDuplicateHeader(after), false);
    assert.ok(after.includes(`[projects.${JSON.stringify(repo)}]`));

    const dir = fs.readdirSync(home);
    assert.ok(dir.some((f) => f.startsWith('config.toml.wrangler-broken-')));
  });
});

for (const first of ['alias', 'realpath']) {
  test(`ensureCodexTrust: symlink and realpath calls share one canonical entry (${first} first)`, () => {
    withCodexHome((home, file, repo) => {
      const alias = path.join(home, 'alias');
      fs.symlinkSync(repo, alias, 'dir');
      const dirs = first === 'alias' ? [alias, repo] : [repo, alias];
      for (const dir of dirs) ensureCodexTrust(dir);
      assert.equal(fs.readFileSync(file, 'utf8'), `[projects.${JSON.stringify(repo)}]\ntrust_level = "trusted"\n`);
    });
  });
}

test('ensureCodexTrust: symlink preserves pre-existing canonical trust without writing', () => {
  withCodexHome((home, file, repo) => {
    const alias = path.join(home, 'alias');
    fs.symlinkSync(repo, alias, 'dir');
    const before = `model = "example"\n\n[projects.${JSON.stringify(repo)}]\ntrust_level = "trusted"\n`;
    fs.writeFileSync(file, before);
    ensureCodexTrust(alias);
    ensureCodexTrust(repo);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
  });
});

test('ensureCodexTrust: an unresolvable directory throws without writing config', () => {
  withCodexHome((home, file) => {
    assert.throws(() => ensureCodexTrust(path.join(home, 'missing')), { code: 'ENOENT' });
    assert.equal(fs.existsSync(file), false);
  });
});
