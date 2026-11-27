import path from 'node:path';
import { DATA_DIR } from './data-dir.js';
import { writeJsonAtomic, readJsonOrLoud } from './atomic-json.js';
import { logWarn } from './log.js';

// The size a new agent pane starts at: the size a board terminal last reported.
// A detached tmux session otherwise starts at 80x24, and an agent that writes a
// long reply before anyone opens its Terminal renders it at 80 columns, most of
// it scrolled into tmux history. When the board's terminal attaches wider,
// Claude Code redraws the reply at the new width but cannot erase the history,
// so the 80-column copy stays directly above the redraw.

// Before any board terminal has reported: roughly a board Terminal panel.
export const DEFAULT_PANE_SIZE = Object.freeze({ cols: 160, rows: 48 });

// tmux caps a window at 10000 in either direction. Below the floor is a fit
// taken while a panel was hidden or still laying out, not a terminal anyone reads.
const MAX = 10000;
const MIN_COLS = 20;
const MIN_ROWS = 5;

// A reported size worth starting a pane at, or null.
export function paneSizeOf(cols, rows) {
  const c = Number(cols), r = Number(rows);
  if (!Number.isInteger(c) || !Number.isInteger(r) || c < MIN_COLS || r < MIN_ROWS) return null;
  return { cols: Math.min(c, MAX), rows: Math.min(r, MAX) };
}

export const PANE_SIZE_FILE = path.join(DATA_DIR, 'pane-size.json');

// Remembers the last size, kept across restarts in `file`. A drag reports a
// size per frame, so the write waits until the size has settled for `delayMs`.
export class PaneSizeMemory {
  constructor({ file = PANE_SIZE_FILE, delayMs = 1000 } = {}) {
    this.file = file;
    this.delayMs = delayMs;
    this.size = null;
    this.loaded = false;
    this.timer = null;
  }

  get() {
    if (!this.loaded) {
      this.loaded = true;
      const saved = readJsonOrLoud(this.file, 'pane-size.json');
      this.size ??= saved ? paneSizeOf(saved.cols, saved.rows) : null;
    }
    return this.size || DEFAULT_PANE_SIZE;
  }

  note(cols, rows) {
    const size = paneSizeOf(cols, rows);
    if (!size || (size.cols === this.size?.cols && size.rows === this.size?.rows)) return;
    this.size = size;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), this.delayMs);
    this.timer.unref?.();
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    if (!this.size) return;
    try {
      writeJsonAtomic(this.file, this.size);
    } catch (err) {
      logWarn(`[pane-size] could not save ${this.file}: ${err.message}`);
    }
  }
}
