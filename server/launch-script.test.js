import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { paneCommand, INLINE_COMMAND_LIMIT } from './launch-script.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aw-launch-script-'));
}

test('a normal-sized launch command still goes to tmux verbatim (no file)', () => {
  const dir = tmpDir();
  const cmd = "cd '/repo' && claude --session-id X -- 'fix the bug'";
  assert.equal(paneCommand('cc_abc', cmd, { dir }), cmd);
  assert.deepEqual(fs.readdirSync(dir), []); // no script written for the common path
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an oversized launch command moves into a sourced script, keeping tmux\'s command tiny', () => {
  const dir = tmpDir();
  // tmux rejects a single command over ~16 KB ("command too long"), which is exactly
  // what a long first prompt pasted into the dispatch dialog produced.
  const cmd = `claude -- '${'p'.repeat(40_000)}'`;
  const paneCmd = paneCommand('cc_abc', cmd, { dir });
  const file = path.join(dir, 'cc_abc.sh');
  assert.equal(paneCmd, `. '${file}'`);
  assert.ok(paneCmd.length < 200, 'the command tmux sees must be a short fixed-length path');
  assert.equal(fs.readFileSync(file, 'utf8'), `${cmd}\n`);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600); // the prompt text isn't world-readable
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the inline limit leaves headroom under tmux\'s 16 KB cap', () => {
  assert.ok(INLINE_COMMAND_LIMIT < 16_384);
});

test('the threshold is measured in BYTES, not characters (a multi-byte prompt still fits tmux)', () => {
  const dir = tmpDir();
  // Just under the limit in characters but well over it in UTF-8 bytes — the naive
  // .length check would have sent this inline and hit "command too long" anyway.
  const cmd = `claude -- '${'あ'.repeat(INLINE_COMMAND_LIMIT - 100)}'`;
  assert.ok(cmd.length < INLINE_COMMAND_LIMIT * 1.1 && Buffer.byteLength(cmd) > INLINE_COMMAND_LIMIT);
  assert.match(paneCommand('cc_abc', cmd, { dir }), /^\. '/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('relaunching the same session overwrites its own script rather than leaving another', () => {
  const dir = tmpDir();
  paneCommand('cc_abc', `claude -- '${'a'.repeat(40_000)}'`, { dir });
  paneCommand('cc_abc', `claude --resume -- '${'b'.repeat(40_000)}'`, { dir });
  assert.deepEqual(fs.readdirSync(dir), ['cc_abc.sh']);
  assert.match(fs.readFileSync(path.join(dir, 'cc_abc.sh'), 'utf8'), /^claude --resume/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('writing prunes scripts left behind by panes that never started, but never a fresh one', () => {
  const dir = tmpDir();
  fs.mkdirSync(dir, { recursive: true });
  const stale = path.join(dir, 'cc_old.sh');
  fs.writeFileSync(stale, 'old');
  const recent = path.join(dir, 'cc_recent.sh');
  fs.writeFileSync(recent, 'recent');
  const now = Date.now();
  fs.utimesSync(stale, now / 1000, (now - 3 * 60 * 60 * 1000) / 1000);
  paneCommand('cc_new', `claude -- '${'a'.repeat(40_000)}'`, { dir, now });
  assert.equal(fs.existsSync(stale), false);
  assert.equal(fs.existsSync(recent), true); // could still be a booting pane's script
  assert.equal(fs.existsSync(path.join(dir, 'cc_new.sh')), true);
  fs.rmSync(dir, { recursive: true, force: true });
});
