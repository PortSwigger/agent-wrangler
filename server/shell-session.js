import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmuxSocketArgs } from './tmux-socket.js';
import { sendKeys } from './tmux-scraper.js';

const exec = promisify(execFile);

// Create a detached plain-shell tmux session under the given socket, optionally
// pre-populating the prompt with `command` (no Enter — the user decides when to run).
// Returns the tmux session name (`sh_<hex4>`).
export async function createShellSession(cwd, socket, tmuxBin, command = '') {
  const name = `sh_${crypto.randomBytes(2).toString('hex')}`;
  const tmux = (args) => exec(tmuxBin, [...tmuxSocketArgs(socket), ...args]);

  await tmux(['new-session', '-d', '-s', name, '-c', cwd]);
  await tmux(['set-option', '-t', name, 'status', 'off']).catch(() => {});
  // Mouse on so the wheel scrolls tmux copy-mode (the pane's scrollback) instead
  // of xterm translating it to arrow keys, which the shell reads as command-history
  // navigation. Same rationale as the agent terminal (see session-manager `_newSession`).
  await tmux(['set-option', '-t', name, 'mouse', 'on']).catch(() => {});
  // Force set-clipboard on so a drag → copy-mode copy emits the OSC 52 the browser's
  // ClipboardAddon needs (a shell never grabs the mouse, so every drag hits copy-mode).
  await tmux(['set-option', '-t', name, 'set-clipboard', 'on']).catch(() => {});

  if (command) {
    await new Promise((r) => setTimeout(r, 150));
    await sendKeys(name, ['-l', command], socket);
  }

  return name;
}
