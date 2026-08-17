import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import pty from 'node-pty';

const exec = promisify(execFile);

// Wide enough that a ~30-char marker can never wrap onto a second line — a wrap
// inserts a real newline into capture-pane's output, which would break a plain
// `includes(marker)` check for a reason that looks like tmux is broken.
const COLS = 200;
const ROWS = 50;

// capture-pane runs asynchronously with respect to paste-buffer — the pane's
// shell still has to read + echo the pasted bytes before they show up. Poll
// instead of asserting on the first read; this still exits the moment the
// marker appears, so the test stays fast on a warm machine.
async function waitForMarkerInPane(tmuxArgs, session, marker, deadlineMs = 5000) {
  const start = Date.now();
  for (;;) {
    const { stdout } = await exec('tmux', tmuxArgs('capture-pane', '-p', '-t', session));
    if (stdout.includes(marker)) return stdout;
    if (Date.now() - start > deadlineMs) {
      throw new Error(`marker never appeared in pane within ${deadlineMs}ms; last capture:\n${stdout}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

// A real (unmocked) tmux + node-pty round trip — everything else in this repo's
// suite mocks tmux, so this is the only test that would catch tmux itself being
// absent/broken, or node-pty failing to spawn against it, on a given platform.
// Runs on a test-scoped socket so it can never collide with (or leak into) a real
// wrangler instance's sessions.
test('tmux + node-pty: paste-buffer lands in the pane, and a real pty attach observes it', async () => {
  const socket = `aw-smoke-${crypto.randomBytes(4).toString('hex')}`;
  const session = 'smoke';
  const tmuxArgs = (...a) => ['-L', socket, ...a];
  let term;

  try {
    await exec('tmux', tmuxArgs('new-session', '-d', '-s', session, '-x', String(COLS), '-y', String(ROWS)));
    // Panes are killed outright by default; remain-on-exit keeps a failed pane
    // around instead so its output stays inspectable (see CLAUDE.md). `-w`
    // targets it explicitly as the window option it is, rather than relying on
    // set-option's option-table inference to agree across tmux versions.
    await exec('tmux', tmuxArgs('set-option', '-w', '-t', session, 'remain-on-exit', 'on'));

    // load-buffer + paste-buffer is the atomic paste primitive tmux-scraper.js's
    // prefillPane/sendText depend on — send-keys is deliberately NOT used because
    // embedded newlines in a send-keys string get parsed as separate Enter presses.
    const marker = `aw-smoke-marker-${crypto.randomBytes(4).toString('hex')}`;
    const tmpFile = path.join(os.tmpdir(), `${marker}.txt`);
    fs.writeFileSync(tmpFile, marker);
    try {
      await exec('tmux', tmuxArgs('load-buffer', '-b', marker, tmpFile));
      await exec('tmux', tmuxArgs('paste-buffer', '-b', marker, '-t', session));
      await exec('tmux', tmuxArgs('delete-buffer', '-b', marker));
    } finally {
      fs.unlinkSync(tmpFile);
    }

    await waitForMarkerInPane(tmuxArgs, session, marker);

    // node-pty attaching to the same session is exactly what pty-channel.js does
    // for a real browser client — confirm that round trip observes the same pane.
    const seen = await new Promise((resolve, reject) => {
      let buf = '';
      term = pty.spawn('tmux', tmuxArgs('attach', '-t', session), {
        name: 'xterm-256color',
        cols: COLS,
        rows: ROWS,
        cwd: process.cwd(),
        env: process.env,
      });
      const timer = setTimeout(() => reject(new Error('timed out waiting for node-pty attach output')), 5000);
      term.onData((d) => {
        buf += d;
        if (buf.includes(marker)) {
          clearTimeout(timer);
          resolve(buf);
        }
      });
      term.onExit(() => {
        clearTimeout(timer);
        resolve(buf);
      });
    });
    assert.ok(seen.includes(marker), 'node-pty attach observed the pasted content');
  } finally {
    try { term?.kill(); } catch { /* already gone */ }
    await exec('tmux', tmuxArgs('kill-session', '-t', session)).catch(() => {});
  }
});
