import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Both panes run tmux with `mouse on` (server/session-manager.js `_newSession`,
// server/shell-session.js), which puts the pane in mouse-reporting mode — so xterm
// forwards a click-drag to the pty instead of selecting locally, and an app that
// grabs the mouse (Claude's TUI does) swallows it. xterm's ONLY escape hatch is
// SelectionService.shouldForceSelection:
//
//   isMac ? e.altKey && rawOptions.macOptionClickForcesSelection : e.shiftKey
//
// On macOS shiftKey is never consulted, so Shift-drag cannot work there no matter
// what — Option-drag is the whole hatch, and it stays shut while the option is at
// its `false` default. That shipped: highlight-and-copy was dead in every pane on
// macOS while the code comments promised "Option/Shift-drag also does a native
// xterm.js selection". app.js can't be imported under node:test (xterm, WebSocket
// and the live DOM at import — see module-syntax.test.js), so this guards the
// source text instead.
const APP_JS = join(dirname(fileURLToPath(import.meta.url)), 'app.js');

// Brace-match from `new Terminal({` so a nested object in the options (theme,
// linkHandler) can't end the block early and hide a missing option.
function terminalOptionBlocks(src) {
  const blocks = [];
  const needle = 'new Terminal({';
  for (let i = src.indexOf(needle); i !== -1; i = src.indexOf(needle, i + 1)) {
    let depth = 0;
    const start = i + needle.length - 1;
    for (let j = start; j < src.length; j++) {
      if (src[j] === '{') depth++;
      else if (src[j] === '}' && --depth === 0) { blocks.push(src.slice(start, j + 1)); break; }
    }
  }
  return blocks;
}

test('every terminal forces selection on Option-drag despite tmux mouse mode', () => {
  const blocks = terminalOptionBlocks(readFileSync(APP_JS, 'utf8'));
  assert.equal(blocks.length, 2, `expected the agent + shell terminals, found ${blocks.length}`);

  const missing = blocks
    .map((b, n) => (/macOptionClickForcesSelection:\s*true/.test(b) ? null : n))
    .filter((n) => n !== null);
  assert.deepEqual(missing, [],
    `new Terminal() block(s) ${missing.join(', ')} omit macOptionClickForcesSelection: true — `
    + 'Option-drag selection, and therefore Cmd+C, is dead on macOS in those panes');
});
