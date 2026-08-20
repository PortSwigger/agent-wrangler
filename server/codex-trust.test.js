import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureCodexTrust, hasDuplicateHeader } from './codex-trust.js';

function withCodexHome(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-trust-test-'));
  const prev = process.env.CODEX_HOME;
  process.env.CODEX_HOME = dir;
  try {
    return fn(dir, path.join(dir, 'config.toml'));
  } finally {
    if (prev === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('ensureCodexTrust: creates config.toml with a trust entry when none exists', () => {
  withCodexHome((home, file) => {
    ensureCodexTrust('/repo');
    const text = fs.readFileSync(file, 'utf8');
    assert.match(text, /\[projects\."\/repo"\]/);
    assert.match(text, /trust_level = "trusted"/);
  });
});

test('ensureCodexTrust: appends onto an existing config.toml without touching prior content', () => {
  withCodexHome((home, file) => {
    fs.writeFileSync(file, '[some_unrelated]\nfoo = "bar"\n');
    ensureCodexTrust('/repo');
    const text = fs.readFileSync(file, 'utf8');
    assert.match(text, /\[some_unrelated\]\nfoo = "bar"/);
    assert.match(text, /\[projects\."\/repo"\]\ntrust_level = "trusted"/);
  });
});

test('ensureCodexTrust: is a no-op when the exact path is already trusted', () => {
  withCodexHome((home, file) => {
    ensureCodexTrust('/repo');
    const before = fs.readFileSync(file, 'utf8');
    ensureCodexTrust('/repo');
    const after = fs.readFileSync(file, 'utf8');
    assert.equal(after, before);
  });
});

test('ensureCodexTrust: a different path gets its own entry alongside an existing one', () => {
  withCodexHome((home, file) => {
    ensureCodexTrust('/repo-a');
    ensureCodexTrust('/repo-b');
    const text = fs.readFileSync(file, 'utf8');
    assert.match(text, /\[projects\."\/repo-a"\]/);
    assert.match(text, /\[projects\."\/repo-b"\]/);
  });
});

test('ensureCodexTrust: no-ops on a missing/absent dirPath', () => {
  withCodexHome((home, file) => {
    ensureCodexTrust('');
    ensureCodexTrust(undefined);
    assert.equal(fs.existsSync(file), false);
  });
});

test('ensureCodexTrust: escapes a path containing double quotes', () => {
  withCodexHome((home, file) => {
    ensureCodexTrust('/repo/with "quotes"');
    const text = fs.readFileSync(file, 'utf8');
    assert.match(text, /\[projects\."\/repo\/with \\"quotes\\""\]/);
  });
});

test('ensureCodexTrust: a duplicate header ALREADY present before this call (unrelated to dirPath) throws without claiming to have fixed it, and leaves our own block in place', () => {
  withCodexHome((home, file) => {
    // Pre-existing corruption for a DIFFERENT path — config.toml was already
    // unloadable before this call touched it. Undoing our own (non-colliding)
    // block can't fix that, so this must say so rather than claim a repair.
    const corrupt = '[projects."/A"]\ntrust_level = "trusted"\n\n[projects."/A"]\ntrust_level = "trusted"\n';
    fs.writeFileSync(file, corrupt);

    assert.throws(() => ensureCodexTrust('/B'), /already had a duplicate.*BEFORE this launch/s);

    const after = fs.readFileSync(file, 'utf8');
    assert.match(after, /\/B/); // our own block is left in place — it did no additional harm
    assert.equal(after.startsWith(corrupt), true); // pre-existing corruption untouched

    const dir = fs.readdirSync(home);
    assert.ok(dir.some((f) => f.startsWith('config.toml.wrangler-broken-')));
  });
});

test('ensureCodexTrust: a genuine collision on the SAME key (a concurrent writer lands our exact header mid-append) throws and removes exactly the copy this call added', () => {
  withCodexHome((home, file) => {
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
      assert.throws(() => ensureCodexTrust('/repo'), /Retry the launch/);
    } finally {
      fs.appendFileSync = realAppend;
    }

    const after = fs.readFileSync(file, 'utf8');
    assert.equal(hasDuplicateHeader(after), false);
    assert.match(after, /\[projects\."\/repo"\]/); // exactly one copy survives — /repo IS trusted

    const dir = fs.readdirSync(home);
    assert.ok(dir.some((f) => f.startsWith('config.toml.wrangler-broken-')));
  });
});
